// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts): observa o servidor `opencode serve` (API
// v2) pelo SSE /api/event e, no boot, pelos GETs de sessões ativas e recentes. Cada sessão vira um agente:
// - principal, na sala da pasta dela (location.directory), enquanto está rodando ou teve atividade nos últimos RECENT_MS;
// - subagente da sessão mãe, quando tem parentID: entra enquanto trabalha e entrega (📦) ao terminar;
// - subagente de uma sessão do Claude Code, quando metadata.ocgo.thread é o id de uma sessão do Claude presente no
//   escritório: o mesmo que um subagente nativo (entra, trabalha, entrega). Sem essa sessão, vira principal normal.
// O vínculo (principal ou subagente, e de quem) é decidido quando a sessão entra; depois só muda de presença.
//
// Servidor fora do ar (é sob demanda e desliga sozinho depois de 30 min sem sessão ocupada): a fonte tenta de novo com
// backoff, avisa uma vez por queda e, depois de OFFLINE_GRACE_MS, os agentes dela somem (como sessão fechada). Ao voltar,
// o boot refaz o escritório. A fonte só lê (GET e /api/event): nunca manda prompt, comando ou permissão.
//
// Limites conhecidos: uma sessão ociosa há mais de RECENT_MS sai do escritório até voltar a trabalhar; um vínculo com o
// Claude Code só é visto se a sessão do Claude já estiver no escritório quando a sessão do OpenCode entra.
import type { AgentStats, SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { OpenCodeConfig } from '../../config';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { SPECIAL } from '../../../shared/activity';
import type { AgentSource } from '../source';
import { describeOpenCodeTool } from './activity';
import { OpenCodeClient, OpenCodeHttpError, OpenCodeStallError, readSse, type OpenCodeSessionInfo } from './client';

/** Sessão sem atividade e parada há mais que isto sai do escritório. */
export const RECENT_MS = 30 * 60_000;
/** Servidor fora do ar por mais que isto: os agentes da fonte somem. */
export const OFFLINE_GRACE_MS = 15_000;
/** Intervalo da varredura (sessões que envelheceram saem; atividade parada volta ao "pensando"). */
export const SWEEP_MS = 10_000;
/** Espera entre tentativas de reconexão: cresce de RETRY_MIN_MS até RETRY_MAX_MS. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** Stream de eventos sem nenhum byte por tanto tempo: conexão morta, refaz. */
export const STALL_MS = 120_000;
/** Sessões mais novas pedidas no boot. */
const RECENT_LIMIT = 100;
/** Profundidade máxima ao resolver pais (sessão sob sessão sob sessão...). */
const MAX_DEPTH = 4;

const MAIN_ROLE = tr('Agente principal (OpenCode)');
const SUB_ROLE = tr('Subagente (OpenCode)');

/** Tempos da fonte (os padrões são os de produção; os testes encurtam). */
export interface OpenCodeTiming {
  recentMs: number;
  graceMs: number;
  sweepMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  stallMs: number;
}

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  config: OpenCodeConfig;
  now?: () => number;
  fetch?: typeof fetch;
  timing?: Partial<OpenCodeTiming>;
}

/** Uma sessão do OpenCode conhecida pela fonte (dentro ou fora do escritório). */
interface Track {
  /** sessionID do OpenCode. */
  id: string;
  /** Id no Office. */
  key: string;
  directory: string;
  parentID?: string;
  /** metadata.ocgo.thread: id de uma sessão do Claude Code. */
  thread?: string;
  title?: string;
  model?: string;
  createdAt: number;
  /** Última notícia da sessão (epoch ms): atualização do boot ou de um evento. */
  lastAt: number;
  running: boolean;
  inOffice: boolean;
  /** Chave do dono quando entrou como subagente; ausente = principal. */
  ownerKey?: string;
  stats: AgentStats;
  /** Chamadas de ferramenta em andamento: id da chamada → nome. */
  calls: Map<string, string>;
}

type State = 'starting' | 'online' | 'offline';

