// Fonte de agentes do Cursor (AgentSource 'cursor', ver sources/source.ts): observa os chats de ~/.cursor/chats.
//
// Presença: o `meta.json` de cada chat (e o mtime do store.db, sem abrir o SQLite) diz a última atividade; chat
// com atividade na janela de presença está "aberto": HABBLAUD_IDLE_LEAVE_MIN (a mesma saída por inatividade das outras
// fontes, ver Office) ou, sem ela, CURSOR_RECENT_MS. Sem atividade na janela = fechado, com a mesma folga de 1,5 s das
// outras fontes. 'working' só na janela quente (CURSOR_WORKING_MS); presente e parado = 'idle'.
// Linha do tempo: parse incremental dos blobs JSON plaintext em store.db → addActivity / mergeHistory.
// MVP: sem subagentes (isSubagent fica de fora), sem cwd não há sala, sem transcript para o terminal SSE, e uma
// conta só (.cursor), mesmo com várias pastas.
// Uso do plano: GetCurrentPeriodUsage (~60 s) com token em ~/.config/cursor/auth.json (só no host).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Activity, AgentStats, SourceInfo, TaskItem } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { detectCursorAccount } from './accounts';
import { CURSOR_RECENT_MS, isCursorPresent, isCursorWorking, listCursorChats, type CursorChatMeta } from './files';
import { parseCursorStore } from './transcript';
import { defaultCursorAuthPath, loadCursorUsage, type FetchFn } from './usage';

function gitBranchOf(cwd: string): string | undefined {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const b = r.stdout?.trim();
    if (!b || b === 'HEAD') return undefined;
    return b;
  } catch {
    return undefined;
  }
}

function emptyStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

const MAIN_ROLE = 'Agente principal (Cursor)';
/** Tempo que o chat precisa ficar ausente para ser dado como encerrado. */
const CLOSE_AFTER_MISSING_MS = 1_500;
const DEFAULT_USAGE_POLL_MS = 60_000;
/** Atividades recentes que entram via addActivity no primeiro load; o resto vai para mergeHistory. */
const LIVE_HISTORY = 40;
const MAX_HISTORY = 200;

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Cursor (com `chats/`) lidas por este processo. */
  roots: string[];
  /**
   * Janela de presença: sem atividade por este tempo, o chat sai do escritório. O Cursor não diz se o chat está aberto,
   * então é a única saída dele; vem de HABBLAUD_IDLE_LEAVE_MIN (ServerConfig.idleLeaveMs). Ausente = CURSOR_RECENT_MS.
   */
  presenceMs?: number;
  now?: () => number;
  pollMs?: number;
  /** Intervalo do poll de uso do plano (default 60 s). */
  usagePollMs?: number;
  /** Caminho do auth.json do CLI (default ~/.config/cursor/auth.json). */
  authPath?: string;
  /** Injeção de fetch nos testes. */
  fetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

interface ChatTracker {
  key: string;
  chatId: string;
  inOffice: boolean;
  missingSince?: number;
  storePath?: string;
  lastStoreMtimeMs?: number;
  lastRowId: number;
  stats: AgentStats;
  model?: string;
  permissionMode?: string;
  tasks: TaskItem[];
  gitBranch?: string;
  /** Já fez o load inicial do store (mergeHistory + recent). */
  storeLoaded: boolean;
}

