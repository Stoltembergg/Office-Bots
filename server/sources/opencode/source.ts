// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts): a CLI/desktop grava tudo num
// SQLite (opencode.db) na pasta de dados da plataforma (ver sources/opencode/accounts.ts). Leitura por polling,
// com o banco aberto SOMENTE PARA LEITURA a cada ciclo (WAL: o -wal/-shm do lado aparecem; nunca escrevemos).
//
// Presença (não há registro de processo): sessão com time_updated recente (≤ PRESENCE_MS) é considerada aberta;
// parada há mais tempo, sai do escritório (e volta se o OpenCode gravar de novo). Status: trabalhando enquanto
// time_updated é dos últimos ACTIVITY_QUIET_MS; ocioso se há time_idle mais novo ou simplesmente sem atividade.
// Subagentes: session_v2.parent_id. Uso: tokens e custo vêm das colunas da sessão; limites de plano, não.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { pushTokenSample, tokenUsage, WEEK_MS, type TokenSample } from '../../accounts/usage';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectOpencodeAccounts } from './accounts';
import { createOpencodeTerminalParser } from './terminal';

/** Sem atualização por este tempo, a sessão sai do escritório (volta ao primeiro update novo). */
export const PRESENCE_MS = 30 * 60_000;
/** time_updated dentro desta janela: trabalhando agora. */
export const ACTIVITY_QUIET_MS = 90_000;
const MAIN_ROLE = 'Agente principal (OpenCode)';
const SUB_ROLE = 'Subagente (OpenCode)';

export interface OpencodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas de dados do OpenCode lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Pasta para os espelhos JSONL das sessões (terminal e histórico); <dataDir>/transcripts/opencode por padrão. */
  mirrorDir?: string;
}

interface OpencodeAccount {
  id: string;
  dir: string;
  configDir: string;
  dbPath: string;
  error?: string;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
}

interface OcTracker {
  key: string;
  acc: OpencodeAccount;
  row: SessionRow;
  kind: 'main' | 'sub';
  inOffice: boolean;
  pendingParent: boolean;
  lastSig: string;
  /** Maior seq do session_message já espelhada. */
  mirroredSeq: number;
}

function modelOf(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as { id?: unknown; providerID?: unknown };
    return typeof j.id === 'string' && j.id.trim() ? j.id.trim() : undefined;
  } catch {
    return raw.trim() ? raw.trim() : undefined;
  }
}

