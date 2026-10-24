import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import type { ModelSelection, PromptInput, SessionConfig, SessionInfo } from '../../shared/agents/contracts';
import type { CatalogStore } from './catalog';
import type { ManagedRuntime } from './runtime';

export class SessionError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'closed' | 'cancelled' | 'runtime-failed') {
    super(tr('pedido inválido'));
    this.name = 'SessionError';
  }
}
type Turn = {
  input: PromptInput;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
  session: Session;
  ready: boolean;
  reserved: boolean;
  started: boolean;
  cancelled: boolean;
  cancellation?: Promise<void>;
  cancellationFailed?: boolean;
  settled: boolean;
};
type Session = { info: SessionInfo; messages: Map<string, Turn>; turn?: Turn; closing?: Promise<void>; closingRequested?: boolean };
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
function selection(x: unknown): x is ModelSelection {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return Object.keys(s).every(k => ['providerId', 'accountId', 'modelId', 'thinkingLevel'].includes(k))
    && nonempty(s.providerId) && nonempty(s.accountId) && nonempty(s.modelId)
    && (s.thinkingLevel === undefined || nonempty(s.thinkingLevel));
}
function same(a: ModelSelection, b: ModelSelection) {
  return a.providerId === b.providerId && a.accountId === b.accountId && a.modelId === b.modelId && a.thinkingLevel === b.thinkingLevel;
}

