import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionInfo, SessionState } from '../../shared/agents/contracts';
import { tr } from '../../shared/i18n';
import type { CatalogStore } from './catalog';

type Index = { schemaVersion: 1; sessions: SessionInfo[] };
export class SessionIndexError extends Error {
  constructor(readonly code: 'invalid' | 'reference' | 'corrupt' | 'unsupported-version' | 'locked' | 'storage') {
    super(tr('pedido inválido'));
    this.name = 'SessionIndexError';
  }
}
const states: readonly SessionState[] = ['idle', 'queued', 'running', 'cancelling', 'error', 'closed', 'interrupted'];
const unfinished: readonly SessionState[] = ['queued', 'running', 'cancelling'];
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
function object(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function keys(x: Record<string, unknown>, allowed: readonly string[]) { return Object.keys(x).every(k => allowed.includes(k)); }
function session(x: unknown): x is SessionInfo {
  if (!object(x) || !keys(x, ['id', 'origin', 'runtimeSessionId', 'projectId', 'agentId', 'selection', 'state'])) return false;
  const s = x.selection;
  return text(x.id) && x.origin === 'managed-pi' && text(x.runtimeSessionId) && text(x.projectId) && text(x.agentId)
    && states.includes(x.state as SessionState) && object(s) && keys(s, ['providerId', 'accountId', 'modelId', 'thinkingLevel'])
    && text(s.providerId) && text(s.accountId) && text(s.modelId) && (s.thinkingLevel === undefined || text(s.thinkingLevel));
}
function valid(x: unknown): x is Index {
  return object(x) && keys(x, ['schemaVersion', 'sessions']) && x.schemaVersion === 1 && Array.isArray(x.sessions)
    && x.sessions.every(session) && new Set(x.sessions.map(s => s.id)).size === x.sessions.length
    && new Set(x.sessions.map(s => s.runtimeSessionId)).size === x.sessions.length;
}
const failure = (code: ConstructorParameters<typeof SessionIndexError>[0]) => new SessionIndexError(code);

/** Durable metadata only; SDK owns transcripts/context and validates its reference
 * on explicit resume. No prompts, credentials or filesystem paths in this index.
 * Share one store in the single desktop instance. recover() is startup-only,
 * before live sessions exist; it never creates runtime sessions or replays turns.
 * Lock collisions (including stale locks) need explicit operator resolution.
 */
export class SessionStore {
  private readonly file: string;
  private readonly lock: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly catalog: CatalogStore) {
    this.file = path.join(directory, 'sessions.json');
    this.lock = path.join(directory, 'sessions.lock');
  }
  private async references(data: Index): Promise<void> {
    for (const s of data.sessions) {
      try {
        const agent = await this.catalog.getAgent(s.agentId);
        await this.catalog.getProject(s.projectId);
        if (agent.projectId !== s.projectId) throw failure('reference');
      } catch { throw failure('reference'); }
    }
  }
  private async read(): Promise<Index> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, sessions: [] };
      throw failure('storage');
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { /* Quarantine below. */ }
    if (object(data) && typeof data.schemaVersion === 'number' && data.schemaVersion !== 1) throw failure('unsupported-version');
    if (!valid(data)) {
      // Keep the original too: subsequent reads/writes must stay blocked until
      // an explicit repair. Never turn corruption into an empty fresh index.
      try { await copyFile(this.file, `${this.file}.${randomUUID()}.corrupt`, constants.COPYFILE_EXCL); }
      catch { throw failure('storage'); }
      throw failure('corrupt');
    }
    await this.references(data);
    return data;
  }
  private mutate<T>(change: (data: Index) => T | Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      try { await mkdir(this.directory, { recursive: true }); } catch { throw failure('storage'); }
      try { await mkdir(this.lock); }
      catch (e) { throw failure((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'locked' : 'storage'); }
      const temporary = path.join(this.directory, `sessions-${randomUUID()}.tmp`);
      try {
        const data = await this.read();
        const result = await change(data);
        if (!valid(data)) throw failure('invalid');
        await this.references(data);
        await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
        return structuredClone(result);
      } catch (e) { throw e instanceof SessionIndexError ? e : failure('storage'); }
      finally {
        try { await rm(temporary, { force: true }); }
        finally { await rm(this.lock, { recursive: true }); }
      }
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
  async list(projectId?: string): Promise<SessionInfo[]> {
    return (await this.read()).sessions.filter(s => projectId === undefined || s.projectId === projectId);
  }
  async get(id: string): Promise<SessionInfo> {
    const result = (await this.read()).sessions.find(s => s.id === id);
    if (!result) throw failure('invalid'); return result;
  }
  add(info: SessionInfo): Promise<SessionInfo> {
    const copy = structuredClone(info);
    return this.mutate(data => {
      if (!session(copy) || copy.state !== 'idle' || data.sessions.some(s => s.id === copy.id || s.runtimeSessionId === copy.runtimeSessionId)) throw failure('invalid');
      data.sessions.push(copy); return copy;
    });
  }
  /** State only: conversation ownership and model selection are immutable. */
  setState(id: string, state: SessionState): Promise<void> {
    return this.mutate(data => {
      const found = data.sessions.find(s => s.id === id);
      if (!found || !states.includes(state)) throw failure('invalid');
      found.state = state;
    });
  }
  recover(): Promise<SessionInfo[]> {
    return this.mutate(data => {
      for (const s of data.sessions) if (unfinished.includes(s.state)) s.state = 'interrupted';
      return data.sessions;
    });
  }
}
