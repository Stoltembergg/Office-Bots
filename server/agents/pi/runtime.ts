import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventData, PromptInput } from '../../../shared/agents/contracts';
import { exactKeys, isAgentEvent, nonempty, record } from '../../../shared/agents/validation';
import type { ManagedRuntime, RuntimeSessionConfig } from '../runtime';
import { SessionError } from '../manager';
import { codes, isCommand, type Command, type WorkerCode } from './protocol';

type Pending = { runtimeSessionId?: string; resolve: (result: unknown) => void; reject: (error: Error) => void; type: Command['type']; sessionId?: string };
/** Trusted host API, never exposed directly over HTTP/renderer. The entry is an
 * app-owned built file. Death rejects pending work only after process exit;
 * this runtime never restarts or replays a request automatically.
 */
export class PiRuntime implements ManagedRuntime {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly sessions = new Map<string, { id: string; seq: number; runId?: string; terminal?: boolean }>();
  private readonly exited: Promise<void>;
  private dead = false;
  private stopping = false;
  private ready: Promise<void>;
  constructor(options: { entry: string; directory: string; execPath?: string }) {
    // No ambient provider credentials, NODE_OPTIONS, loaders or CLI auth config.
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    this.child = fork(options.entry, [options.directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', env, execArgv: [], execPath: options.execPath ?? process.execPath });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
    void this.ready.catch(() => undefined);
    this.exited = new Promise<void>(resolve => {
      this.child.once('exit', () => {
        this.dead = true; this.failActiveRuns(); const error = new SessionError('runtime-failed');
        readyReject(error); for (const p of this.pending.values()) p.reject(error);
        this.pending.clear(); resolve();
      });
      this.child.once('error', () => {
        // A failed spawn has no running child. Otherwise wait for actual exit.
        if (!this.child.pid) { this.dead = true; readyReject(new SessionError('runtime-failed')); resolve(); }
        else this.child.kill('SIGKILL');
      });
    });
    this.child.on('disconnect', () => { if (!this.dead) this.child.kill('SIGKILL'); });
    let ready = false;
    this.child.on('message', message => {
      if (record(message) && exactKeys(message, ['version', 'type']) && message.version === 1 && message.type === 'ready' && !ready) {
        ready = true; readyResolve(); return;
      }
      if (record(message) && exactKeys(message, ['version', 'event']) && message.version === 1 && isAgentEvent(message.event)) {
        const event = message.event;
        const session = [...this.sessions.values()].find(s => s.id === event.sessionId);
        if (!session || session.runId !== event.runId || event.seq !== session.seq + 1) { this.child.kill('SIGKILL'); return; }
        if ((session.terminal && event.type !== 'state') || (event.type === 'message-end' && session.terminal)) { this.child.kill('SIGKILL'); return; }
        session.seq = event.seq;
        if (event.type === 'message-end') session.terminal = true;
        this.publish(event); return;
      }
      if (record(message) && exactKeys(message, ['version', 'id', 'ok', 'result', 'code']) && message.version === 1 && nonempty(message.id)) {
        const pending = this.pending.get(message.id);
        if (pending && ((message.ok === false && codes.includes(message.code as WorkerCode)) || message.ok === true)) {
          if (message.ok === true && pending.type === 'create'
            && (!record(message.result) || !exactKeys(message.result, ['runtimeSessionId']) || !nonempty(message.result.runtimeSessionId)
              || this.sessions.has(message.result.runtimeSessionId))) { this.child.kill('SIGKILL'); return; }
          if (message.ok === true && pending.type === 'prompt' && !this.sessions.get(pending.runtimeSessionId!)?.terminal) { this.child.kill('SIGKILL'); return; }
          this.pending.delete(message.id);
          if (message.ok === false) pending.reject(new SessionError(message.code as WorkerCode));
          else if (pending.type === 'create') {
            const result = message.result as { runtimeSessionId: string };
            this.sessions.set(result.runtimeSessionId, { id: pending.sessionId!, seq: 0 }); pending.resolve(result);
          } else pending.resolve(undefined);
          return;
        }
      }
      this.child.kill('SIGKILL');
    });
  }
  async initialize(): Promise<void> {
    if (this.dead || this.stopping) throw new SessionError('runtime-failed');
    await this.ready;
    if (this.dead || this.stopping) throw new SessionError('runtime-failed');
  }
  private publish(event: AgentEvent): void {
    for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Presentation cannot interrupt execution. */ } }
  }
  private failActiveRuns(): void {
    for (const session of this.sessions.values()) if (session.runId && !session.terminal) {
      const emit = (data: AgentEventData) => this.publish({ schemaVersion: 1, origin: 'managed-pi', sessionId: session.id,
        runId: session.runId!, seq: ++session.seq, at: new Date().toISOString(), ...data } as AgentEvent);
      emit({ type: 'error', payload: { code: 'runtime-failed' } });
      emit({ type: 'message-end', payload: { outcome: 'error' } });
      emit({ type: 'state', payload: { state: 'error' } }); session.terminal = true;
    }
  }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async request(command: Omit<Command, 'version' | 'id'> | Record<string, unknown>): Promise<unknown> {
    const payload = { ...structuredClone(command), version: 1, id: randomUUID() };
    if (!isCommand(payload)) throw new SessionError('invalid');
    if (this.dead || this.stopping) throw new SessionError('runtime-failed');
    await this.ready;
    if (this.dead || this.stopping) throw new SessionError('runtime-failed');
    return new Promise((resolve, reject) => {
      this.pending.set(payload.id, { resolve, reject, type: payload.type, runtimeSessionId: payload.type === 'create' ? undefined : payload.runtimeSessionId, sessionId: payload.type === 'create' ? payload.config.id : undefined });
      this.child.send(payload, error => { if (error) this.child.kill('SIGKILL'); });
    });
  }
  async create(config: RuntimeSessionConfig): Promise<{ runtimeSessionId: string }> { return await this.request({ type: 'create', config }) as { runtimeSessionId: string }; }
  async prompt(runtimeSessionId: string, input: PromptInput): Promise<void> {
    const s = this.sessions.get(runtimeSessionId);
    if (!s) throw new SessionError('invalid');
    if (s.runId) throw new SessionError('busy');
    const runId = randomUUID(); s.runId = runId; s.terminal = false;
    try { await this.request({ type: 'prompt', runtimeSessionId, input, runId }); }
    finally { if (s.runId === runId) s.runId = undefined; }
  }
  async cancel(runtimeSessionId: string): Promise<void> { await this.request({ type: 'cancel', runtimeSessionId }); }
  async close(runtimeSessionId: string): Promise<void> { await this.request({ type: 'close', runtimeSessionId }); this.sessions.delete(runtimeSessionId); }
  async stop(): Promise<void> { this.stopping = true; if (!this.dead) this.child.kill('SIGKILL'); await this.exited; }
}
