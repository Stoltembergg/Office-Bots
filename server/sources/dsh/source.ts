// Fonte de agentes do DeepSeek Harness (AgentSource 'dsh', ver sources/source.ts): o aplicativo grava cada sessão
// em ~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd (frames zstd, um por evento; ver sources/dsh/log.ts).
//
// Presença (o DSH não grava um registro de sessões abertas nem lock): sessão com escrita recente (mtime ≤
// PRESENCE_MS) é considerada aberta; parada há mais tempo, é dada como encerrada (e reabre se voltar a gravar).
// Status: por bordas dos eventos (turn/start → working, turn/end → idle, approval/asked sem decided → waiting) e,
// sem evento novo por ACTIVITY_QUIET_MS, o turno em andamento acalma para idle. Subagentes são sessões com
// `parentSession`/`origin: "subagent"`: entram como subagentes do pai (quando ele está no escritório).
// Boot síncrono e curto, com endBoot em `finally`.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { pushTokenSample, tokenUsage, type TokenSample } from '../../accounts/usage';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectDshAccounts } from './accounts';
import { DshLogReader, dshHeader, listDshSessions, type DshEvent, type DshSessionHeader } from './log';
import { createDshTerminalParser } from './terminal';

/** Sem escrita por este tempo, a sessão é dada como encerrada (reabre ao primeiro byte novo). */
export const PRESENCE_MS = 30 * 60_000;
/** Turno ativo sem nenhum evento novo por este tempo: o personagem acalma para ocioso (o escritório espera). */
export const ACTIVITY_QUIET_MS = 90_000;
const MAIN_ROLE = 'Agente principal (DeepSeek)';
const SUB_ROLE = 'Subagente (DeepSeek)';

export interface DshSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do DSH lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Pasta para os espelhos JSONL decodificados (terminal e histórico); <dataDir>/transcripts/dsh por padrão. */
  mirrorDir?: string;
}

interface DshAccount {
  id: string;
  dir: string;
  configDir: string;
  error?: string;
  /** Amostras de tokens (com o instante do evento) para o uso da conta. */
  usageSamples: TokenSample[];
}

interface DshTracker {
  key: string;
  acc: DshAccount;
  sessionId: string;
  path: string;
  reader: DshLogReader;
  header?: DshSessionHeader;
  kind: 'main' | 'sub';
  title?: string;
  model?: string;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  startedAt: number;
  lastEventAt: number;
  lastWriteAt: number;
  turnActive: boolean;
  waitingApproval: boolean;
  status: AgentStatus;
  inOffice: boolean;
  /** Já tentou entrar como sub sem o pai presente: tenta de novo quando o pai aparecer. */
  pendingParent: boolean;
}

