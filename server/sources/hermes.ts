// Fonte de agentes do Hermes (AgentSource 'hermes', ver sources/source.ts): lê os kanban.db do Hermes e põe um
// personagem por perfil no escritório, na sala do board do cartão que ele mostra (escritorio.md, "O que vira o quê").
//
// Só leitura: cada ciclo abre os bancos com SQLite `mode=ro` (node:sqlite, readOnly) e fecha em seguida. Lê só as
// tabelas `tasks` e `task_events` do kanban (colunas listadas nas consultas abaixo). Os state.db dos perfis NÃO são
// lidos aqui (a fonte de sessões/uso é outra). Nunca ler messages, system_prompt, title de sessão, chat_id, user_id,
// .env, auth.json nem config.yaml.
//
// Bancos: <HERMES_ROOT>/kanban.db (board "default") e <HERMES_ROOT>/kanban/boards/<board>/kanban.db.
//
// Estado de cada cartão aberto (prioridade quando um perfil tem vários: guarded > blocked > delivering > running):
// - guarded (placa vermelha), mesmas regras do pl-opens-coleta.py: >=5 respawn_guarded do mesmo motivo em 10 min,
//   consecutive_failures >= 3, running sem heartbeat há mais de 60 min, ou blocked cujo último evento de bloqueio é
//   erro do sistema (gave_up, spawn_failed, crashed, timed_out — mesma regra do kanban-nanny);
// - blocked: blocked esperando humano (levanta a mão; balão = 1ª linha do motivo, sem o "O que travou:");
// - delivering: review_requested há menos de DELIVER_MS (vale para o `implementer` do evento) ou reatribuição para
//   reviewer/judge/qa/auditor (vale para o `from`);
// - running: status running do assignee.
// Perfil sem nada disso mas com cartão mexido nos últimos IDLE_DAYS dias fica no escritório à toa (café).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentStatus, HermesCard, HermesCardState, SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import type { AgentSource } from './source';

export const GUARD_WINDOW_S = 10 * 60;
export const GUARD_MIN = 5;
export const FAILURES_MIN = 3;
export const STALE_HEARTBEAT_S = 60 * 60;
export const DELIVER_MS = 3 * 60_000;
export const IDLE_DAYS = 7;
const SYSTEM_BLOCK = new Set(['gave_up', 'spawn_failed', 'crashed', 'timed_out']);
const BLOCK_EVENTS = ['blocked', ...SYSTEM_BLOCK];
const REVIEWERS = new Set(['reviewer', 'judge', 'qa', 'auditor']);
const RANK: Record<HermesCardState, number> = { running: 1, delivering: 2, blocked: 3, guarded: 4 };
const ROLE = 'Perfil do Hermes';

/** Um kanban.db achado. */
export interface HermesBoard {
  board: string;
  path: string;
}

/** O que um board diz de um perfil: o cartão mais importante e o momento (s) da última mexida dele. */
export interface ProfileCard extends HermesCard {
  profile: string;
  /** Epoch s do que decidiu o estado (para desempate: o mais recente vence). */
  at: number;
}

export interface BoardRead {
  cards: ProfileCard[];
  /** Perfis com cartão mexido na janela de IDLE_DAYS: perfil → {board, at (s)}. */
  recent: Map<string, number>;
}

/** Os kanban.db do Hermes sob `root`. */
export function discoverBoards(root: string): HermesBoard[] {
  const out: HermesBoard[] = [];
  const main = join(root, 'kanban.db');
  if (existsSync(main)) out.push({ board: 'default', path: main });
  const dir = join(root, 'kanban', 'boards');
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // sem boards nomeados
  }
  for (const name of names) {
    const path = join(dir, name, 'kanban.db');
    if (existsSync(path)) out.push({ board: name, path });
  }
  return out;
}

/** Abre só para leitura (URI `mode=ro`, além do readOnly do node:sqlite). */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(`file:${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}?mode=ro`, { readOnly: true });
}

function payloadOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 1ª linha útil do motivo, sem o rótulo "O que travou:", até 160 caracteres. */
export function firstLine(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const line = reason
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  const clean = line.replace(/^\**o que travou:?\**\s*/i, '').trim() || line;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  consecutive_failures: number | null;
  last_heartbeat_at: number | null;
  started_at: number | null;
  created_at: number;
  current_run_id: number | null;
}

