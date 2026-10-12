// Fonte de agentes do Grok (AgentSource 'grok', ver sources/source.ts): a CLI `grok` (TUI), que grava em GROK_HOME
// (~/.grok). Observa as sessões ABERTAS e alimenta o Office.
//
// Presença: o próprio Grok mantém `active_sessions.json` (session_id, pid, cwd) com as sessões abertas do TUI, e o pid
// precisa estar vivo (uma entrada de um processo que caiu não conta). Some da lista = encerrada (com a mesma folga de
// 1,5 s do Claude Code). /new (/clear) abre outra sessão: a antiga sai e a nova chega. No Docker essa lista não serve
// (o Grok a troca por rename, e um bind de arquivo único fica preso à versão antiga; os pids do host também não são
// visíveis): vale a conversa modificada nos últimos RECENT_MS, como no Codex sem a pasta de locks. Limite conhecido:
// no Docker uma sessão fechada fica até RECENT_MS no escritório, e uma aberta e parada há mais que isso some.
//
// Conversa: `sessions/<cwd>/<id>/updates.jsonl` (updates.ts) dá as atividades, as tarefas e o status (instrução abre o
// turno, turn_completed fecha); `summary.json` dá o título e o modelo. Sessões de subagente (`session_kind`) ficam de
// fora. O que o Grok ainda não grava em arquivo (o pedido de permissão em aberto) não aparece: o status fica
// "trabalhando" até o turno terminar.
//
// Escopo por pasta (HABBLAUD_PROJECT_ROOTS): o cwd da sessão precisa ser de dentro, o arquivo inteiro também
// (fileScope; uma tarefa em segundo plano grava o próprio cwd) e uma linha nova de outra pasta tira a sessão.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { cwdOutOfScope } from '../../model/rooms';
import { pidAlive } from '../registry';
import { fileScope } from '../scope';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { findSessionDir, readActiveSessions, readSummary, recentSessions, UPDATES_FILE, type ActiveSession, type GrokSummary } from './files';
import { createGrokState, createGrokTerminalParser, parseGrokLine, type GrokLineResult, type GrokState } from './updates';

/** Docker: presença = conversa modificada nos últimos 30 min (revista a cada 10 s). */
export const RECENT_MS = 30 * 60_000;
const RECENT_SCAN_MS = 10_000;
/** 'working' sem nenhuma escrita na conversa por este tempo: o turno morreu (crash, Ctrl+C sem registro). */
export const WORKING_QUIET_MS = 30 * 60_000;
/** Tempo que a sessão precisa ficar ausente da lista para ser dada como encerrada. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** Procura da pasta da sessão e releitura do summary.json: no máximo a cada tanto. */
const RESOLVE_MS = 3_000;
/** Resultados guardados ao ler a conversa antes de o agente entrar no escritório. */
const BACKLOG_MAX = 400;
const ROLE = 'Agente principal (Grok)';

export interface GrokSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta do Grok lida por este processo (no Docker, a montada). */
  dir: string;
  /** Pasta para exibir (no Docker, a do host); padrão = `dir`. */
  hostDir?: string;
  inDocker: boolean;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pollMs?: number;
  /** Quanto do fim da conversa é lido ao abrir a sessão (padrão 1 MB). */
  tailBytes?: number;
}

interface Tracker {
  key: string;
  sessionId: string;
  cwd: string;
  openedAt?: number;
  sessionDir?: string;
  path?: string;
  tail?: FileTail;
  state: GrokState;
  backlog: GrokLineResult[];
  inOffice: boolean;
  /** Mexeu em outra pasta (escopo): não volta mais. */
  outOfScope: boolean;
  /** Sessão de subagente ou do `grok -p`: fica de fora. */
  internal: boolean;
  status: AgentStatus;
  statusAt: number;
  summary: GrokSummary;
  summaryMtime?: number;
  nextResolveAt: number;
  lastWriteAt?: number;
  missingSince?: number;
}