interface ActivityDesc {
  kind: string;
  icon: string;
  text: string;
  detail?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const FILE_TOOLS = new Set(['read', 'write', 'edit']);
const SEARCH_TOOLS = new Set(['glob', 'grep']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
const SHELL_TOOLS = new Set(['pwsh', 'sh', 'exec', 'run_command', 'shell']);

/** Ferramenta do DSH → atividade do escritório (textos mascarados e cortados). */
export function describeDshTool(name: string, args: Record<string, unknown>): ActivityDesc {
  const clean = (s: string) => truncate(maskSecrets(s.replace(/\s+/g, ' ').trim()), 46);
  const detail = (s: string) => truncate(maskSecrets(s.replace(/\s+/g, ' ').trim()), 300);
  const path = str(args.file_path) ?? str(args.path);
  if (FILE_TOOLS.has(name)) {
    const file = path ? (path.split(/[/\\]/).pop() ?? path) : 'arquivo';
    const verb = name === 'read' ? 'Lendo' : name === 'write' ? 'Escrevendo' : 'Editando';
    return { kind: name === 'read' ? 'read' : 'edit', icon: name === 'read' ? '📖' : '✏️', text: clean(`${verb} ${file}`), ...(path ? { detail: detail(path) } : {}) };
  }
  if (SHELL_TOOLS.has(name)) {
    const cmd = str(args.command) ?? str(args.cmd) ?? '';
    return { kind: 'run', icon: '💻', text: clean(cmd ? `Rodando ${cmd}` : 'Rodando comando'), ...(cmd ? { detail: detail(cmd) } : {}) };
  }
  if (SEARCH_TOOLS.has(name)) {
    const q = str(args.pattern) ?? str(args.query) ?? '';
    return { kind: 'search', icon: '🔍', text: clean(q ? `Buscando ${q}` : 'Buscando arquivos'), ...(q ? { detail: detail(q) } : {}) };
  }
  if (WEB_TOOLS.has(name)) {
    const q = str(args.query) ?? str(args.url) ?? '';
    return { kind: 'browse', icon: '🌐', text: clean(q ? `Pesquisando ${q}` : 'Navegando'), ...(q ? { detail: detail(q) } : {}) };
  }
  if (name === 'subagent') return { kind: 'delegate', icon: '👥', text: 'Disparando subagente' };
  if (name === 'todo_write') return { kind: 'plan', icon: '🗒️', text: 'Atualizando a lista de tarefas' };
  if (name === 'read_image') return { kind: 'read', icon: '🖼️', text: 'Vendo uma imagem' };
  if (name === 'present') return { kind: 'done', icon: '📤', text: 'Apresentando arquivos' };
  if (name === 'ask_user_question') return { kind: 'ask', icon: '❓', text: 'Perguntando para você' };
  return { kind: 'other', icon: '🔧', text: clean(`Usando ${name}`) };
}

export class DshSource implements AgentSource {
  readonly provider = 'dsh' as const;
  private accs: DshAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private trackers = new Map<string, DshTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: DshSourceOptions) {
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    const used = {
      shorts: [] as string[],
      colors: [] as string[],
    };
    for (const p of ['claude', 'codex'] as const) for (const e of opts.accounts.entriesOf(p)) {
      used.shorts.push(e.detected.short);
      if (e.detected.color) used.colors.push(e.detected.color);
    }
    this.detected = detectDshAccounts(opts.dirs, { env, home: opts.home, taken: used });
    this.register();
  }

  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'dsh',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => prev.get(e.dir) ?? { id: e.id, dir: e.dir, configDir: e.detected.configDir, usageSamples: [] });
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.trackers.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'dsh', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackers.get(agentId);
    if (!t?.inOffice) return undefined;
    return this.mirrorPath(t);
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createDshTerminalParser() : undefined;
  }

  /** Espelho decodificado (JSONL puro) da sessão: o terminal e o histórico leem daqui. */
  private mirrorPath(t: DshTracker): string {
    const dir = this.opts.mirrorDir;
    if (!dir) throw new Error('espelho desligado (sem mirrorDir)');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${encodeURIComponent(t.key)}.jsonl`);
  }

  /** Acrescenta os eventos novos ao espelho da sessão. */
  private mirror(t: DshTracker, events: DshEvent[]): void {
    if (!events.length || !this.opts.mirrorDir) return;
    try {
      appendFileSync(this.mirrorPath(t), events.map((ev) => JSON.stringify(ev.raw)).join('\n') + '\n');
    } catch (err) {
      log.warnOnce(`dsh-mirror:${errMsg(err)}`, `Fonte DeepSeek Harness: não consegui gravar o espelho (${errMsg(err)}).`);
    }
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`dsh-poll:${errMsg(err)}`, `Fonte DeepSeek Harness: falha ao varrer sessões (${errMsg(err)}).`);
    }
  }

  poll(boot = false): void {
    const now = this.now();
    for (const acc of this.accs) {
      let files: ReturnType<typeof listDshSessions>;
      try {
        files = listDshSessions(acc.dir);
        acc.error = undefined;
      } catch (err) {
        acc.error = errMsg(err);
        continue;
      }
      const seen = new Set<string>();
      for (const f of files) {
        // Só sessões com escrita recente podem estar abertas; as antigas ainda não vistas são ignoradas.
        if (now - f.mtimeMs > PRESENCE_MS && !this.trackers.has(`${acc.id}:${f.sessionId}`)) continue;
        seen.add(f.sessionId);
        let t = this.trackers.get(`${acc.id}:${f.sessionId}`);
        if (!t) {
          t = {
            key: `${acc.id}:${f.sessionId}`,
            acc,
            sessionId: f.sessionId,
            path: f.path,
            reader: new DshLogReader(f.path),
            kind: 'main',
            toolCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
            startedAt: now,
            lastEventAt: 0,
            lastWriteAt: 0,
            turnActive: false,
            waitingApproval: false,
            status: 'idle',
            inOffice: false,
            pendingParent: false,
          };
          this.trackers.set(t.key, t);
        }
        this.readTracker(t, f.mtimeMs, boot);
      }
      // Sessões que não escrevem há tempo demais: saem do escritório.
      for (const t of [...this.trackers.values()]) {
        if (t.acc !== acc || !t.inOffice) continue;
        if (now - t.lastWriteAt > PRESENCE_MS) this.close(t);
      }
      this.pushUsage(acc, now);
    }
    this.refreshStatuses(now);
  }

  /** Lê os eventos novos de uma sessão e atualiza o escritório. */
  private readTracker(t: DshTracker, mtimeMs: number, boot: boolean): void {
    const before = t.lastEventAt;
    const r = t.reader.read();
    if (!r.changed) return;
    if (r.mtimeMs) t.lastWriteAt = Math.max(t.lastWriteAt, r.mtimeMs);
    let newActivity: { desc: ActivityDesc; at: number } | undefined;
    for (const ev of r.events) {
      this.applyEvent(t, ev);
      const at = ev.time || r.mtimeMs || this.now();
      if (at > t.lastEventAt) t.lastEventAt = at;
      if (ev.type === 'tool/call') {
        const name = str(ev.data?.name) ?? 'ferramenta';
        const args = rec(ev.data?.arguments) ?? parseArgs(str(ev.data?.arguments));
        newActivity = { desc: describeDshTool(name, args), at };
      } else if (ev.type === 'turn/start') {
        newActivity = { desc: { kind: 'run', icon: '⌨️', text: 'Trabalhando no pedido' }, at };
      } else if (ev.type === 'approval/asked') {
        newActivity = { desc: { kind: 'wait', icon: '🔐', text: 'Pedindo permissão' }, at };
      }
    }
    const first = !t.header; // nunca lido
    this.mirror(t, r.events);
    this.sync(t, boot, first, newActivity);
  }

  private applyEvent(t: DshTracker, ev: DshEvent): void {
    switch (ev.type) {
      case 'session': {
        const h = dshHeader(ev);
        if (h) {
          t.header = h;
          t.startedAt = h.createdAt || t.startedAt;
          t.kind = h.parentSession || h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0 ? 'sub' : 'main';
        }
        break;
      }
      case 'session/title': {
        const title = str(ev.data?.title);
        if (title) t.title = truncate(maskSecrets(title.trim()), 80);
        break;
      }
      case 'model/selection': {
        const m = str(ev.data?.model);
        if (m) t.model = m;
        break;
      }
      case 'turn/start':
        t.turnActive = true;
        break;
      case 'turn/end':
        t.turnActive = false;
        t.waitingApproval = false;
        break;
      case 'approval/asked':
        t.waitingApproval = true;
        break;
      case 'approval/decided':
        t.waitingApproval = false;
        break;
      case 'tool/call':
        t.toolCalls++;
        break;
      case 'assistant/message': {
        // Uso em tokens (o DSH não tem cota do plano): cada resposta traz o uso acumulado
        // da chamada (usage.inputTokens/outputTokens/totalTokens), carimbado com o instante
        // do evento — sessões antigas lidas no boot caem nas janelas certas (5h/7d).
        const u = rec(ev.data?.usage);
        const total = num(u?.totalTokens) ?? (num(u?.inputTokens) ?? 0) + (num(u?.outputTokens) ?? 0);
        if (total > 0) {
          t.tokensIn += num(u?.inputTokens) ?? 0;
          t.tokensOut += num(u?.outputTokens) ?? 0;
          pushTokenSample(t.acc.usageSamples, { at: ev.time || this.now(), tokens: total }, this.now());
        }
        break;
      }
      default:
        break;
    }
  }

  /** Joga o estado acumulado no escritório (entra se aberta, atualiza status/atividade). */
  private sync(t: DshTracker, boot: boolean, first: boolean, newActivity?: { desc: ActivityDesc; at: number }): void {
    if (!t.header?.cwd) return; // sem projeto não há sala
    const office = this.opts.office;
    const status = this.computeStatus(t, this.now());
    if (!t.inOffice) {
      if (t.kind === 'sub') {
        const parentKey = `${t.acc.id}:${t.header.parentSession}`;
        if (!office.has(parentKey)) {
          t.pendingParent = true;
          return;
        }
        t.pendingParent = false;
        const added = office.addSub({
          id: t.key,
          parentId: parentKey,
          sessionId: t.sessionId,
          role: SUB_ROLE,
          ...(t.title ? { title: t.title } : {}),
          background: false,
          startedAt: t.startedAt,
        });
        t.inOffice = added || office.has(t.key);
      } else {
        office.addMain({
          id: t.key,
          provider: 'dsh',
          account: t.acc.id,
          sessionId: t.sessionId,
          cwd: t.header.cwd,
          role: MAIN_ROLE,
          startedAt: t.startedAt,
          status,
          ...(status === 'waiting' ? { waitingFor: 'aprovar uma permissão' } : {}),
        });
        t.inOffice = office.has(t.key);
      }
      if (t.inOffice) {
        office.applyTranscript(t.key, {
          ...(t.title ? { title: t.title } : {}),
          tasks: [],
          stats: { toolCalls: t.toolCalls, tokensIn: t.tokensIn, tokensOut: t.tokensOut, subagents: 0 },
          ...(t.model ? { model: t.model } : {}),
          firstAt: t.header.createdAt,
          lastAt: t.lastEventAt || undefined,
        });
        this.applyActivity(t, newActivity, boot);
        office.setStatus(t.key, status, status === 'waiting' ? 'aprovar uma permissão' : undefined);
      }
      return;
    }
    if (t.pendingParent) return; // sub ainda sem o pai no escritório
    office.applyTranscript(t.key, {
      ...(t.title ? { title: t.title } : {}),
      tasks: [],
      stats: { toolCalls: t.toolCalls, tokensIn: t.tokensIn, tokensOut: t.tokensOut, subagents: 0 },
      ...(t.model ? { model: t.model } : {}),
      ...(t.lastEventAt ? { lastAt: t.lastEventAt } : {}),
    });
    this.applyActivity(t, newActivity, boot);
    office.setStatus(t.key, status, status === 'waiting' ? 'aprovar uma permissão' : undefined);
  }

  private applyActivity(t: DshTracker, act: { desc: ActivityDesc; at: number } | undefined, boot: boolean): void {
    if (!t.inOffice || !act) return;
    const a = act.desc;
    this.opts.office.addActivity(
      t.key,
      {
        id: `${t.key}#dsh:${act.at}:${a.text}`,
        kind: a.kind as never,
        icon: a.icon,
        text: a.text,
        ...(a.detail ? { detail: a.detail } : {}),
        at: act.at,
      },
      true,
      { feed: !boot },
    );
  }

  private computeStatus(t: DshTracker, now: number): AgentStatus {
    if (t.waitingApproval) return 'waiting';
    if (t.turnActive && now - t.lastWriteAt <= ACTIVITY_QUIET_MS) return 'working';
    return 'idle';
  }

  /** Passada final: status derivado do tempo (turno ativo que sossegou; sub cujo pai chegou). */
  private refreshStatuses(now: number): void {
    for (const t of this.trackers.values()) {
      if (!t.inOffice) {
        if (t.pendingParent && t.header?.cwd) this.sync(t, false, false);
        if (t.pendingParent) continue;
      }
      if (!t.inOffice) continue;
      const status = this.computeStatus(t, now);
      if (status !== t.status) {
        t.status = status;
        this.opts.office.setStatus(t.key, status, status === 'waiting' ? 'aprovar uma permissão' : undefined);
      }
    }
  }

  private close(t: DshTracker): void {
    if (t.kind === 'sub') this.opts.office.completeSub(t.key);
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Uso da conta em tokens (sem cota): soma das amostras nas janelas de 5h/7d, todo ciclo. */
  private pushUsage(acc: DshAccount, now: number): void {
    this.opts.accounts.setUsage(acc.id, tokenUsage('dsh', acc.usageSamples, now));
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as unknown;
    return rec(j) ?? {};
  } catch {
    return {};
  }
}