/** Lê um board: o estado de cada cartão aberto (por perfil) e os perfis com cartão recente. `now` em ms. */
export function readBoard(db: DatabaseSync, board: string, now: number): BoardRead {
  const t0 = Math.floor(now / 1000);
  const cards: ProfileCard[] = [];
  const add = (profile: string | null | undefined, task: TaskRow, state: HermesCardState, at: number, reason?: string) => {
    if (!profile) return;
    const card: ProfileCard = { profile, board, taskId: task.id, title: task.title, state, at };
    if (reason) card.reason = reason;
    cards.push(card);
  };

  const tasks = db
    .prepare(
      'SELECT id, title, status, assignee, consecutive_failures, last_heartbeat_at, started_at, created_at, current_run_id ' +
        "FROM tasks WHERE status NOT IN ('done','archived')",
    )
    .all() as unknown as TaskRow[];
  const open = new Map(tasks.map((t) => [t.id, t]));

  // respawn_guarded repetido (janela de 10 min, por cartão e motivo)
  const guards = new Map<string, number>();
  for (const r of db
    .prepare("SELECT task_id, payload FROM task_events WHERE kind='respawn_guarded' AND created_at > ? AND created_at <= ?")
    .all(t0 - GUARD_WINDOW_S, t0) as Array<{ task_id: string; payload: string | null }>) {
    if (!open.has(r.task_id)) continue;
    const key = `${r.task_id}\u0000${str(payloadOf(r.payload).reason) ?? '?'}`;
    guards.set(key, (guards.get(key) ?? 0) + 1);
  }
  const guardedBy = new Map<string, string>();
  for (const [key, n] of guards) {
    if (n < GUARD_MIN) continue;
    const [tid, why] = key.split('\u0000');
    guardedBy.set(tid, `guarda repetida (${why}) ${GUARD_MIN}+ em 10 min`);
  }

  const lastBlock = db.prepare(
    `SELECT kind, payload, created_at FROM task_events WHERE task_id=? AND kind IN (${BLOCK_EVENTS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
  );
  const runBeat = db.prepare('SELECT COALESCE(last_heartbeat_at, started_at) AS at FROM task_runs WHERE id=?');

  for (const t of tasks) {
    const fails = t.consecutive_failures ?? 0;
    let guard = guardedBy.get(t.id);
    if (!guard && fails >= FAILURES_MIN) guard = `${fails} falhas seguidas`;
    if (t.status === 'running') {
      let ref = t.last_heartbeat_at;
      if (ref == null && t.current_run_id != null) {
        try {
          ref = (runBeat.get(t.current_run_id) as { at: number | null } | undefined)?.at ?? null;
        } catch {
          ref = null;
        }
      }
      ref ??= t.started_at ?? t.created_at;
      if (!guard && t0 - ref > STALE_HEARTBEAT_S) guard = `sem sinal de vida há ${Math.floor((t0 - ref) / 60)} min`;
      if (guard) add(t.assignee, t, 'guarded', t0, guard);
      else add(t.assignee, t, 'running', ref);
    } else if (t.status === 'blocked') {
      const ev = lastBlock.get(t.id, ...BLOCK_EVENTS) as { kind: string; payload: string | null; created_at: number } | undefined;
      const at = ev?.created_at ?? t.created_at;
      if (!guard && ev && SYSTEM_BLOCK.has(ev.kind)) guard = `erro do sistema (${ev.kind})`;
      if (guard) add(t.assignee, t, 'guarded', at, guard);
      else add(t.assignee, t, 'blocked', at, firstLine(str(payloadOf(ev?.payload).reason)) ?? '(bloqueou sem escrever o motivo)');
    } else if (guard) {
      add(t.assignee, t, 'guarded', t0, guard);
    }
  }

  // Entregas recentes ao revisor (o cartão pode até já estar fechado).
  const since = Math.floor((now - DELIVER_MS) / 1000);
  const titleOf = db.prepare('SELECT id, title, status, assignee, consecutive_failures, last_heartbeat_at, started_at, created_at, current_run_id FROM tasks WHERE id=?');
  for (const r of db
    .prepare("SELECT task_id, kind, payload, created_at FROM task_events WHERE kind IN ('review_requested','assigned') AND created_at > ? ORDER BY id")
    .all(since) as Array<{ task_id: string; kind: string; payload: string | null; created_at: number }>) {
    const p = payloadOf(r.payload);
    let who: string | undefined;
    let to: string | undefined;
    if (r.kind === 'review_requested') {
      who = str(p.implementer);
      to = str(p.reviewer);
    } else {
      to = str(p.assignee);
      if (to && REVIEWERS.has(to)) who = str(p.from);
    }
    if (!who || who === to) continue;
    const task = open.get(r.task_id) ?? (titleOf.get(r.task_id) as TaskRow | undefined);
    if (task) add(who, task, 'delivering', r.created_at, to ? `entregou para ${to}` : 'entregou para revisão');
  }

  const recent = new Map<string, number>();
  for (const r of db
    .prepare(
      'SELECT assignee, MAX(COALESCE(completed_at, started_at, created_at)) AS at FROM tasks ' +
        "WHERE assignee IS NOT NULL AND assignee <> '' AND status <> 'archived' " +
        'AND COALESCE(completed_at, started_at, created_at) > ? GROUP BY assignee',
    )
    .all(t0 - IDLE_DAYS * 86400) as Array<{ assignee: string; at: number }>) {
    recent.set(r.assignee, r.at);
  }
  return { cards, recent };
}

/** O cartão que cada perfil mostra: maior prioridade; empate = o mais recente. */
export function pickCards(cards: readonly ProfileCard[]): Map<string, ProfileCard> {
  const out = new Map<string, ProfileCard>();
  for (const c of cards) {
    const cur = out.get(c.profile);
    if (!cur || RANK[c.state] > RANK[cur.state] || (RANK[c.state] === RANK[cur.state] && c.at > cur.at)) out.set(c.profile, c);
  }
  return out;
}

function statusOf(state: HermesCardState | undefined): AgentStatus {
  if (state === 'blocked' || state === 'guarded') return 'waiting';
  return state ? 'working' : 'idle';
}

function waitingOf(card: ProfileCard | undefined): string | undefined {
  if (!card) return undefined;
  if (card.state === 'blocked') return card.reason ?? 'responder no kanban';
  if (card.state === 'guarded') return `⚠ ${card.reason ?? 'placa vermelha'}`;
  return undefined;
}

const ICON: Record<HermesCardState, string> = { running: '⌨️', blocked: '✋', guarded: '🛑', delivering: '📦' };
const VERB: Record<HermesCardState, string> = { running: 'Trabalhando', blocked: 'Precisa de você', guarded: 'Placa vermelha', delivering: 'Entregando' };

/** Pasta-sala de um board (vira a sala no escritório). */
export function roomCwd(board: string): string {
  return `/hermes/${board}`;
}

export interface HermesSourceOptions {
  office: Office;
  /** Raiz do Hermes lida por este processo (no Docker, /hermes). */
  root: string;
  now?: () => number;
  pollMs?: number;
}

interface BoardState extends HermesBoard {
  ok: boolean;
  error?: string;
}

export class HermesSource implements AgentSource {
  readonly provider = 'hermes' as const;
  private boards: BoardState[] = [];
  /** Perfil → board da sala atual. */
  private present = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: HermesSourceOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll();
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (err) {
        log.warnOnce(`hermes-poll:${errMsg(err)}`, `Hermes: falha no ciclo de leitura: ${errMsg(err)}`);
      }
    }, this.opts.pollMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return this.boards.map((b) => {
      let sessions = 0;
      for (const board of this.present.values()) if (board === b.board) sessions++;
      const info: SourceInfo = { label: b.board, provider: 'hermes', path: b.path, sessions, ok: b.ok };
      if (b.error) info.error = b.error;
      return info;
    });
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Um ciclo: relê todos os boards e acerta os personagens. */
  poll(): void {
    const now = this.now();
    this.boards = discoverBoards(this.opts.root).map((b) => ({ ...b, ok: true }));
    const cards: ProfileCard[] = [];
    const recent = new Map<string, { board: string; at: number }>();
    for (const b of this.boards) {
      let db: DatabaseSync | undefined;
      try {
        db = openReadOnly(b.path);
        const r = readBoard(db, b.board, now);
        cards.push(...r.cards);
        for (const [profile, at] of r.recent) {
          const cur = recent.get(profile);
          if (!cur || at > cur.at) recent.set(profile, { board: b.board, at });
        }
      } catch (err) {
        b.ok = false;
        b.error = errMsg(err);
        log.warnOnce(`hermes-board:${b.board}:${b.error}`, `Hermes: não consegui ler o board ${b.board} (${b.error}).`);
      } finally {
        db?.close();
      }
    }
    const picked = pickCards(cards);
    const profiles = new Set([...picked.keys(), ...recent.keys()]);
    const office = this.opts.office;
    for (const profile of profiles) {
      const card = picked.get(profile);
      const board = card?.board ?? recent.get(profile)!.board;
      const id = `hermes:${profile}`;
      const status = statusOf(card?.state);
      if (!office.has(id) || office.get(id)?.status === 'offline') {
        office.addMain({
          id,
          provider: 'hermes',
          account: 'hermes',
          sessionId: id,
          cwd: roomCwd(board),
          role: ROLE,
          name: profile,
          startedAt: card ? card.at * 1000 : now,
          status,
          waitingFor: waitingOf(card),
        });
      } else {
        office.moveMain(id, roomCwd(board));
        office.setStatus(id, status, waitingOf(card));
      }
      const prev = office.get(id)?.hermes;
      office.setHermes(id, card ? { board: card.board, taskId: card.taskId, title: card.title, state: card.state, ...(card.reason ? { reason: card.reason } : {}) } : undefined);
      if (card && (prev?.taskId !== card.taskId || prev?.state !== card.state)) {
        office.addActivity(
          id,
          {
            id: `${id}#${card.board}:${card.taskId}:${card.state}:${card.at}`,
            kind: card.state === 'delivering' ? 'communicate' : card.state === 'running' ? 'other' : 'wait',
            icon: ICON[card.state],
            text: `${VERB[card.state]}: ${card.title}`.slice(0, 46),
            detail: `${card.board} · ${card.taskId}${card.reason ? ` · ${card.reason}` : ''}`,
            tool: 'Hermes',
            at: card.at * 1000,
          },
          true,
        );
      }
      this.present.set(profile, board);
    }
    for (const profile of [...this.present.keys()]) {
      if (profiles.has(profile)) continue;
      office.closeMain(`hermes:${profile}`);
      this.present.delete(profile);
    }
  }
}