/** Process-local scheduling only. No durable session index or retry on restart.
 * One manager/catalog occupancy owner per app; no runtime routes are exposed.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private queue: Turn[] = [];
  private readonly active = new Set<Turn>();
  constructor(private readonly catalog: CatalogStore, private readonly runtime: ManagedRuntime,
    private readonly isAvailable: (selection: ModelSelection) => Promise<boolean>) {}
  isAgentBusy(agentId: string): boolean {
    return [...this.sessions.values()].some(s => s.info.agentId === agentId && s.turn?.reserved && !s.turn.settled);
  }
  list(projectId?: string): SessionInfo[] {
    return [...this.sessions.values()].filter(s => projectId === undefined || s.info.projectId === projectId).map(s => structuredClone(s.info));
  }
  get(id: string): SessionInfo { return structuredClone(this.find(id).info); }
  private find(id: string): Session {
    const s = this.sessions.get(id); if (!s) throw new SessionError('invalid'); return s;
  }
  private async available(chosen: ModelSelection) {
    try { if (await this.isAvailable(structuredClone(chosen))) return; } catch { /* Fail closed. */ }
    throw new SessionError('unavailable');
  }
  async create(config: SessionConfig): Promise<SessionInfo> {
    const copy = structuredClone(config);
    const agent = await this.catalog.requireActiveAgent(copy.agentId);
    const chosen = agent.modelPolicy.mode === 'fixed' ? agent.modelPolicy.selection : copy.selection;
    if (!selection(chosen) || (copy.selection !== undefined && (!selection(copy.selection) || !same(chosen, copy.selection)))) throw new SessionError('invalid');
    await this.available(chosen);
    const project = await this.catalog.getProject(agent.projectId);
    const id = randomUUID();
    let runtimeSessionId: string;
    try {
      ({ runtimeSessionId } = await this.runtime.create({ id, agentId: agent.id, projectId: project.id,
        cwd: project.cwd, selection: structuredClone(chosen), instructions: agent.instructions }));
    } catch { throw new SessionError('runtime-failed'); }
    const info: SessionInfo = { id, origin: 'managed-pi', runtimeSessionId, projectId: project.id,
      agentId: agent.id, selection: structuredClone(chosen), state: 'idle' };
    this.sessions.set(id, { info, messages: new Map() });
    return structuredClone(info);
  }
  prompt(id: string, input: PromptInput): Promise<void> {
    let s: Session;
    try { s = this.find(id); } catch (e) { return Promise.reject(e); }
    if (s.closingRequested || s.info.state === 'closed') return Promise.reject(new SessionError('closed'));
    if (!input || !nonempty(input.messageId) || !nonempty(input.text)) return Promise.reject(new SessionError('invalid'));
    const old = s.messages.get(input.messageId);
    if (old) return old.input.text === input.text ? old.promise : Promise.reject(new SessionError('invalid'));
    if (s.turn) return Promise.reject(new SessionError('busy'));
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const turn: Turn = { input: structuredClone(input), session: s, promise, resolve, reject,
      ready: false, reserved: false, started: false, cancelled: false, settled: false };
    s.messages.set(input.messageId, turn); s.turn = turn;
    // Enqueue admission synchronously so catalog edits observe the same order.
    void this.catalog.admitAgent(s.info.agentId, () => {
      if (turn.cancelled) throw new SessionError('cancelled');
      turn.reserved = true; s.info.state = 'queued';
    }).then(() => {
      if (turn.settled) return;
      turn.ready = true; this.queue.push(turn); this.pump();
    }, () => this.finish(turn, new SessionError(turn.cancelled ? 'cancelled' : 'invalid')));
    return promise;
  }
  private pump() {
    while (this.active.size < 2) {
      const i = this.queue.findIndex(t => t.ready && !t.settled && ![...this.active].some(a => a.session.info.agentId === t.session.info.agentId));
      if (i < 0) return;
      const [turn] = this.queue.splice(i, 1);
      this.active.add(turn); turn.session.info.state = 'running';
      void this.run(turn);
    }
  }
  private async run(turn: Turn) {
    let error: Error | undefined;
    try {
      await this.available(turn.session.info.selection);
      if (turn.cancelled) throw new SessionError('cancelled');
      turn.started = true;
      await this.runtime.prompt(turn.session.info.runtimeSessionId, structuredClone(turn.input));
    } catch (e) { error = e instanceof SessionError ? e : new SessionError('runtime-failed'); }
    // A delayed cancel must never reach the next turn on this runtime session.
    let cancellation: Promise<void> | undefined;
    do {
      cancellation = turn.cancellation;
      if (cancellation) await cancellation.catch(() => undefined);
    } while (cancellation !== turn.cancellation);
    this.finish(turn, turn.cancelled ? new SessionError('cancelled') : error);
  }
  private finish(turn: Turn, error?: Error) {
    if (turn.settled) return;
    turn.settled = true; turn.reserved = false;
    this.active.delete(turn); this.queue = this.queue.filter(t => t !== turn);
    const s = turn.session;
    if (s.turn === turn) s.turn = undefined;
    s.info.state = error && !turn.cancelled ? 'error' : 'idle';
    if (error) turn.reject(error); else turn.resolve();
    this.pump();
  }
  async cancel(id: string): Promise<void> {
    const s = this.find(id), turn = s.turn;
    if (!turn || turn.settled) return;
    if (turn.cancelled && !turn.cancellationFailed) return turn.cancellation;
    turn.cancellationFailed = false;
    turn.cancelled = true;
    if (!this.active.has(turn)) { this.finish(turn, new SessionError('cancelled')); return; }
    s.info.state = 'cancelling';
    if (turn.started) {
      turn.cancellation = Promise.resolve().then(() => this.runtime.cancel(s.info.runtimeSessionId))
        .catch(() => { turn.cancellationFailed = true; throw new SessionError('runtime-failed'); });
      await turn.cancellation;
    }
  }
  close(id: string): Promise<void> {
    const s = this.find(id);
    if (s.closing) return s.closing;
    if (s.info.state === 'closed') return Promise.resolve();
    const turn = s.turn;
    // Set the barrier before the first await; no new prompts may enter.
    s.closingRequested = true;
    const operation = Promise.resolve().then(async () => {
      await this.cancel(id);
      if (turn) await turn.promise.catch(() => undefined);
      try { await this.runtime.close(s.info.runtimeSessionId); }
      catch { throw new SessionError('runtime-failed'); }
      s.info.state = 'closed';
    });
    s.closing = operation;
    void operation.catch(() => {
      if (s.closing === operation) s.closing = undefined;
      if (!s.turn) s.info.state = 'error';
    });
    return operation;
  }
}
