import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { discoverBoards, firstLine, HermesSource, internalBlock, openReadOnly, pickCards, readBoard } from './hermes';

// Kanban SINTÉTICO, com as colunas do kanban.db do Hermes que a fonte lê (nada vem de um board real).
const SCHEMA = `
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER, current_run_id INTEGER, block_kind TEXT);
CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL,
  payload TEXT, created_at INTEGER NOT NULL);
CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
  last_heartbeat_at INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER);
`;

const NOW = Date.UTC(2026, 9, 11, 21, 0, 0);
const S = Math.floor(NOW / 1000);

interface Task {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  created_at?: number;
  started_at?: number;
  completed_at?: number;
  consecutive_failures?: number;
  last_heartbeat_at?: number;
}

function makeDb(path: string, tasks: Task[], events: Array<[string, string, unknown, number]> = [], wal = false): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  const ins = db.prepare(
    'INSERT INTO tasks (id, title, status, assignee, created_at, started_at, completed_at, consecutive_failures, last_heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  for (const t of tasks) {
    ins.run(t.id, t.title, t.status, t.assignee ?? null, t.created_at ?? S - 3600, t.started_at ?? null, t.completed_at ?? null, t.consecutive_failures ?? 0, t.last_heartbeat_at ?? null);
  }
  const ev = db.prepare('INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?,?,?,?)');
  for (const [tid, kind, payload, at] of events) ev.run(tid, kind, payload === null ? null : JSON.stringify(payload), at);
  db.close();
}

/** Os 4 estados + um perfil à toa, em dois boards. */
function fixtureRoot(root: string): void {
  makeDb(
    join(root, 'kanban.db'),
    [
      { id: 't_run', title: 'Fonte hermes do escritório', status: 'running', assignee: 'dev', started_at: S - 600, last_heartbeat_at: S - 60 },
      { id: 't_blk', title: 'Desenhar o prédio', status: 'blocked', assignee: 'architect' },
      { id: 't_old', title: 'Prints antigos', status: 'done', assignee: 'qa', completed_at: S - 2 * 86400 },
    ],
    [['t_blk', 'blocked', { reason: 'O que travou: falta escolher a porta.\nVocê faz: responda "4317".', kind: 'needs_input' }, S - 300]],
  );
  const guard = Array.from({ length: 6 }, (_, i) => ['t_grd', 'respawn_guarded', { reason: 'active_pr' }, S - 60 * (i + 1)] as [string, string, unknown, number]);
  makeDb(
    join(root, 'kanban', 'boards', 'openhealth', 'kanban.db'),
    [
      { id: 't_grd', title: 'Revisar PR #12', status: 'review', assignee: 'reviewer' },
      { id: 't_dlv', title: 'Tela de exames', status: 'review', assignee: 'judge' },
    ],
    [...guard, ['t_dlv', 'review_requested', { summary: 'pronto', implementer: 'devgemini', reviewer: 'judge' }, S - 60]],
    true,
  );
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  setQuiet(true);
  tmp = tempDir();
});
afterEach(() => {
  setQuiet(false);
  tmp.cleanup();
});