export class GrokSource implements AgentSource {
  readonly provider = 'grok' as const;
  private accountId: string;
  private readonly hostDir: string;
  private active: ActiveSession[] = [];
  private recentAt = -Infinity;
  private trackers = new Map<string, Tracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private error?: string;
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly opts: GrokSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.isAlive = opts.isAlive ?? pidAlive;
    this.hostDir = opts.hostDir ?? opts.dir;
    const others = [...opts.accounts.entries(), ...opts.accounts.entriesOf('codex')];
    const usedColors = new Set(others.map((e) => e.detected.color));
    const usedShorts = new Set(others.map((e) => e.detected.short.toUpperCase()));
    const color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
    const short = ['G', 'K', 'Y'].find((s) => !usedShorts.has(s)) ?? 'G';
    const [entry] = opts.accounts.setProviderAccounts('grok', [
      { dir: opts.dir, detected: { id: '.grok', provider: 'grok', configDir: this.hostDir, short, name: 'Grok', color } },
    ]);
    this.accountId = entry.id;
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.inOffice) sessions++;
    const info: SourceInfo = { label: this.accountId, provider: 'grok', path: this.hostDir, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackers.get(agentId);
    return t?.inOffice ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createGrokTerminalParser(this.now) : undefined;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`grok-poll:${errMsg(err)}`, `Grok: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  poll(boot = false): void {
    const now = this.now();
    if (this.opts.inDocker) {
      if (now - this.recentAt >= RECENT_SCAN_MS) {
        this.recentAt = now;
        this.active = recentSessions(this.opts.dir, now - RECENT_MS);
      }
    } else {
      const list = readActiveSessions(this.opts.dir);
      if (list) this.active = list;
    }
    const seen = new Set<string>();
    for (const a of this.active) {
      if (!this.present(a, now)) continue;
      const key = `${this.accountId}:${a.sessionId}`;
      let t = this.trackers.get(key);
      if (!t) {
        t = this.newTracker(key, a);
        this.trackers.set(key, t);
      }
      seen.add(key);
      try {
        this.sync(t, now, boot);
      } catch (err) {
        log.warnOnce(`grok-session:${key}:${errMsg(err)}`, `Grok: sessão ${key}: ${errMsg(err)}`);
      }
    }
    for (const [key, t] of [...this.trackers]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      if (t.inOffice) this.opts.office.closeMain(key);
      this.trackers.delete(key);
    }
  }

  /** A entrada vale como sessão aberta? Fora do Docker, pelo pid; no Docker, pela última escrita na conversa. */
  private present(a: ActiveSession, now: number): boolean {
    if (!this.opts.inDocker) return a.pid === undefined || this.isAlive(a.pid);
    const t = this.trackers.get(`${this.accountId}:${a.sessionId}`);
    return now - Math.max(t?.lastWriteAt ?? 0, a.openedAt ?? 0) <= RECENT_MS;
  }

  private newTracker(key: string, a: ActiveSession): Tracker {
    const t: Tracker = {
      key,
      sessionId: a.sessionId,
      cwd: a.cwd,
      state: createGrokState(),
      backlog: [],
      inOffice: false,
      outOfScope: false,
      internal: false,
      status: 'idle',
      statusAt: 0,
      summary: {},
      nextResolveAt: 0,
    };
    if (a.openedAt !== undefined) t.openedAt = a.openedAt;
    return t;
  }

  private sync(t: Tracker, now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // saiu (graça encerrada)
    if (t.outOfScope || t.internal) return;
    const office = this.opts.office;
    if (office.scoped && !office.inScope(t.cwd)) return;
    if (now >= t.nextResolveAt) {
      t.nextResolveAt = now + (boot ? 0 : RESOLVE_MS);
      this.resolve(t);
      if (t.outOfScope || t.internal) return;
    }
    this.pump(t);
    if (t.outOfScope) return;
    if (!t.inOffice) this.enter(t, now);
    if (!t.inOffice) return;
    this.quietCheck(t, now);
    this.applySummary(t);
    office.fillWorkingActivity(t.key);
  }

  /** Acha a pasta da sessão, relê o summary.json (se mudou) e abre a conversa quando ela aparecer. */
  private resolve(t: Tracker): void {
    t.sessionDir ??= findSessionDir(this.opts.dir, t.sessionId, t.cwd);
    if (!t.sessionDir) return;
    let mtime: number | undefined;
    try {
      mtime = statSync(join(t.sessionDir, 'summary.json')).mtimeMs;
    } catch {
      mtime = undefined;
    }
    if (mtime !== undefined && mtime !== t.summaryMtime) {
      t.summaryMtime = mtime;
      t.summary = readSummary(t.sessionDir);
      // Subagente, ou `grok -p` (headless: fora do Docker ele nem entra na lista das sessões abertas).
      if (t.summary.kind === 'subagent' || t.summary.kind === 'headless') {
        t.internal = true;
        if (t.inOffice) this.opts.office.closeMain(t.key);
        t.inOffice = false;
        return;
      }
    }
    const path = join(t.sessionDir, UPDATES_FILE);
    if (!t.tail && exists(path)) this.load(t, path);
  }

  /** Lê a janela do fim da conversa (como histórico, sem feed) depois de conferir o arquivo inteiro no escopo. */
  private load(t: Tracker, path: string): void {
    const office = this.opts.office;
    if (office.scoped) {
      const scan = fileScope(path, office.inScope);
      if (scan.status === 'out') return this.outOfScope(t);
    }
    const tail = new FileTail(path);
    tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.path = path;
    t.state = createGrokState();
    t.backlog = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      if (!this.lines(t, r.lines, false)) return;
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      office.setStatus(t.key, t.status);
    }
  }

  /** O que for novo na conversa. Arquivo apagado: espera ele voltar; reescrito no lugar: relê. */
  private pump(t: Tracker): void {
    if (!t.tail) return;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`grok-read:${t.key}`, `Grok: conversa de ${t.key} ilegível (${errMsg(err)}).`);
        return;
      }
      if (r.missing) {
        delete t.tail;
        delete t.path;
        t.nextResolveAt = 0;
        return;
      }
      t.lastWriteAt = t.tail.mtimeMs;
      if (r.reset) return this.load(t, t.tail.path);
      if (!this.lines(t, r.lines, true)) return;
      if (!r.more) break;
    }
  }

  /** Aplica linhas da conversa. false = uma delas é de outra pasta (a sessão saiu do escopo). */
  private lines(t: Tracker, lines: readonly string[], live: boolean): boolean {
    const office = this.opts.office;
    for (const line of lines) {
      if (office.scoped && cwdOutOfScope(line, office.inScope) !== undefined) {
        this.outOfScope(t);
        return false;
      }
      const r = parseGrokLine(t.state, line, { idPrefix: t.key, now: this.now() });
      this.apply(t, r, live);
    }
    return true;
  }

  private outOfScope(t: Tracker): void {
    t.outOfScope = true;
    delete t.tail;
    t.backlog = [];
    if (t.inOffice) this.opts.office.leaveScope(t.key);
    t.inOffice = false;
  }

  private apply(t: Tracker, r: GrokLineResult, live: boolean): void {
    for (const sig of r.signals) {
      if (sig.type === 'turnStart') this.decide(t, 'working', r.at, live);
      else if (sig.type === 'turnEnd') this.decide(t, 'idle', r.at, live);
      else if (t.status !== 'working' && t.state.turnOpen) this.decide(t, 'working', r.at, live);
    }
    if (!live || !t.inOffice) {
      if (r.activities.length) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    for (const a of r.activities) this.opts.office.addActivity(t.key, a.activity, a.current);
    if (r.changed) this.applySummary(t);
  }

  private decide(t: Tracker, status: AgentStatus, at: number, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (live && t.inOffice) this.opts.office.setStatus(t.key, status);
  }

  /** Status depois de ler a janela: turno aberto = trabalhando, a não ser que a conversa esteja parada há muito. */
  private settleStatus(t: Tracker): void {
    const quiet = this.now() - (t.lastWriteAt ?? 0) > WORKING_QUIET_MS;
    t.status = t.state.turnOpen && !quiet ? 'working' : 'idle';
    t.statusAt = t.state.lastAt ?? 0;
  }

  private quietCheck(t: Tracker, now: number): void {
    if (t.status !== 'working' || now - Math.max(t.lastWriteAt ?? 0, t.statusAt) <= WORKING_QUIET_MS) return;
    t.status = 'idle';
    t.statusAt = now;
    this.opts.office.setStatus(t.key, 'idle');
  }

  private enter(t: Tracker, now: number): void {
    const office = this.opts.office;
    office.addMain({
      id: t.key,
      provider: 'grok',
      account: this.accountId,
      sessionId: t.sessionId,
      cwd: t.cwd,
      role: ROLE,
      startedAt: t.summary.createdAt ?? t.openedAt ?? t.state.firstAt ?? now,
      status: t.status,
    });
    t.inOffice = office.has(t.key);
    if (!t.inOffice) return;
    office.setStatus(t.key, t.status);
    this.flushBacklog(t);
    this.applySummary(t);
  }

  private flushBacklog(t: Tracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) for (const a of r.activities) this.opts.office.addActivity(t.key, a.activity, a.current, { feed: false });
  }

  private applySummary(t: Tracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    this.opts.office.applyTranscript(t.key, {
      title: t.summary.title ?? s.firstPrompt,
      tasks: s.tasks,
      stats: s.stats,
      model: t.summary.model,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
    });
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
