// OpenCode v2: observe only foreground sessions owned by the configured local server.
// The v2 API is authenticated and its active endpoint is process-scoped; old sessions
// in /api/session must never be represented as agents still in the office.
import type { SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

interface Session {
  id: string;
  parentID?: string;
  title?: string;
  time: { created: number };
  location: { directory: string };
}

export interface OpenCodeSourceOptions {
  url: string;
  password: string;
  accounts: AccountsService;
  office: Office;
  pollMs?: number;
  fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function session(value: unknown): Session | undefined {
  const item = record(value);
  const time = record(item?.time);
  const location = record(item?.location);
  if (typeof item?.id !== 'string' || !/^ses_[\w-]+$/.test(item.id) ||
      typeof time?.created !== 'number' || typeof location?.directory !== 'string' ||
      !location.directory.startsWith('/')) return undefined;
  return {
    id: item.id,
    time: { created: time.created },
    location: { directory: location.directory },
    ...(typeof item.parentID === 'string' ? { parentID: item.parentID } : {}),
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
  };
}

/** Só sessões cuja cadeia inteira de pais está ativa, na ordem pai → filho. */
function connectedSessions(sessions: readonly Session[]): Session[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const valid = new Map<string, boolean>();
  const ordered: Session[] = [];
  const visit = (id: string): boolean => {
    if (valid.has(id)) return valid.get(id)!;
    const s = byId.get(id);
    if (!s || visiting.has(id)) return false;
    visiting.add(id);
    const connected = !s.parentID || visit(s.parentID);
    visiting.delete(id);
    valid.set(id, connected);
    if (connected) ordered.push(s);
    return connected;
  };
  for (const s of sessions) visit(s.id);
  return ordered;
}

export class OpenCodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private readonly account: string;
  private readonly request: typeof fetch;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seen = new Set<string>();
  private busy = false;
  private stopped = false;
  private error?: string;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.request = opts.fetch ?? fetch;
    this.pollMs = opts.pollMs ?? 2_000;
    this.account = opts.accounts.setProviderAccounts('opencode', [{
      dir: opts.url,
      detected: { id: '.opencode', provider: 'opencode', configDir: opts.url, short: 'O', name: 'OpenCode', color: '#e9a45b' },
    }])[0].id;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.opts.office.beginBoot();
    try {
      await this.poll();
    } finally {
      this.opts.office.endBoot();
    }
    if (this.stopped) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.seen) this.close(id);
    this.seen.clear();
  }

  sources(): SourceInfo[] {
    return [{ label: 'OpenCode', provider: 'opencode', path: this.opts.url, sessions: this.seen.size,
      ok: !this.error, ...(this.error ? { error: this.error } : {}) }];
  }

  transcriptPathOf(): undefined { return undefined; }

  private close(id: string): void {
    const key = `${this.account}:${id}`;
    if (this.opts.office.get(key)?.kind === 'sub') this.opts.office.completeSub(key);
    else this.opts.office.closeMain(key);
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.request(`${this.opts.url}${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${this.opts.password}`).toString('base64')}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'autenticação recusada' : `HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('resposta não é JSON');
    return response.json();
  }

  /** A falha fecha a presença antiga: não mostra como ativo quem já saiu ou perdeu conexão. */
  async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const active = record(record(await this.get('/api/session/active'))?.data);
      if (!active) throw new Error('formato de sessões ativas inválido');
      const ids = Object.keys(active).filter((id) => /^ses_[\w-]+$/.test(id));
      const values = await Promise.all(ids.map((id) => this.get(`/api/session/${encodeURIComponent(id)}`)));
      const sessions = values.map((value) => session(record(value)?.data)).filter((value): value is Session => !!value);
      const connected = connectedSessions(sessions);
      const pending = new Map(await Promise.all(connected.map(async (s): Promise<[string, boolean]> => {
        const result = record(await this.get(`/api/session/${encodeURIComponent(s.id)}/permission`));
        if (!Array.isArray(result?.data)) throw new Error('formato de permissões pendentes inválido');
        return [s.id, result.data.length > 0];
      })));
      if (this.stopped) return;
      const current = new Set(connected.map((s) => s.id));
      for (const id of this.seen) if (!current.has(id)) this.close(id);
      for (const s of connected) {
        const key = `${this.account}:${s.id}`;
        const parentKey = s.parentID ? `${this.account}:${s.parentID}` : undefined;
        if (parentKey) {
          this.opts.office.addSub({ id: key, parentId: parentKey, sessionId: s.id,
            role: tr('Subagente (OpenCode)'), background: false, startedAt: s.time.created });
          this.opts.office.setStatus(key, pending.get(s.id) ? 'waiting' : 'working',
            pending.get(s.id) ? tr('Permissão pendente no OpenCode') : undefined);
        } else {
          this.opts.office.addMain({ id: key, provider: 'opencode', account: this.account, sessionId: s.id,
            cwd: s.location.directory, role: tr('Agente principal (OpenCode)'), startedAt: s.time.created,
            status: pending.get(s.id) ? 'waiting' : 'working',
            waitingFor: pending.get(s.id) ? tr('Permissão pendente no OpenCode') : undefined });
        }
      }
      this.seen = current;
      this.error = undefined;
    } catch (error) {
      if (this.stopped) return;
      for (const id of this.seen) this.close(id);
      this.seen.clear();
      this.error = error instanceof Error ? error.message : tr('falha ao consultar OpenCode');
    } finally {
      this.busy = false;
    }
  }
}