describe('readBoard', () => {
  it('acha os boards (default + nomeados)', () => {
    fixtureRoot(tmp.dir);
    expect(discoverBoards(tmp.dir).map((b) => b.board)).toEqual(['default', 'openhealth']);
  });

  it('running, blocked (motivo sem "O que travou"), guarda repetida e entregando', () => {
    fixtureRoot(tmp.dir);
    const cards = discoverBoards(tmp.dir).flatMap((b) => {
      const db = openReadOnly(b.path);
      try {
        return readBoard(db, b.board, NOW).cards;
      } finally {
        db.close();
      }
    });
    const by = pickCards(cards);
    expect(by.get('dev')).toMatchObject({ state: 'running', board: 'default', taskId: 't_run' });
    expect(by.get('architect')).toMatchObject({ state: 'blocked', reason: 'falta escolher a porta.' });
    expect(by.get('reviewer')).toMatchObject({ state: 'guarded', board: 'openhealth', taskId: 't_grd' });
    expect(by.get('reviewer')!.reason).toContain('active_pr');
    expect(by.get('devgemini')).toMatchObject({ state: 'delivering', taskId: 't_dlv', reason: 'entregou para judge' });
    expect(by.has('qa')).toBe(false);
  });

  it('placa vermelha: running sem heartbeat >60 min, 3 falhas seguidas, bloqueio por erro do sistema', () => {
    const path = join(tmp.dir, 'kanban.db');
    makeDb(
      path,
      [
        { id: 'a', title: 'parado', status: 'running', assignee: 'p1', started_at: S - 3 * 3600, last_heartbeat_at: S - 2 * 3600 },
        { id: 'b', title: 'falhando', status: 'ready', assignee: 'p2', consecutive_failures: 3 },
        { id: 'c', title: 'caiu', status: 'blocked', assignee: 'p3' },
        { id: 'd', title: 'guarda pouca', status: 'review', assignee: 'p4' },
      ],
      [
        ['c', 'blocked', { reason: 'antes' }, S - 900],
        ['c', 'gave_up', { error: 'x' }, S - 600],
        ...Array.from({ length: 4 }, () => ['d', 'respawn_guarded', { reason: 'active_pr' }, S - 30] as [string, string, unknown, number]),
      ],
    );
    const db = openReadOnly(path);
    const by = pickCards(readBoard(db, 'default', NOW).cards);
    db.close();
    expect(by.get('p1')).toMatchObject({ state: 'guarded' });
    expect(by.get('p1')!.reason).toContain('sem sinal de vida');
    expect(by.get('p2')).toMatchObject({ state: 'guarded', reason: '3 falhas seguidas' });
    expect(by.get('p3')).toMatchObject({ state: 'guarded', reason: 'erro do sistema (gave_up)' });
    expect(by.has('p4')).toBe(false); // 4 guardas em 10 min não bastam
  });

  it('entrega antiga (> 3 min) não conta; reatribuição para o revisor conta para quem entregou', () => {
    const path = join(tmp.dir, 'kanban.db');
    makeDb(
      path,
      [{ id: 'x', title: 'cartão', status: 'review', assignee: 'qa' }],
      [
        ['x', 'review_requested', { implementer: 'velho', reviewer: 'reviewer' }, S - 600],
        ['x', 'assigned', { assignee: 'qa', from: 'dev' }, S - 30],
      ],
    );
    const db = openReadOnly(path);
    const by = pickCards(readBoard(db, 'default', NOW).cards);
    db.close();
    expect(by.has('velho')).toBe(false);
    expect(by.get('dev')).toMatchObject({ state: 'delivering', reason: 'entregou para qa' });
  });

  it('abre só para leitura, inclusive WAL com -shm sem permissão de escrita', () => {
    fixtureRoot(tmp.dir);
    const path = join(tmp.dir, 'kanban', 'boards', 'openhealth', 'kanban.db');
    // deixa os arquivos como no container (:ro)
    const keep = new DatabaseSync(path);
    keep.exec('SELECT 1');
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(f, 0o444);
      } catch {
        // -wal/-shm podem não existir
      }
    }
    const db = openReadOnly(path);
    try {
      expect(readBoard(db, 'openhealth', NOW).cards.length).toBeGreaterThan(0);
      expect(() => db.exec("UPDATE tasks SET title='x'")).toThrow();
    } finally {
      db.close();
      keep.close();
    }
  });

  it('bloqueio interno (mesma regra do kanban-nanny) = placa amarela "Manager resolvendo", sem mão', () => {
    const path = join(tmp.dir, 'kanban', 'boards', 'hermes-lab', 'kanban.db');
    const reasons: Record<string, string> = {
      // o caso que o Victor viu
      conflito:
        'O que travou: o PR #38 (feat/x) está com conflito com a main e quem resolve é o dev.\nVocê faz: nada.',
      merge: 'O que travou: PR #12 aprovado, falta mergear o PR #12.\nVocê faz: nada, o opens-automerge mergeia.',
      reatribui: 'O que travou: judge pediu mudança e o cartão caiu no reviewer.\nVocê faz: reatribua o cartão ao dev.',
      correcao: 'A correção é do dev; o reviewer não escreve código.',
      soul: 'Não consigo gravar SOUL.md. Salvei SOUL.md.proposto em docs/.',
      tag: 'O que travou: aguardando a tag v1.2.0 sair para publicar.',
      humano: 'O que travou: falta a senha do banco.\nVocê faz: mande "senha ok" ao Hermes.',
    };
    const tasks = Object.keys(reasons).map((k) => ({ id: `t_${k}`, title: `cartão ${k}`, status: 'blocked', assignee: `p_${k}` }));
    makeDb(
      path,
      tasks,
      Object.entries(reasons).map(([k, reason]) => [`t_${k}`, 'blocked', { reason }, S - 120] as [string, string, unknown, number]),
    );
    const db = openReadOnly(path);
    const by = pickCards(readBoard(db, 'hermes-lab', NOW).cards);
    db.close();
    for (const k of ['conflito', 'merge', 'reatribui', 'correcao', 'soul', 'tag']) expect(by.get(`p_${k}`), k).toMatchObject({ state: 'internal' });
    expect(by.get('p_conflito')!.reason).toBe('conflito com a main');
    expect(by.get('p_humano')).toMatchObject({ state: 'blocked', reason: 'falta a senha do banco.' });
  });

  it('internalBlock: PR esperando merge só é interno nos boards do automerge (como no nanny)', () => {
    const r = 'O que travou: falta mergear o PR #7.\nVocê faz: clique em Merge.';
    expect(internalBlock('openfinance', r)).toBe('PR aprovado esperando merge');
    expect(internalBlock('default', r)).toBeUndefined();
    expect(internalBlock('default', undefined)).toBeUndefined();
    expect(internalBlock('default', 'O que travou: conflito com a origin/main no PR #3')).toBe('conflito com a main');
    expect(internalBlock('default', 'O que travou: preciso que você escolha a cor.')).toBeUndefined();
  });

  it('firstLine corta o rótulo e a linha', () => {
    expect(firstLine('O que travou: a porta.\nVocê faz: x')).toBe('a porta.');
    expect(firstLine('\n\n  só isto ')).toBe('só isto');
    expect(firstLine(undefined)).toBeUndefined();
  });
});

