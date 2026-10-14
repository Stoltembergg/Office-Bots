// Integração da fonte do OpenCode: uma pasta de dados temporária com um opencode.db sintético (session_v2),
// o AccountsService e o Office reais.
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpencodeSource, PRESENCE_MS } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

interface DbHandle {
  dir: string;
  db: DatabaseSync;
}

function mkData(): DbHandle {
  const base = mkdtempSync(join(tmpdir(), 'habblaud-oc-'));
  const dir = join(base, 'opencode');
  mkdirSync(dir);
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, title TEXT,
    directory TEXT, agent TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
    time_created INTEGER, time_updated INTEGER, time_idle INTEGER, time_archived INTEGER
  )`);
  cleanups.push(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  // WAL desligado no fixture (o sem o banco aberto por outro processo): arquivos -wal presentes no igual.
  return { dir, db };
}

function insertSession(h: DbHandle, s: { id: string; parent?: string | null; title?: string; directory?: string; agent?: string; model?: string; updated: number; created?: number; idle?: number | null }) {
  h.db
    .prepare(
      `INSERT INTO session_v2 (id, project_id, parent_id, title, directory, agent, model, cost, tokens_input, tokens_output, time_created, time_updated, time_idle, time_archived)
       VALUES (?, 'p1', ?, ?, ?, ?, ?, 0.01, 1200, 300, ?, ?, ?, NULL)`,
    )
    .run(s.id, s.parent ?? null, s.title ?? null, s.directory ?? '/p/loja', s.agent ?? 'build', s.model ?? JSON.stringify({ id: 'gpt-test', providerID: 'opencode' }), s.created ?? s.updated - 60_000, s.updated, s.idle ?? null);
}

function touchDb(h: DbHandle): void {
  const dbPath = join(h.dir, 'opencode.db');
  h.db.exec('PRAGMA wal_checkpoint(FULL)');
  dbCheckpoint(h);
  const now = Date.now() / 1000;
  utimesSync(dbPath, now, now);
}

/** Touca o mtime dos outros arquivos também (mtime do -wal é o que vale para leituras seguintes). */
function dbCheckpoint(h: DbHandle): void {
  const now = Date.now() / 1000;
  for (const suffix of ['opencode.db-wal', 'opencode.db-shm']) {
    try {
      utimesSync(join(h.dir, suffix), now, now);
    } catch {
      // sem wal no fixture
    }
  }
}

function updateSession(h: DbHandle, id: string, fields: { updated?: number; idle?: number | null }) {
  if (fields.updated !== undefined) h.db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(fields.updated, id);
  if (fields.idle !== undefined) h.db.prepare('UPDATE session_v2 SET time_idle = ? WHERE id = ?').run(fields.idle, id);
}

function setup() {
  const data = mkData();
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: data.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => source.sources(),
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new OpencodeSource({ accounts, office, dirs: [data.dir], env: {}, home: data.dir, now });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    data,
    accounts,
    office,
    source,
    notices,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll(false);
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id: string) {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
}

describe('fonte do OpenCode', () => {
  it('sessão atualizada agora: entra trabalhando, com título, modelo e tokens', () => {
    const ctx = setup();
    insertSession(ctx.data, { id: 'ses_1', title: 'Converter landing', directory: 'C:/x/loja', updated: ctx.now() - 1_000 });
    ctx.source.start();
    const a = ctx.agent('opencode:ses_1')!;
    expect(a).toMatchObject({ kind: 'main', provider: 'opencode', account: 'opencode', sessionId: 'ses_1', status: 'working', role: 'Agente principal (OpenCode)' });
    expect(a.title).toBe('Converter landing');
    expect(a.model).toBe('gpt-test');
    expect(a.stats.tokensIn).toBe(1200);
    expect(a.stats.tokensOut).toBe(300);
    expect(a.stats.costUSD).toBeCloseTo(0.01);
  });

  it('sem updates recentes fica ociosa; velha demais sai do escritório; subagente liga ao pai', () => {
    const ctx = setup();
    insertSession(ctx.data, { id: 'ses_pai', title: 'Principal', updated: ctx.now() - 200_000, idle: ctx.now() - 195_000 });
    insertSession(ctx.data, { id: 'ses_sub', parent: 'ses_pai', title: 'Explorar', agent: 'explore', updated: ctx.now() - 200_000, created: ctx.now() - 300_000 });
    ctx.source.start();
    expect(ctx.agent('opencode:ses_pai')).toMatchObject({ status: 'idle', kind: 'main' });
    const sub = ctx.agent('opencode:ses_sub');
    expect(sub).toMatchObject({ kind: 'sub', parentId: 'opencode:ses_pai', provider: 'opencode' });
    expect(sub!.role).toContain('Explore');

    // Volta a trabalhar quando o banco registra update novo.
    updateSession(ctx.data, 'ses_pai', { updated: ctx.now() });
    ctx.poll();
    expect(ctx.agent('opencode:ses_pai')).toMatchObject({ status: 'working' });

    // Parada além da janela: sai.
    ctx.advance(PRESENCE_MS + 60_000);
    ctx.poll();
    expect(ctx.agent('opencode:ses_pai')).toMatchObject({ status: 'offline' });
  });

  it('uso em tokens: deltas das sessões por janela, sem percentual de cota', () => {
    const ctx = setup();
    insertSession(ctx.data, { id: 'ses_1', directory: 'C:/x/loja', updated: ctx.now() - 1_000 });
    ctx.poll();
    // Primeira leitura: só anota a base (1200+300), sem delta.
    let view = ctx.accounts.usageView('opencode');
    expect(view.status).toBe('ok');
    expect(view.usage?.source).toBe('opencode');
    expect(view.usage?.fiveHour?.tokens).toBe(0);
    expect(view.usage?.fiveHour?.utilization).toBeUndefined();

    // A sessão usa mais 5000 tokens (+US$ 0,05): o delta cai na janela de 5h e na semana.
    ctx.data.db.prepare('UPDATE session_v2 SET tokens_input = tokens_input + 5000, cost = cost + 0.05, time_updated = ? WHERE id = ?').run(ctx.now(), 'ses_1');
    ctx.advance(2_000);
    ctx.poll();
    view = ctx.accounts.usageView('opencode');
    expect(view.usage?.fiveHour?.tokens).toBe(5000);
    expect(view.usage?.fiveHour?.costUSD).toBeCloseTo(0.05, 10);
    expect(view.usage?.sevenDay?.tokens).toBe(5000);
  });
});
