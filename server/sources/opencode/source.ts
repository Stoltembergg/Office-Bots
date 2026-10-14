// Fonte do OpenCode: observa as sessões ABERTAS do OpenCode e alimenta o Office.
//
// Diferença essencial em relação às outras fontes: o OpenCode não grava a conversa em disco de um jeito que o WSL
// consiga ler — ele usa um SQLite (`opencode.db`), e o SQLite precisa de lock de arquivo que a montagem /mnt/c do
// WSL não oferece (`disk I/O error`, medido). Por isso quem grava é o PLUGIN do OpenCode, nativo no Windows, em
// JSONL no mesmo formato do transcript do Claude Code. A fonte só lê esses arquivos — nunca toca no banco.
//
// O que ela faz, a cada ~1 s: lê os marcadores de presença (`open-sessions/*.lock`) e, para cada sessão aberta,
// sincroniza o tracker: entra no escritório, sai quando a sessão acaba, e lê o que for novo da conversa para virar
// atividades e números. O parser é o do Claude Code (sources/transcript.ts), reaproveitado.
import type { Activity, AgentStatus, AgentKind, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import { createTerminalParser, type TerminalParser } from '../terminal';
import { createTranscriptState, parseLine, titleOf, type ParsedActivity, type TranscriptState } from '../transcript';
import { detectOpenCodeAccounts, discoverOpenCodeDirs, type OpenCodeAccount } from './accounts';
import { readFileSync } from 'node:fs';
import { hasTranscript, readLocks, readMeta, transcriptPath } from './files';

/** Presença recente vinda de evento do plugin mantém a sessão no escritório mesmo sem lock. */
const HOOK_PRESENCE_MS = 45_000;
/** Um marcador recém-criado espera um ciclo antes de valer (pode ser manutenção). */
const LOCK_SETTLE_MS = 1_500;
/** Marker ancient + transcript parada = sessão que não está mais aberta. */
const STALE_LOCK_MS = 30 * 60_000;

const MAIN_ROLE = 'Assistente';

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas de dados do OpenCode lidas por este processo (no Docker, as montadas). */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Quanto do fim de cada conversa é lido ao abrir a sessão (padrão 1 MB). */
  tailBytes?: number;
}