describe('HermesSource no escritório', () => {
  function makeOffice(): Office {
    return new Office({
      names: new NameStore(null),
      version: '9.9.9',
      startedAt: NOW,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      now: () => NOW,
    });
  }

  it('um personagem por perfil, na sala do board, com o estado do cartão; some quando não tem mais nada', () => {
    fixtureRoot(tmp.dir);
    const office = makeOffice();
    const src = new HermesSource({ office, root: tmp.dir, now: () => NOW });
    src.poll();
    const byName = new Map(office.list().map((a) => [a.name, a]));
    expect(byName.get('dev')).toMatchObject({ provider: 'hermes', status: 'working', title: 'Fonte hermes do escritório', hermes: { state: 'running' } });
    expect(byName.get('architect')).toMatchObject({ status: 'waiting', waitingFor: 'falta escolher a porta.', hermes: { state: 'blocked' } });
    expect(byName.get('reviewer')).toMatchObject({ status: 'waiting', hermes: { state: 'guarded', board: 'openhealth' } });
    expect(byName.get('devgemini')).toMatchObject({ status: 'working', hermes: { state: 'delivering' } });
    expect(byName.get('qa')).toMatchObject({ status: 'idle' });
    expect(byName.get('qa')!.hermes).toBeUndefined();
    expect(office.roomName(byName.get('reviewer')!.roomId)).toBe('openhealth');
    expect(src.sources().map((s) => [s.label, s.sessions, s.ok])).toEqual([
      ['default', 3, true],
      ['openhealth', 3, true],
    ]);
    expect(byName.get('judge')).toMatchObject({ status: 'idle' });

    // Tudo some do kanban: os personagens saem.
    rmSync(join(tmp.dir, 'kanban.db'));
    rmSync(join(tmp.dir, 'kanban'), { recursive: true });
    src.poll();
    expect(office.list().every((a) => a.status === 'offline')).toBe(true);
  });

  it('bloqueio interno: personagem trabalhando (sem mão), atividade "Manager resolvendo"', () => {
    makeDb(
      join(tmp.dir, 'kanban', 'boards', 'hermes-lab', 'kanban.db'),
      [{ id: 't_pr', title: 'PR #38', status: 'blocked', assignee: 'reviewer' }],
      [['t_pr', 'blocked', { reason: 'O que travou: o PR #38 está com conflito; quem resolve é o dev.' }, S - 60]],
    );
    const office = makeOffice();
    new HermesSource({ office, root: tmp.dir, now: () => NOW }).poll();
    const a = office.list().find((x) => x.name === 'reviewer')!;
    expect(a).toMatchObject({ status: 'working', hermes: { state: 'internal', reason: 'conflito com a main' } });
    expect(a.waitingFor).toBeUndefined();
    expect(a.activity?.text).toMatch(/^Manager resolvendo/);
  });

  it('GET /api/snapshot mostra os 4 estados', async () => {
    fixtureRoot(tmp.dir);
    const office = new Office({
      names: new NameStore(null),
      version: '9.9.9',
      startedAt: Date.now(),
      accounts: () => [],
      sources: () => src.sources(),
      accountName: () => undefined,
    });
    const src = new HermesSource({ office, root: tmp.dir, now: () => NOW });
    src.poll();
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => office.markDirty() });
    const api = createApiHandler({ office, hub, accounts, sources: () => src.sources(), version: '9.9.9', inDocker: false });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const port = (server.address() as AddressInfo).port;
      const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as OfficeSnapshot;
      const states = Object.fromEntries(snap.agents.filter((a) => a.hermes).map((a) => [a.name, a.hermes!.state]));
      expect(states).toEqual({ dev: 'running', architect: 'blocked', reviewer: 'guarded', devgemini: 'delivering' });
      expect(snap.rooms.map((r) => r.name).sort()).toEqual(['default', 'openhealth']);
      expect(snap.meta.sources.filter((s) => s.provider === 'hermes').length).toBe(2);
    } finally {
      hub.stop();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