export class CursorSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private entry: AccountEntry | undefined;
  private chats = new Map<string, ChatTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private usageInFlight = false;
  private readonly now: () => number;
  private readonly authPath: string;

  constructor(private readonly opts: CursorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.authPath = opts.authPath ?? defaultCursorAuthPath(opts.env ?? process.env, opts.home);
    this.register();
  }

  private register(): void {
    const root = this.opts.roots[0];
    if (!root) {
      this.opts.accounts.setProviderAccounts('cursor', []);
      return;
    }
    const others = this.opts.accounts.entries().concat(this.opts.accounts.entriesOf('codex'));
    const detected = detectCursorAccount(root, { taken: { colors: others.map((e) => e.detected.color) } });
    this.entry = this.opts.accounts.setProviderAccounts('cursor', [{ dir: root, detected }])[0];
  }

  /** Contas do Cursor (id final, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entry ? [this.entry] : [];
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
    this.usageTimer = setInterval(() => void this.safeUsagePoll(), this.opts.usagePollMs ?? DEFAULT_USAGE_POLL_MS);
    this.usageTimer.unref?.();
  }

  /** Reconstrói os chats abertos sem gerar avisos. Síncrono e curto. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    void this.safeUsagePoll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.timer = null;
    this.usageTimer = null;
  }

  sources(): SourceInfo[] {
    if (!this.entry) return [];
    let sessions = 0;
    for (const t of this.chats.values()) if (t.inOffice) sessions++;
    return [{ label: this.entry.id, provider: 'cursor', path: this.entry.detected.configDir, sessions, ok: true }];
  }

  /** O Cursor guarda a conversa em SQLite (store.db): sem transcript para o terminal. */
  transcriptPathOf(): undefined {
    return undefined;
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`cursor-poll:${errMsg(err)}`, `Cursor: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  private async safeUsagePoll(): Promise<void> {
    if (!this.entry || this.usageInFlight) return;
    this.usageInFlight = true;
    try {
      const usage = await loadCursorUsage(this.authPath, {
        fetch: this.opts.fetch,
        now: this.now,
      });
      if (!usage) {
        log.warnOnce('cursor-usage:empty', 'Cursor: sem dados de uso (auth ausente, API falhou ou plano sem janelas)');
        return;
      }
      this.opts.accounts.setUsage(this.entry.id, usage);
    } catch (err) {
      log.warnOnce(`cursor-usage:${errMsg(err)}`, `Cursor: falha ao ler uso do plano: ${errMsg(err)}`);
    } finally {
      this.usageInFlight = false;
    }
  }

  poll(boot = false): void {
    if (!this.entry) return;
    const now = this.now();
    const office = this.opts.office;
    const present = new Map<string, CursorChatMeta>();
    for (const root of this.opts.roots) {
      for (const meta of listCursorChats(root, now)) {
        if (meta.isSubagent || !meta.cwd || !isCursorPresent(meta, now, this.opts.presenceMs || CURSOR_RECENT_MS)) continue;
        present.set(meta.chatId, meta);
      }
    }
    for (const [chatId, meta] of present) {
      const key = `${this.entry.id}:${chatId}`;
      let t = this.chats.get(chatId);
      if (!t) {
        t = { key, chatId, inOffice: false, lastRowId: 0, stats: emptyStats(), tasks: [], storeLoaded: false };
        this.chats.set(chatId, t);
      }
      delete t.missingSince;
      if (t.inOffice && !office.has(key)) t.inOffice = false; // saiu do escritório (graça encerrada)
      this.sync(t, meta, now, boot);
    }
    for (const [chatId, t] of [...this.chats]) {
      if (present.has(chatId)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      if (t.inOffice) office.closeMain(t.key);
      this.chats.delete(chatId);
    }
  }

  private sync(t: ChatTracker, meta: CursorChatMeta, now: number, boot: boolean): void {
    const office = this.opts.office;
    const status = isCursorWorking(meta, now) ? 'working' : 'idle';
    if (!t.inOffice) {
      office.addMain({
        id: t.key,
        provider: 'cursor',
        account: this.entry!.id,
        sessionId: t.chatId,
        cwd: meta.cwd!,
        role: MAIN_ROLE,
        startedAt: meta.createdAtMs ?? meta.updatedAtMs,
        status,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      t.gitBranch = gitBranchOf(meta.cwd!);
    }
    office.setStatus(t.key, status);
    this.syncStore(t, meta, boot);
    const summary: TranscriptSummary = {
      title: meta.title,
      tasks: t.tasks,
      stats: { ...t.stats },
      lastAt: Math.max(meta.updatedAtMs, meta.storeMtimeMs ?? 0),
    };
    if (t.model) summary.model = t.model;
    if (t.gitBranch) summary.gitBranch = t.gitBranch;
    if (t.permissionMode) summary.permissionMode = t.permissionMode;
    office.applyTranscript(t.key, summary);
  }

  private syncStore(t: ChatTracker, meta: CursorChatMeta, boot: boolean): void {
    const storePath = join(meta.dir, 'store.db');
    t.storePath = storePath;
    const mtime = meta.storeMtimeMs;
    if (mtime === undefined) return;

    const mtimeChanged = t.lastStoreMtimeMs === undefined || mtime !== t.lastStoreMtimeMs;
    if (!t.storeLoaded) {
      this.loadStore(t, meta, storePath, /* initial */ true, boot);
      t.lastStoreMtimeMs = mtime;
      return;
    }
    if (!mtimeChanged) return;
    this.loadStore(t, meta, storePath, /* initial */ false, boot);
    t.lastStoreMtimeMs = mtime;
  }

  private loadStore(t: ChatTracker, meta: CursorChatMeta, storePath: string, initial: boolean, boot: boolean): void {
    const office = this.opts.office;
    let parsed;
    try {
      parsed = parseCursorStore(storePath, {
        idPrefix: t.key,
        afterRowId: initial ? 0 : t.lastRowId,
        endAtMs: Math.max(meta.updatedAtMs, meta.storeMtimeMs ?? 0, this.now()),
        limit: initial ? MAX_HISTORY : undefined,
      });
    } catch (err) {
      log.warnOnce(`cursor-store:${t.chatId}`, `Cursor: falha ao ler store.db: ${errMsg(err)}`);
      return;
    }

    if (parsed.maxRowId > t.lastRowId) t.lastRowId = parsed.maxRowId;
    if (initial) {
      t.stats = { ...parsed.stats };
    } else {
      t.stats = {
        toolCalls: t.stats.toolCalls + parsed.stats.toolCalls,
        tokensIn: t.stats.tokensIn + parsed.stats.tokensIn,
        tokensOut: t.stats.tokensOut + parsed.stats.tokensOut,
        subagents: t.stats.subagents + parsed.stats.subagents,
        ...(parsed.stats.linesAdded !== undefined || t.stats.linesAdded !== undefined
          ? { linesAdded: (t.stats.linesAdded ?? 0) + (parsed.stats.linesAdded ?? 0) }
          : {}),
        ...(parsed.stats.linesRemoved !== undefined || t.stats.linesRemoved !== undefined
          ? { linesRemoved: (t.stats.linesRemoved ?? 0) + (parsed.stats.linesRemoved ?? 0) }
          : {}),
        ...(parsed.stats.costUSD !== undefined || t.stats.costUSD !== undefined
          ? { costUSD: (t.stats.costUSD ?? 0) + (parsed.stats.costUSD ?? 0) }
          : {}),
      };
    }
    if (parsed.model) t.model = parsed.model;
    if (parsed.permissionMode) t.permissionMode = parsed.permissionMode;
    if (parsed.tasks.length) t.tasks = parsed.tasks;
    // Branch pode mudar durante a sessão; só refresca quando o store muda.
    if (meta.cwd) t.gitBranch = gitBranchOf(meta.cwd) ?? t.gitBranch;

    const activities = parsed.activities;
    if (!activities.length) {
      t.storeLoaded = true;
      return;
    }

    if (initial) {
      const split = activities.length > LIVE_HISTORY ? activities.length - LIVE_HISTORY : 0;
      const older = activities.slice(0, split);
      const recent = activities.slice(split);
      if (older.length) office.mergeHistory(t.key, older);
      this.pushActivities(t.key, recent, /* live */ false);
      t.storeLoaded = true;
      return;
    }

    // Poll incremental: novidades no feed (exceto durante boot).
    this.pushActivities(t.key, activities, /* live */ !boot);
  }

  private pushActivities(agentId: string, activities: readonly Activity[], live: boolean): void {
    const office = this.opts.office;
    const last = activities.length - 1;
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i]!;
      office.addActivity(agentId, a, i === last, { feed: live });
    }
  }
}