interface SessionTracker {
  /** Chave no escritório: "<conta>:<sessionId>", como no Codex. */
  key: string;
  acc: OpenCodeAccount;
  sessionId: string;
  kind: AgentKind;
  state: TranscriptState;
  meta?: ReturnType<typeof readMeta>;
  tail?: FileTail;
  transcript?: string;
  inOffice: boolean;
  status: AgentStatus;
  statusAt: number;
  waitingFor?: string;
  /** Sessão que chamou esta (subagente). */
  parentId?: string;
  /** Último evento do plugin (presença mesmo sem lock). */
  lastHookAt?: number;
  lastWriteAt?: number;
  subDone: boolean;
  /** Atividades lidas antes de o agente entrar no escritório. */
  backlog: ParsedActivity[];
  /** Contador crescente por linha do transcript (a ordem e a fonte da verdade). */
  tick: number;
  /** Indice da ultima linha com conteudo (texto, raciocinio ou ferramenta). */
  contentTick: number;
  /** Indice da ultima linha marcada com end_turn. */
  turnEndTick: number;
  /** Ociosidade armada: um fim de turno ja ocorreu e ainda nao veio prompt novo. */
  idleArmed: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** A fonte do OpenCode. Uma instância por processo; `start()` liga o polling. */
export class OpenCodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private accs: OpenCodeAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly tailBytes: number;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    const env = opts.env ?? process.env;
    const home = opts.home ?? (env.HOME || '/');
    const claude = opts.accounts.entries();
    const detected = detectOpenCodeAccounts(opts.dirs, {
      env,
      home,
      taken: { shorts: claude.map((e) => e.detected.short), colors: claude.map((e) => e.detected.color) },
    });
    // `dir` é o caminho que a fonte lê (a montagem no Docker); `configDir` é o do host, só para exibir.
    this.accs = opts.dirs.map((dir, i) => {
      const d = detected[i];
      return { id: d.id, dir, configDir: d.configDir, short: d.short, name: d.name, color: d.color };
    });
    this.register();
  }

  /** Registra as contas no AccountsService, na mesma ordem (os ids não mudam). */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'opencode',
      this.accs.map((a) => ({
        dir: a.dir,
        detected: { id: a.id, provider: 'opencode' as const, configDir: a.dir, short: a.short, name: a.name, color: a.color },
      })),
    );
    for (let i = 0; i < entries.length && i < this.accs.length; i++) this.accs[i].id = entries[i].id;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Reconstrói as sessões abertas sem gerar avisos. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.sessions.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      return { label: acc.id, provider: 'opencode', path: acc.configDir, sessions, ok: true };
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    return t?.inOffice ? t.transcript : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    // A conversa é JSONL no formato do Claude Code, então o parser padrão já entende.
    return this.sessions.has(agentId) ? createTerminalParser() : undefined;
  }

  /** As contas detectadas (usado pelo docker-up para montar as pastas). */
  accounts(): readonly OpenCodeAccount[] {
    return this.accs;
  }

  /**
   * Aplica um evento do plugin (POST /api/opencode/events). O plugin roda nativo no Windows e escreve os mesmos
   * arquivos que a fonte lê; este caminho só antecipa a presença e o status, sem esperar o polling.
   * Devolve false quando a sessão é de outra conta (ou desta fonte não a conhece), e o chamador responde {ok: false}.
   */
  applyLiveEvent(account: string | undefined, ev: { sessionId: string; status?: 'working' | 'idle'; at: number }): boolean {
    if (!account) return false;
    const t = this.sessions.get(`${account}:${ev.sessionId}`);
    // A sessão ainda não entrou no disco: o próximo poll a encontra pelo marcador de presença.
    if (!t) return false;
    t.lastHookAt = ev.at;
    if (ev.status && ev.status !== t.status) {
      t.status = ev.status;
      t.statusAt = ev.at;
      if (ev.status === 'working') delete t.waitingFor;
      this.statusToOffice(t);
    }
    return true;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`opencode-poll:${errMsg(err)}`, `OpenCode: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  poll(boot = false): void {
    const now = this.now();
    const present = new Set<string>();

    for (const acc of this.accs) {
      for (const lock of readLocks(acc.dir)) {
        const key = `${acc.id}:${lock.sessionId}`;
        const known = this.sessions.get(key);
        // Marker novo demais: espera o próximo ciclo. O que já está no escritório não espera de novo.
        if (!known && now - lock.at < LOCK_SETTLE_MS && !boot) continue;
        // Marker de um crash: antigo e sem conversa por muito tempo.
        if (known && !known.transcript && now - lock.at > STALE_LOCK_MS) continue;
        present.add(key);
        this.sync(acc, lock.sessionId, lock.at);
      }
      // Presença vinda de evento do plugin, sem marker ainda.
      for (const t of this.sessions.values()) {
        if (t.acc !== acc || present.has(t.key)) continue;
        if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) present.add(t.key);
      }
    }

    for (const t of this.sessions.values()) {
      if (present.has(t.key)) continue;
      if (t.inOffice) this.leave(t);
    }
  }

  /** Um ciclo de uma sessão: lê o que for novo e decide se ela está (ou continua) no escritório. */
  private sync(acc: OpenCodeAccount, sessionId: string, lockAt: number): void {
    const key = `${acc.id}:${sessionId}`;
    let t = this.sessions.get(key);
    if (!t) {
      t = {
        key,
        acc,
        sessionId,
        kind: 'main',
        state: createTranscriptState(),
        inOffice: false,
        status: 'working',
        statusAt: 0,
        subDone: false,
        backlog: [],
        tick: 0,
        contentTick: 0,
        turnEndTick: 0,
        idleArmed: false,
      };
      this.sessions.set(key, t);
    }
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;

    // Metadados (cwd, pai, modelo): a sessão pode ter sido criada antes do primeiro marker.
    const meta = readMeta(acc.dir, sessionId);
    if (meta) {
      t.meta = meta;
      const parent = str(meta.parentId);
      if (parent) {
        t.kind = 'sub';
        t.parentId = parent;
      }
    }
    t.lastWriteAt = lockAt;

    this.pump(t);
    this.reconcile(t);
    if (t.inOffice && t.kind === 'main') this.opts.office.fillWorkingActivity(t.key);
  }

  private reconcile(t: SessionTracker): void {
    if (!this.wanted(t)) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t);
  }

  /** A sessão deve estar no escritório agora? */
  private wanted(t: SessionTracker): boolean {
    // Sem projeto (ainda sem metadados) não há sala para o personagem.
    if (!t.meta?.cwd) return false;
    if (t.kind === 'sub') {
      const parent = this.parentKey(t);
      if (!parent || !this.opts.office.has(parent)) return false;
      if (this.opts.office.isSubDone(parent)) return false;
      // Subagente aparece trabalhando; depois de entregar, sai.
      if (!t.inOffice && t.status !== 'working') return false;
    }
    return true;
  }

  private parentKey(t: SessionTracker): string | undefined {
    return t.parentId ? `${t.acc.id}:${t.parentId}` : undefined;
  }

  private enter(t: SessionTracker): void {
    const office = this.opts.office;
    const now = this.now();
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: t.meta!.cwd,
        role: MAIN_ROLE,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const parent = this.parentKey(t)!;
      const added = office.addSub({
        id: t.key,
        parentId: parent,
        sessionId: t.sessionId,
        role: t.meta?.agent ?? 'Agente',
        title: t.meta?.title ?? titleOf(t.state),
        background: false,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
    }
    this.flushBacklog(t);
    this.applySummary(t);
  }

  /** Sai do escritório: principal encerra; subagente entrega. */
  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }

  // ---------------------------------------------------------------- transcript

  /** Lê o que for novo da conversa e vira atividades. */
  /**
   * Registra, por ordem de chegada, a ultima linha com conteudo e a ultima marcada com end_turn. O marcador de
   * fim de turno do plugin vem com stop_reason e conteudo vazio, entao as duas detecoes nao se confundem.
   */
  private markTicks(t: SessionTracker, raw: string): void {
    const tick = ++t.tick
    // Um prompt do usuario abre um turno novo: so ele desarma a ociosidade.
    if (raw.indexOf("\"type\":\"user\"") >= 0) {
      t.idleArmed = false
      return
    }
    const open = raw.indexOf("\"type\":\"assistant\"") >= 0
    const end = raw.indexOf("\"stop_reason\":\"end_turn\"") >= 0
    if (end) {
      t.turnEndTick = tick
      t.idleArmed = true
      return
    }
    if (open && (raw.indexOf("\"text\"") >= 0 || raw.indexOf("\"thinking\"") >= 0 || raw.indexOf("\"tool_use\"") >= 0)) {
      t.contentTick = tick
    }
  }

  /**
   * Semeia os indices a partir do arquivo ja existente: sem isso, depois de recarregar o plugin (o OpenCode faz
   * isso sozinho ao notar o arquivo), a sessao antiga nao saberia quem foi o ultimo sinal.
   */
  private seedTicks(t: SessionTracker): void {
    if (!t.transcript) return;
    try {
      const raw = readFileSync(t.transcript, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim()) this.markTicks(t, line);
      }
    } catch {
      // arquivo ainda nao existe ou nao esta legivel: semeia so com o que os eventos trouxerem
    }
  }

  private pump(t: SessionTracker): void {
    if (!t.tail) {
      if (!hasTranscript(t.acc.dir, t.sessionId)) return;
      this.load(t);
      return;
    }

    // Passos tardios chegam depois do fim da execucao e marcam working pelo evento HTTP. O transcript e a fonte
    // da verdade e esta disponivel sempre: reavaliar aqui, a cada ciclo, e o que faz o personagem voltar a
    // ocioso. Sem isto so voltaria quando chegasse linha nova.
    const before = t.status;
    this.settleStatus(t);
    if (t.status !== before) this.statusToOffice(t);
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`opencode-read:${t.key}`, `OpenCode: conversa de ${t.key} ilegível (${errMsg(err)}).`);
        return;
      }
      if (r.missing) {
        delete t.tail;
        delete t.transcript;
        return;
      }
      if (r.reset) {
        // Reescrito no mesmo caminho: relê do começo.
        this.load(t);
        return;
      }
      for (const line of r.lines) this.markTicks(t, line);
      for (const line of r.lines) this.absorb(t, parseLine(t.state, line, { idPrefix: t.key, now: this.now() }));
      if (r.lines.length) {
        // O transcript manda no status: um `stop_reason: end_turn` novo tem de tirar o personagem de
        // "working" mesmo numa leitura incremental (antes so era recalculado ao abrir a sessao).
        this.settleStatus(t);
        this.applySummary(t);
        this.statusToOffice(t);
      }
      if (!r.more) break;
    }
  }

  /** Abre a conversa: lê a janela do fim e monta o estado inicial. */
  private load(t: SessionTracker): void {
    const path = transcriptPath(t.acc.dir, t.sessionId);
    const tail = new FileTail(path);
    tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.transcript = path;
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) this.absorb(t, parseLine(t.state, line, { idPrefix: t.key, now: this.now() }));
      if (!r.more) break;
    }
    this.seedTicks(t);
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
  }

  /**
   * Status depois de ler a janela: um turno em aberto é 'working'; o fim de turno é 'idle'. Sem sinal
   * nenhum, o status que já estava vale.
   */
  private settleStatus(t: SessionTracker): void {
    // Com o turno encerrado, so um PROMPT novo devolve o personagem ao trabalho. Conteudo que atrasa apos o
    // end_turn (o text.ended final do OpenCode chega depois de execution.succeeded) nao vale como turno novo.
    if (t.idleArmed) {
      t.status = 'idle';
      delete t.waitingFor;
    } else if (t.contentTick > 0) {
      t.status = 'working';
      delete t.waitingFor;
    } else {
      return; // nada a mudar
    }
    this.statusToOffice(t);
  }

  private statusToOffice(t: SessionTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    if (t.status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  /** Atividades lidas antes de o agente entrar ficam na fila. */
  private absorb(t: SessionTracker, res: { activities: ParsedActivity[] }): void {
    for (const a of res.activities) {
      if (t.inOffice) this.opts.office.addActivity(t.key, a.activity, a.current);
      else t.backlog.push(a);
    }
  }

  private flushBacklog(t: SessionTracker): void {
    if (!t.backlog.length) return;
    for (const a of t.backlog) this.opts.office.addActivity(t.key, a.activity, a.current);
    t.backlog = [];
  }

  /** Título, tarefas e estatísticas da conversa, para o escritório. */
  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    this.opts.office.applyTranscript(t.key, {
      title: t.meta?.title ?? titleOf(s),
      tasks: s.tasks,
      stats: s.stats,
      model: t.meta?.model ?? s.model,
      gitBranch: s.gitBranch,
      permissionMode: s.permissionMode,
      firstAt: s.firstAt,
      lastAt: s.lastAt,
    });
  }
}

/** Pastas do OpenCode a observar a partir do ambiente (reexportado para o index.ts). */
export { discoverOpenCodeDirs };