export class OpencodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private accs: OpencodeAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private trackers = new Map<string, OcTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private stopped = false;
  /** Últimos acumulados vistos por sessão (para extrair deltas): chave = `${acc.id}:${sessionId}`. */
  private usageSeen = new Map<string, { tok: number; cost: number; at: number }>();
  /** Amostras de tokens por conta (deltas com o instante em que apareceram). */
  private usageSamples = new Map<string, TokenSample[]>();

  constructor(private readonly opts: OpencodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    const used = { shorts: [] as string[], colors: [] as string[] };
    for (const p of ['claude', 'codex', 'dsh'] as const) {
      for (const e of opts.accounts.entriesOf(p)) {
        used.shorts.push(e.detected.short);
        if (e.detected.color) used.colors.push(e.detected.color);
      }
    }
    this.detected = detectOpencodeAccounts(opts.dirs, { env, home: opts.home, taken: used });
    this.register();
  }

  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'opencode',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => prev.get(e.dir) ?? { id: e.id, dir: e.dir, configDir: e.detected.configDir, dbPath: join(e.dir, 'opencode.db') });
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
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 3_000);
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
      const info: SourceInfo = { label: acc.id, provider: 'opencode', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackers.get(agentId);
    if (!t?.inOffice || !this.opts.mirrorDir) return undefined;
    return this.mirrorPath(t);
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createOpencodeTerminalParser() : undefined;
  }

  /** Espelho JSONL da sessão (mensagens do session_message): o terminal e o histórico leem daqui. */
  private mirrorPath(t: OcTracker): string {
    const dir = this.opts.mirrorDir;
    if (!dir) throw new Error('espelho desligado (sem mirrorDir)');
    return join(dir, `${encodeURIComponent(t.key)}.jsonl`);
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`opencode-poll:${errMsg(err)}`, `Fonte OpenCode: falha ao ler o banco (${errMsg(err)}).`);
    }
  }

  /** Abre o banco da conta só para leitura; undefined = conta com erro (registrado em acc.error). */
  private openDb(acc: OpencodeAccount): DatabaseSync | undefined {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(acc.dbPath, { readOnly: true });
    } catch (err) {
      acc.error = errMsg(err);
      return undefined;
    }
    acc.error = undefined;
    return db;
  }

  /** Lê as sessões ativas de uma conta (banco já aberto). */
  private querySessions(db: DatabaseSync, acc: OpencodeAccount, cutoff: number): SessionRow[] {
    const rows = db
      .prepare(
        `SELECT id, parent_id, title, directory, agent, model, cost, tokens_input, tokens_output,
                time_created, time_updated, time_idle
           FROM session_v2
          WHERE time_archived IS NULL AND time_updated >= ?
          ORDER BY time_updated DESC`,
      )
      .all(cutoff) as unknown as SessionRow[];
    return rows;
  }

  /** Espelha as mensagens novas de uma sessão (banco já aberto; espelho é append-only). */  private mirrorMessages(db: DatabaseSync, t: OcTracker): void {
    if (!this.opts.mirrorDir || !t.inOffice) return;
    let rows: Array<{ seq: number; type: string; time_created: number; data: string }>;
    try {
      rows = db
        .prepare(`SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 2000`)
        .all(t.row.id, t.mirroredSeq) as unknown as Array<{ seq: number; type: string; time_created: number; data: string }>;
    } catch {
      return;
    }
    if (!rows.length) return;
    const lines: string[] = [];
    for (const r of rows) {
      let data: unknown = null;
      try {
        data = JSON.parse(r.data);
      } catch {
        // dado ilegível: não espelha
        continue;
      }
      lines.push(JSON.stringify({ seq: r.seq, type: r.type, at: r.time_created, data }));
      if (r.seq > t.mirroredSeq) t.mirroredSeq = r.seq;
    }
    if (!lines.length) return;
    try {
      mkdirSync(dirname(this.mirrorPath(t)), { recursive: true });
      appendFileSync(this.mirrorPath(t), lines.join('\n') + '\n');
    } catch (err) {
      log.warnOnce(`opencode-mirror:${errMsg(err)}`, `Fonte OpenCode: não consegui gravar o espelho (${errMsg(err)}).`);
    }
  }

  /**
   * Uso em tokens (o OpenCode não tem cota do plano): as colunas da sessão são acumuladas, então a
   * cada ciclo extrai o DELTA desde a última leitura e o carimba com agora — os deltas caem na janela
   * certa (5h/7d) com precisão de um ciclo. Leituras de cache (cache_read/write) ficam de fora: contam
   * como entrada/saída+raciocínio, o trabalho do modelo. Na primeira vez só anota a base (sem delta).
   */
  private pushUsage(db: DatabaseSync, acc: OpencodeAccount, now: number): void {
    let rows: Array<{ id: string; tokens_input: number | null; tokens_output: number | null; tokens_reasoning: number | null; cost: number | null }>;
    try {
      rows = db
        .prepare(
          `SELECT id, tokens_input, tokens_output, tokens_reasoning, cost
             FROM session_v2
            WHERE time_archived IS NULL AND time_updated >= ?`,
        )
        .all(now - WEEK_MS) as unknown as Array<{
        id: string;
        tokens_input: number | null;
        tokens_output: number | null;
        tokens_reasoning: number | null;
        cost: number | null;
      }>;
    } catch {
      return;
    }
    const samples = this.usageSamples.get(acc.id) ?? [];
    for (const r of rows) {
      const key = `${acc.id}:${r.id}`;
      const tok = (r.tokens_input ?? 0) + (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0);
      const cost = r.cost ?? 0;
      const prev = this.usageSeen.get(key);
      if (prev) {
        const dTok = tok - prev.tok;
        const dCost = cost - prev.cost;
        if (dTok > 0 || dCost > 0) pushTokenSample(samples, { at: now, tokens: Math.max(0, dTok), ...(dCost > 0 ? { costUSD: dCost } : {}) }, now);
      }
      this.usageSeen.set(key, { tok, cost, at: now });
    }
    // Sessões sumidas há mais de uma janela: esquece a base (se voltarem, recomeçam sem delta).
    for (const [key, seen] of this.usageSeen) {
      if (key.startsWith(`${acc.id}:`) && now - seen.at > WEEK_MS) this.usageSeen.delete(key);
    }
    this.usageSamples.set(acc.id, samples);
    this.opts.accounts.setUsage(acc.id, tokenUsage('opencode', samples, now));
  }

  poll(boot = false): void {
    const now = this.now();
    const cutoff = now - PRESENCE_MS;
    for (const acc of this.accs) {
      const db = this.openDb(acc);
      if (!db) continue;
      try {
        const rows = this.querySessions(db, acc, cutoff);
        const seen = new Set<string>();
        for (const row of rows) {
          if (!row.directory) continue; // sem pasta não há sala
          seen.add(row.id);
          const key = `${acc.id}:${row.id}`;
          let t = this.trackers.get(key);
          if (!t) {
            t = { key, acc, row, kind: row.parent_id ? 'sub' : 'main', inOffice: false, pendingParent: false, lastSig: '', mirroredSeq: 0 };
            this.trackers.set(key, t);
          }
          t.row = row;
          this.sync(t, boot, now);
        }
        for (const t of this.trackers.values()) {
          if (t.acc === acc && t.inOffice) this.mirrorMessages(db, t);
        }
        this.pushUsage(db, acc, now);
        // Sessões fora da janela de presença: saem do escritório.
        for (const t of [...this.trackers.values()]) {
          if (t.acc !== acc || !t.inOffice) continue;
          if (!seen.has(t.row.id)) this.close(t);
        }
      } catch (err) {
        acc.error = errMsg(err);
      } finally {
        try {
          db.close();
        } catch {
          // já fechado
        }
      }
    }
  }

  private sync(t: OcTracker, boot: boolean, now: number): void {
    const office = this.opts.office;
    const r = t.row;
    const working = now - r.time_updated <= ACTIVITY_QUIET_MS;
    const status = working ? 'working' : 'idle';
    const title = r.title && r.title.trim() ? truncate(maskSecrets(r.title.trim()), 80) : undefined;
    const model = modelOf(r.model);
    const role = r.agent && r.agent.trim() ? `${r.agent.trim()[0].toUpperCase()}${r.agent.trim().slice(1)} (OpenCode)` : t.kind === 'sub' ? SUB_ROLE : MAIN_ROLE;

    if (!t.inOffice) {
      if (t.kind === 'sub') {
        const parentKey = `${t.acc.id}:${r.parent_id}`;
        if (!office.has(parentKey)) {
          t.pendingParent = true;
          return;
        }
        t.pendingParent = false;
        const added = office.addSub({
          id: t.key,
          parentId: parentKey,
          sessionId: r.id,
          role,
          ...(title ? { title } : {}),
          background: false,
          startedAt: r.time_created,
        });
        t.inOffice = added || office.has(t.key);
      } else {
        office.addMain({
          id: t.key,
          provider: 'opencode',
          account: t.acc.id,
          sessionId: r.id,
          cwd: r.directory!,
          role: MAIN_ROLE,
          startedAt: r.time_created,
          status,
        });
        t.inOffice = office.has(t.key);
      }
      if (!t.inOffice) return;
    }

    const stats = {
      toolCalls: 0,
      tokensIn: r.tokens_input ?? 0,
      tokensOut: r.tokens_output ?? 0,
      ...(r.cost ? { costUSD: r.cost } : {}),
      subagents: 0,
    };
    const sig = JSON.stringify([title, model, stats, status]);
    if (sig !== t.lastSig) {
      t.lastSig = sig;
      office.applyTranscript(t.key, {
        ...(title ? { title } : {}),
        tasks: [],
        stats,
        ...(model ? { model } : {}),
        firstAt: r.time_created,
        lastAt: r.time_updated,
      });
      office.setStatus(t.key, status);
      if (working && !boot) office.fillWorkingActivity(t.key);
    }
  }

  private close(t: OcTracker): void {
    if (t.kind === 'sub') this.opts.office.completeSub(t.key);
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }
}