export class OpenCodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private readonly accountId: string;
  private readonly client: OpenCodeClient;
  private readonly now: () => number;
  private readonly timing: OpenCodeTiming;
  private readonly tracks = new Map<string, Track>();
  private readonly pendingFetch = new Set<string>();
  private state: State = 'starting';
  private error?: string;
  private retryWait: number;
  private stopped = false;
  private abort: AbortController | null = null;
  private wake: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private firstTry: Promise<void> = Promise.resolve();
  private markFirstTry: () => void = () => undefined;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.timing = { recentMs: RECENT_MS, graceMs: OFFLINE_GRACE_MS, sweepMs: SWEEP_MS, retryMinMs: RETRY_MIN_MS, retryMaxMs: RETRY_MAX_MS, stallMs: STALL_MS, ...opts.timing };
    this.retryWait = this.timing.retryMinMs;
    this.client = new OpenCodeClient({ url: opts.config.url, password: opts.config.password, fetch: opts.fetch });
    // Uma conta por servidor (sem uso nem plano: o OpenCode não tem limite de plano que a fonte leia).
    const [entry] = opts.accounts.setProviderAccounts('opencode', [
      { dir: opts.config.url, detected: { id: 'opencode', configDir: opts.config.url, short: 'O', name: 'OpenCode', color: '#5ab0a0' } },
    ]);
    this.accountId = entry.id;
  }

  /** Liga: a primeira tentativa (boot) termina antes de a promessa resolver; depois a fonte segue no ciclo de reconexão. */
  start(): Promise<void> {
    this.stopped = false;
    this.firstTry = new Promise<void>((resolve) => (this.markFirstTry = resolve));
    this.sweepTimer = setInterval(() => this.safeSweep(), this.timing.sweepMs);
    this.sweepTimer.unref?.();
    void this.run();
    return this.firstTry;
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.sweepTimer = null;
    this.graceTimer = null;
    if (this.wake) {
      clearTimeout(this.wake.timer);
      this.wake.resolve();
      this.wake = null;
    }
    this.markFirstTry();
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.tracks.values()) if (t.inOffice && t.ownerKey === undefined) sessions++;
    const info: SourceInfo = { label: this.accountId, provider: 'opencode', path: this.opts.config.url, sessions, ok: this.state === 'online' };
    if (this.error && this.state !== 'online') info.error = this.error;
    return [info];
  }

  /** Sem arquivo de transcript: o terminal desta fonte fica para depois (o parser padrão não se aplica). */
  transcriptPathOf(_agentId: string): undefined {
    return undefined;
  }

  // ---------------------------------------------------------------- conexão

  private async run(): Promise<void> {
    while (!this.stopped) {
      const ac = new AbortController();
      this.abort = ac;
      try {
        await this.cycle(ac.signal);
      } catch (err) {
        if (this.stopped) return;
        this.offline(err);
      } finally {
        ac.abort();
        this.abort = null;
      }
      if (this.stopped) return;
      await this.sleep(this.retryWait);
      this.retryWait = Math.min(this.retryWait * 2, this.timing.retryMaxMs);
    }
  }


  /** Uma conexão: confere o servidor, abre o stream, faz o boot e lê os eventos até a conexão cair (sempre lança). */
  private async cycle(signal: AbortSignal): Promise<void> {
    const info = await this.client.info();
    const stream = await this.client.openEvents(signal);
    await this.bootSnapshot();
    this.online(info.version);
    await readSse(stream, (ev) => this.onEvent(ev), this.timing.stallMs);
    throw new Error(tr('o servidor fechou a conexão de eventos'));
  }

  /** Boot: as sessões ativas e as recentes, entre office.beginBoot e office.endBoot (sempre em par). */
  private async bootSnapshot(): Promise<void> {
    const office = this.opts.office;
    office.beginBoot();
    try {
      const [activeIds, recent] = await Promise.all([this.client.activeIds(), this.client.recentSessions(RECENT_LIMIT)]);
      const byId = new Map(recent.map((s) => [s.id, s]));
      for (const id of activeIds) {
        if (byId.has(id)) continue;
        const s = await this.client.session(id);
        if (s) byId.set(id, s);
      }
      this.applySnapshot(new Set(activeIds), [...byId.values()]);
    } finally {
      office.endBoot();
    }
  }

  private applySnapshot(active: Set<string>, sessions: OpenCodeSessionInfo[]): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.time?.archived) continue;
      const at = s.time?.updated ?? s.time?.created ?? now;
      const running = active.has(s.id);
      if (!running && now - at >= this.timing.recentMs) continue;
      seen.add(s.id);
      this.upsert(s, running, at);
    }
    // O que o servidor não devolve mais (apagado, ou envelhecido) sai.
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.forget(id);
    this.reconcileAll();
  }

  private online(version: string): void {
    const was = this.state;
    this.state = 'online';
    this.error = undefined;
    this.retryWait = this.timing.retryMinMs;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (was !== 'online') log.info(tr('OpenCode ({0}): conectado (versão {1}).', [this.opts.config.url, version]));
    this.markFirstTry();
  }

  private offline(err: unknown): void {
    const was = this.state;
    this.state = 'offline';
    this.error = describeError(err);
    this.markFirstTry();
    // Um aviso por queda (não a cada tentativa); os agentes somem só se a queda passar do prazo de graça.
    if (was !== 'offline') log.warn(tr('OpenCode ({0}): sem resposta ({1}). Tentando de novo.', [this.opts.config.url, this.error]));
    if (!this.graceTimer) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.dropAll();
      }, this.timing.graceMs);
      this.graceTimer.unref?.();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wake = { timer, resolve };
    });
  }

  /** Servidor caiu de vez: os agentes saem (subagentes entregam, como nas outras fontes ao sumir). */
  private dropAll(): void {
    const all = [...this.tracks.values()];
    for (const t of all.filter((x) => x.ownerKey !== undefined)) this.leave(t);
    for (const t of all) this.leave(t);
    this.tracks.clear();
  }

  // ---------------------------------------------------------------- eventos ao vivo

  private onEvent(raw: unknown): void {
    const ev = asEnvelope(raw);
    if (!ev) return;
    const sid = str(ev.data.sessionID);
    if (!sid) return;
    if (ev.type === 'session.created') {
      this.onCreated(sid, ev);
      return;
    }
    if (ev.type === 'session.deleted') {
      this.forget(sid);
      return;
    }
    const t = this.tracks.get(sid);
    if (!t) {
      if (ev.type === 'session.execution.started') void this.fetchUnknown(sid);
      return;
    }
    const at = typeof ev.created === 'number' ? ev.created : this.now();
    t.lastAt = Math.max(t.lastAt, at);
    const d = ev.data;
    switch (ev.type) {
      case 'session.renamed':
        t.title = str(d.title) ?? t.title;
        break;
      case 'session.execution.started':
        t.running = true;
        break;
      case 'session.step.started':
        t.model = str(rec(d.model)?.id) ?? t.model;
        break;
      case 'session.step.ended': {
        const tokens = rec(d.tokens);
        t.stats.tokensIn += num(tokens?.input);
        t.stats.tokensOut += num(tokens?.output);
        break;
      }
      case 'session.tool.input.started': {
        const callId = str(d.id);
        const name = str(d.name);
        if (callId && name) t.calls.set(callId, name);
        break;
      }
      case 'session.tool.called':
        this.toolCalled(t, d, at);
        break;
      case 'session.tool.success': {
        const callId = str(d.id);
        if (callId) t.calls.delete(callId);
        break;
      }
      case 'session.tool.failed':
        this.toolFailed(t, d, at);
        break;
      case 'session.text.ended':
        this.text(t, d, at, ev.id);
        break;
      default:
        if (ev.type.startsWith('session.execution.')) t.running = false;
    }
    this.reconcile(t);
  }

  private onCreated(sid: string, ev: Envelope): void {
    const d = ev.data;
    const at = typeof ev.created === 'number' ? ev.created : this.now();
    const directory = str(ev.location?.directory) ?? str(rec(d.location)?.directory) ?? '';
    const s: OpenCodeSessionInfo = { id: sid, location: { directory }, time: { created: at, updated: at } };
    const parentID = str(d.parentID);
    if (parentID) s.parentID = parentID;
    const title = str(d.title);
    if (title) s.title = title;
    const metadata = rec(d.metadata);
    if (metadata) s.metadata = metadata;
    const model = rec(d.model);
    if (model) s.model = { id: str(model.id) };
    this.reconcile(this.upsert(s, false, at));
  }

  /** Sessão que começou a rodar e não estava na lista do boot (uma sessão antiga, acordada): busca os dados dela. */
  private async fetchUnknown(sid: string): Promise<void> {
    if (this.pendingFetch.has(sid)) return;
    this.pendingFetch.add(sid);
    try {
      const s = await this.client.session(sid);
      if (s && !s.time?.archived && this.state === 'online') {
        const at = s.time?.updated ?? this.now();
        this.reconcile(this.upsert(s, true, at));
      }
    } catch {
      // Sem a sessão, o próximo evento dela tenta de novo; o aviso de servidor fora do ar já foi dado por quem caiu.
    } finally {
      this.pendingFetch.delete(sid);
    }
  }

  private toolCalled(t: Track, d: Record<string, unknown>, at: number): void {
    const callId = str(d.id);
    const name = (callId && t.calls.get(callId)) || str(d.name) || 'tool';
    t.stats.toolCalls += 1;
    if (!this.opts.office.has(t.key)) return;
    const { desc, tool } = describeOpenCodeTool(name, rec(d.input) ?? {});
    this.opts.office.addActivity(t.key, { id: `${t.key}#${callId ?? at}`, at, ...desc, tool }, true);
    this.push(t);
  }

  private toolFailed(t: Track, d: Record<string, unknown>, at: number): void {
    const callId = str(d.id);
    const name = (callId && t.calls.get(callId)) || str(d.name) || 'tool';
    if (callId) t.calls.delete(callId);
    const error = rec(d.error);
    // Interrupção pelo usuário não é erro de ferramenta (o evento de execução já mostra que parou).
    if (error?.type === 'aborted' || !this.opts.office.has(t.key)) return;
    const msg = str(error?.message);
    this.opts.office.addActivity(t.key, { id: `${t.key}#${callId ?? at}:err`, at, ...SPECIAL.error(name, msg), tool: name, error: true }, true);
  }

  private text(t: Track, d: Record<string, unknown>, at: number, eventId: string | undefined): void {
    const text = str(d.text);
    if (!text || !this.opts.office.has(t.key)) return;
    this.opts.office.addActivity(t.key, { id: `${t.key}#text:${eventId ?? at}`, at, ...SPECIAL.respond(text) }, true);
  }

  // ---------------------------------------------------------------- sessões e escritório

  /** Cria ou atualiza o registro da sessão (sem mexer no escritório). */
  private upsert(s: OpenCodeSessionInfo, running: boolean, at: number): Track {
    let t = this.tracks.get(s.id);
    if (!t) {
      t = { id: s.id, key: `${this.accountId}:${s.id}`, directory: '', createdAt: s.time?.created ?? at, lastAt: at, running, inOffice: false, stats: zeroStats(), calls: new Map() };
      this.tracks.set(s.id, t);
    }
    t.directory = s.location?.directory || t.directory;
    t.parentID = s.parentID || undefined;
    t.thread = threadOf(s.metadata);
    t.title = s.title || undefined;
    t.model = s.model?.id || t.model;
    t.createdAt = s.time?.created ?? t.createdAt;
    t.lastAt = Math.max(t.lastAt, at);
    t.running = running;
    return t;
  }

  private reconcileAll(): void {
    for (const t of [...this.tracks.values()]) this.reconcile(t);
  }

  private safeSweep(): void {
    if (this.state !== 'online') return;
    try {
      this.reconcileAll();
      for (const t of this.tracks.values()) if (t.inOffice && t.ownerKey === undefined && t.running) this.opts.office.fillWorkingActivity(t.key);
    } catch (err) {
      log.warnOnce(`opencode-sweep:${errMsg(err)}`, tr('OpenCode: falha na varredura: {0}', [errMsg(err)]));
    }
  }

  /**
   * Põe a sessão no escritório, ou tira, conforme a presença: principal enquanto está aberta (rodando ou recente);
   * subagente enquanto roda, sob o dono. Idempotente.
   */
  private reconcile(t: Track, depth = 0): void {
    const office = this.opts.office;
    if (t.inOffice && !office.has(t.key)) {
      t.inOffice = false;
      t.ownerKey = undefined;
    }
    const present = t.running || this.now() - t.lastAt < this.timing.recentMs;
    if (t.inOffice) {
      const keep = t.ownerKey === undefined ? present : t.running && office.has(t.ownerKey);
      if (!keep) {
        this.leave(t);
        return;
      }
    } else {
      const owner = this.ownerFor(t, depth);
      // Subagente de pai que não está no escritório espera o pai (o pai entra antes, na varredura ou no próximo evento).
      if (t.parentID && owner === undefined) return;
      if (owner !== undefined ? !t.running : !present) return;
      if (!this.enter(t, owner)) return;
    }
    this.sync(t);
  }

  /** Chave do dono: a sessão mãe (entrando antes, se preciso) ou o agente do Claude Code com o id do metadata. */
  private ownerFor(t: Track, depth: number): string | undefined {
    if (t.parentID) {
      const parent = this.tracks.get(t.parentID);
      if (!parent || parent === t || depth >= MAX_DEPTH) return undefined;
      if (!parent.inOffice) this.reconcile(parent, depth + 1);
      return parent.inOffice ? parent.key : undefined;
    }
    return this.claudeKeyOf(t.thread);
  }

  /** Principal do Claude Code (não é OpenCode nem Codex) com este id de sessão, se estiver no escritório. */
  private claudeKeyOf(thread: string | undefined): string | undefined {
    if (!thread) return undefined;
    return this.opts.office.list().find((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude' && a.sessionId === thread && a.status !== 'offline')?.id;
  }

  private enter(t: Track, owner: string | undefined): boolean {
    const office = this.opts.office;
    // Registro de outro tipo com este id (ex.: subagente já entregue, ainda na graça do dono) não vira principal, nem o
    // contrário: o addMain sobre um registro existente só tira o removeAt e deixa o subagente órfão. A varredura seguinte tenta de novo.
    const ex = office.get(t.key);
    if (ex && ex.kind !== (owner === undefined ? 'main' : 'sub')) return false;
    if (owner === undefined) {
      if (!t.directory) return false;
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: this.accountId,
        sessionId: t.id,
        cwd: t.directory,
        role: MAIN_ROLE,
        startedAt: t.createdAt,
        status: t.running ? 'working' : 'idle',
      });
    } else {
      const added = office.addSub({
        id: t.key,
        parentId: owner,
        sessionId: t.id,
        role: SUB_ROLE,
        ...(t.title ? { title: t.title } : {}),
        background: false,
        startedAt: t.createdAt,
        provider: 'opencode',
        account: this.accountId,
      });
      if (!added) return false;
    }
    t.inOffice = true;
    t.ownerKey = owner;
    return true;
  }

  /** Estado da sessão no escritório: status, o que faz agora (boleto de ferramenta, pensando) e os números. */
  private sync(t: Track): void {
    const office = this.opts.office;
    if (t.ownerKey !== undefined && t.running) office.reactivateSub(t.key);
    office.setStatus(t.key, t.running ? 'working' : 'idle');
    if (t.running) office.fillWorkingActivity(t.key);
    this.push(t);
  }

  private leave(t: Track): void {
    if (!t.inOffice) return;
    if (t.ownerKey !== undefined) this.opts.office.completeSub(t.key);
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
    t.ownerKey = undefined;
  }

  private forget(sid: string): void {
    const t = this.tracks.get(sid);
    if (!t) return;
    this.leave(t);
    this.tracks.delete(sid);
  }

  /** Título, modelo e números da sessão (o mesmo canal que o transcript usa no Claude Code e no Codex). */
  private push(t: Track): void {
    this.opts.office.applyTranscript(t.key, { title: t.title, tasks: [], stats: { ...t.stats }, model: t.model });
  }
}

interface Envelope {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string };
  data: Record<string, unknown>;
}

function asEnvelope(raw: unknown): Envelope | undefined {
  const o = rec(raw);
  if (!o || typeof o.type !== 'string') return undefined;
  return { id: str(o.id), type: o.type, created: typeof o.created === 'number' ? o.created : undefined, location: rec(o.location) as Envelope['location'], data: rec(o.data) ?? {} };
}

function zeroStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** metadata.ocgo.thread (id de uma sessão do Claude Code), se houver. */
export function threadOf(metadata: Record<string, unknown> | undefined): string | undefined {
  return str(rec(metadata?.ocgo)?.thread);
}

function describeError(err: unknown): string {
  if (err instanceof OpenCodeHttpError) return err.status === 401 || err.status === 403 ? tr('senha recusada ({0})', [err.status]) : `HTTP ${err.status}`;
  if (err instanceof OpenCodeStallError) return tr('sem dados por muito tempo');
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : errMsg(err);
}
