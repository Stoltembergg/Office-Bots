import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import type { ModelSelection, PromptInput, SessionConfig, SessionInfo } from '../../shared/agents/contracts';
import type { CatalogStore } from './catalog';
import type { ManagedRuntime } from './runtime';
import type { SessionStore } from './sessions';

export class SessionError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'closed' | 'cancelled' | 'runtime-failed' | 'storage' | 'resume-required') {
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
  finishing?: Promise<void>;
};
type Session = { info: SessionInfo; messages: Map<string, Turn>; turn?: Turn; closing?: Promise<void>; closingRequested?: boolean; detached?: boolean; persistenceFailed?: boolean };
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

/** Durable lifecycle metadata; restored conversations stay detached/read-only.
 * No SDK resume or message replay occurs during initialization.
 * One manager/catalog occupancy owner per app; no runtime routes are exposed.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private initialization?: Promise<void>;
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly creations = new Set<Promise<SessionInfo>>();
  private queue: Turn[] = [];
  private readonly active = new Set<Turn>();
  constructor(private readonly catalog: CatalogStore, private readonly runtime: ManagedRuntime,
    private readonly isAvailable: (selection: ModelSelection) => Promise<boolean>,
    private readonly store: Pick<SessionStore, 'recover' | 'add' | 'setState'>) {}
  /** Call once before reading restored sessions. create() awaits this too.
   * The cached result prevents recovery from modifying live turns on later calls.
   */
  initialize(): Promise<void> {
    this.initialization ??= this.store.recover().then(infos => {
      for (const info of infos) this.sessions.set(info.id, { info, messages: new Map(), detached: true });
    }).catch(() => { throw new SessionError('storage'); });
    return this.initialization;
  }
  private async persist(s: Session, state: SessionInfo['state']): Promise<void> {
    try { await this.store.setState(s.info.id, state); }
    catch { s.persistenceFailed = true; throw new SessionError('storage'); }
  }
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
  create(config: SessionConfig): Promise<SessionInfo> {
    if (this.stopping) return Promise.reject(new SessionError('closed'));
    const operation = this.createSession(config);
    this.creations.add(operation);
    void operation.then(() => this.creations.delete(operation), () => this.creations.delete(operation));
    return operation;
  }
  private assertRunning(): void { if (this.stopping) throw new SessionError('closed'); }
  private async createSession(config: SessionConfig): Promise<SessionInfo> {
    const copy = structuredClone(config);
    await this.initialize();
    this.assertRunning();
    const agent = await this.catalog.requireActiveAgent(copy.agentId);
    const chosen = agent.modelPolicy.mode === 'fixed' ? agent.modelPolicy.selection : copy.selection;
    if (!selection(chosen) || (copy.selection !== undefined && (!selection(copy.selection) || !same(chosen, copy.selection)))) throw new SessionError('invalid');
    await this.available(chosen);
    const project = await this.catalog.getProject(agent.projectId);
    this.assertRunning();
    const id = randomUUID();
    let runtimeSessionId: string;
    try {
      ({ runtimeSessionId } = await this.runtime.create({ id, agentId: agent.id, projectId: project.id,
        cwd: project.cwd, selection: structuredClone(chosen), instructions: agent.instructions }));
    } catch { throw new SessionError(this.stopping ? 'closed' : 'runtime-failed'); }
    if (this.stopping) {
      try { await this.runtime.close(runtimeSessionId); } catch { /* Owned process is stopping. */ }
      throw new SessionError('closed');
    }
    const info: SessionInfo = { id, origin: 'managed-pi', runtimeSessionId, projectId: project.id,
      agentId: agent.id, selection: structuredClone(chosen), state: 'idle' };
    try { await this.store.add(info); }
    catch {
      // No prompt has run. Best-effort disposal; never publish an unindexed session.
      try { await this.runtime.close(runtimeSessionId); } catch { /* Supervisor owns final cleanup. */ }
      throw new SessionError('storage');
    }
    if (this.stopping) {
      try { await this.runtime.close(runtimeSessionId); } catch { /* Owned process is stopping. */ }
      try { await this.store.setState(id, 'closed'); } catch { throw new SessionError('storage'); }
      throw new SessionError('closed');
    }
    this.sessions.set(id, { info, messages: new Map() });
    return structuredClone(info);
  }
  prompt(id: string, input: PromptInput): Promise<void> {
    if (this.stopping) return Promise.reject(new SessionError('closed'));
    let s: Session;
    try { s = this.find(id); } catch (e) { return Promise.reject(e); }
    if (s.closingRequested || s.info.state === 'closed') return Promise.reject(new SessionError('closed'));
    if (s.persistenceFailed) return Promise.reject(new SessionError('storage'));
    if (s.detached) return Promise.reject(new SessionError('resume-required'));
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
    }).then(async () => {
      if (turn.finishing || turn.settled) return;
      await this.persist(s, 'queued');
      if (turn.finishing || turn.settled) return;
      turn.ready = true; this.queue.push(turn); this.pump();
    }).catch(e => this.finish(turn, e instanceof SessionError ? e : new SessionError(turn.cancelled ? 'cancelled' : 'invalid')));
    return promise;
  }
  private pump() {
    if (this.stopping) return;
    while (this.active.size < 2) {
      const i = this.queue.findIndex(t => t.ready && !t.settled && !t.finishing && !t.cancelled && ![...this.active].some(a => a.session.info.agentId === t.session.info.agentId));
      if (i < 0) return;
      const [turn] = this.queue.splice(i, 1);
      this.active.add(turn); turn.session.info.state = 'running';
      void this.run(turn);
    }
  }
  private async run(turn: Turn) {
    let error: Error | undefined;
    try {
      await this.persist(turn.session, 'running');
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
    await this.finish(turn, turn.cancelled ? new SessionError('cancelled') : error);
  }
  private finish(turn: Turn, error?: Error): Promise<void> {
    if (turn.finishing) return turn.finishing;
    // Set the finalization barrier before any await; cancellation must never
    // create a late runtime request once this turn has stopped.
    turn.finishing = Promise.resolve().then(async () => {
      const s = turn.session;
      const state = error && !turn.cancelled ? 'error' : 'idle';
      try { await this.persist(s, state); s.info.state = state; }
      catch { error = new SessionError('storage'); s.info.state = 'interrupted'; }
      turn.settled = true; turn.reserved = false;
      this.active.delete(turn); this.queue = this.queue.filter(t => t !== turn);
      if (s.turn === turn) s.turn = undefined;
      if (error) turn.reject(error); else turn.resolve();
      this.pump();
    });
    return turn.finishing;
  }
  async cancel(id: string): Promise<void> {
    const s = this.find(id), turn = s.turn;
    if (!turn || turn.settled) return;
    if (turn.finishing) return turn.finishing;
    if (turn.cancelled && !turn.cancellationFailed) return turn.cancellation;
    turn.cancellationFailed = false;
    turn.cancelled = true;
    if (!this.active.has(turn)) { await this.finish(turn, new SessionError('cancelled')); return; }
    s.info.state = 'cancelling';
    if (turn.started) {
      // Request cancellation promptly even if disk writes are slow. Both must
      // settle before a slot/session can be reused; Promise.all would reject early.
      turn.cancellation = Promise.allSettled([
        this.persist(s, 'cancelling'),
        Promise.resolve().then(() => this.runtime.cancel(s.info.runtimeSessionId)),
      ]).then(results => {
        if (results.some(r => r.status === 'rejected')) {
          turn.cancellationFailed = true;
          throw new SessionError(results[0].status === 'rejected' ? 'storage' : 'runtime-failed');
        }
      });
      await turn.cancellation;
    }
  }
  /** Freeze admission synchronously. The owner must stop the runtime, then await
   * this drain before reporting shutdown; no queued task may dispatch meanwhile.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    const turns = [...this.sessions.values()].flatMap(s => s.turn ? [s.turn] : []);
    for (const turn of turns) if (!this.active.has(turn)) void this.cancel(turn.session.info.id).catch(() => undefined);
    this.shutdownPromise = Promise.allSettled([...this.creations, ...turns.map(t => t.promise), ...[...this.sessions.values()].flatMap(s => s.closing ? [s.closing] : [])]).then(results => {
      // Runtime interruption/cancellation is expected during exit. Failed disk
      // commits are not a clean shutdown and must reach the owning supervisor.
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof SessionError && r.reason.code === 'storage');
      if (failed) throw failed.reason;
    });
    return this.shutdownPromise;
  }
  close(id: string): Promise<void> {
    if (this.stopping) return Promise.reject(new SessionError('closed'));
    const s = this.find(id);
    if (s.closing) return s.closing;
    if (s.info.state === 'closed') return Promise.resolve();
    const turn = s.turn;
    // Set the barrier before the first await; no new prompts may enter.
    s.closingRequested = true;
    const operation = Promise.resolve().then(async () => {
      await this.cancel(id);
      if (turn) await turn.promise.catch(() => undefined);
      try {
        if (!s.detached) {
          await this.runtime.close(s.info.runtimeSessionId);
          // A failed metadata commit must not dispose the same handle twice.
          s.detached = true;
        }
      }
      catch { throw new SessionError('runtime-failed'); }
      await this.persist(s, 'closed');
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
