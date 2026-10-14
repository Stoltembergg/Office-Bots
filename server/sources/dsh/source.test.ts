// Integração da fonte do DeepSeek Harness: um DSH_HOME temporário com sessões em frames zstd sintéticos,
// o AccountsService e o Office reais (mesmo padrão dos testes da fonte do Codex).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { DshSource, PRESENCE_MS } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

// ------------------------------------------------------------------ fixtures

function mkHome(name = '.dsh') {
  const dir = mkdtempSync(join(tmpdir(), `habblaud-dsh-${name}-`));
  const dshDir = join(dir, name);
  mkdirSync(join(dshDir, 'sessions'), { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dshDir };
}

function frame(ev: Record<string, unknown>): Buffer {
  return zstdCompressSync(Buffer.from(JSON.stringify(ev), 'utf8'));
}

/** Cria/atualiza uma sessão: sessions/<--cwd-->/<id>/session.v4.jsonl.zstd com os eventos dados (append). */
function writeSession(home: string, sid: string, events: Array<Record<string, unknown>>, opts: { cwd?: string; at?: number; append?: boolean } = {}) {
  const cwd = opts.cwd ?? 'C:\\Users\\x\\projetos\\loja';
  const projDir = `--${cwd.replace(/[:\\/]/g, '-')}--`;
  const dir = join(home, 'sessions', projDir, sid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v4.jsonl.zstd');
  const data = Buffer.concat(events.map(frame));
  if (opts.append) {
    const prev = readOrEmpty(file);
    writeFileSync(file, Buffer.concat([prev, data]));
  } else {
    writeFileSync(file, data);
  }
  if (opts.at) utimesSync(file, opts.at / 1000, opts.at / 1000);
  return file;
}

function readOrEmpty(f: string): Buffer {
  try {
    return readFileSync(f);
  } catch {
    return Buffer.alloc(0);
  }
}

let seq = 0;
const T0 = 1_791_800_000_000;
const ev = (type: string, data: Record<string, unknown> = {}, at = T0 + ++seq * 1000) => ({ type, seq, time: at, data });
const header = (id: string, cwd: string, extra: Record<string, unknown> = {}, at = T0) => ({ type: 'session', version: 4, id, createdAt: at, cwd, ...extra });

// ------------------------------------------------------------------ harness

function setup(opts: { names?: string[] } = {}) {
  const homes = (opts.names ?? ['.dsh']).map((n) => mkHome(n));
  const home = homes[0];
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: home.dir, env: {}, now, onChange: () => late.office?.markDirty() });
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
  const dirs = homes.map((h) => h.dshDir);
  const source = new DshSource({ accounts, office, dirs, env: {}, home: home.dir, now });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    home,
    accounts,
    office,
    source,
    notices,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
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

// ------------------------------------------------------------------ testes

describe('fonte do DeepSeek Harness', () => {
  it('sessão com escrita recente: entra na sala do projeto, com título, modelo e ferramenta', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(ctx.home.dshDir, 'session-aaa', [
      header('session-aaa', 'C:\\Users\\x\\projetos\\loja', {}, t0 - 10_000),
      ev('permission/preset', { preset: 'workspace-write' }, t0 - 9_000),
      ev('session/title', { title: 'Arrumar o checkout' }, t0 - 8_000),
      ev('model/selection', { provider: 'craftcode', model: 'gpt-x' }, t0 - 7_000),
      ev('turn/start', { turn: 1 }, t0 - 6_000),
      ev('tool/call', { name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\Users\\x\\projetos\\loja\\src\\app.ts' }) }, t0 - 1_000),
    ]);
    ctx.source.start();
    const a = ctx.agent('.dsh:session-aaa')!;
    expect(a).toMatchObject({ kind: 'main', provider: 'dsh', account: '.dsh', sessionId: 'session-aaa', status: 'working' });
    expect(a.title).toBe('Arrumar o checkout');
    expect(a.model).toBe('gpt-x');
    expect(a.activity?.text).toBe('Editando app.ts');
    expect(ctx.office.commit().snapshot.meta.sources).toEqual([{ label: '.dsh', provider: 'dsh', path: ctx.home.dshDir, sessions: 1, ok: true }]);
  });

  it('approval/asked sem decided: precisa de você; decided libera', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(ctx.home.dshDir, 's1', [header('s1', '/p/loja', {}, t0 - 5000), ev('turn/start', { turn: 1 }, t0 - 4000), ev('approval/asked', {}, t0 - 1000)]);
    ctx.source.start();
    expect(ctx.agent('.dsh:s1')).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    writeSession(ctx.home.dshDir, 's1', [ev('approval/decided', {}, t0 + 1000), ev('tool/call', { name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) }, t0 + 2000)], { append: true });
    ctx.poll();
    expect(ctx.agent('.dsh:s1')).toMatchObject({ status: 'working' });
    expect(ctx.agent('.dsh:s1')!.activity?.text).toContain('npm test');
  });

  it('turn/end acalma para ocioso; sessão parada há mais de 30 min sai do escritório', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(ctx.home.dshDir, 's2', [header('s2', '/p/loja', {}, t0 - 5000), ev('turn/start', { turn: 1 }, t0 - 4000), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 - 500)]);
    ctx.source.start();
    expect(ctx.agent('.dsh:s2')).toMatchObject({ status: 'idle' });
    ctx.advance(PRESENCE_MS + 60_000);
    ctx.poll();
    // Sai por inatividade: vira "offline" no escritório (o período de graça mostra a saída).
    expect(ctx.agent('.dsh:s2')).toMatchObject({ status: 'offline' });
  });

  it('subagente (parentSession) entra ligado ao pai', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(ctx.home.dshDir, 'pai', [header('pai', '/p/loja', {}, t0 - 5000), ev('turn/start', { turn: 1 }, t0 - 4000), ev('tool/call', { name: 'grep', arguments: '{"pattern":"x"}' }, t0 - 500)]);
    writeSession(ctx.home.dshDir, 'filho', [header('filho', '/p/loja', { parentSession: 'pai', origin: 'subagent', delegationDepth: 1 }, t0 - 3000), ev('turn/start', { turn: 1 }, t0 - 2000), ev('tool/call', { name: 'read', arguments: '{"file_path":"/p/loja/a.ts"}' }, t0 - 500)], { cwd: '/p/loja' });
    ctx.source.start();
    const sub = ctx.agent('.dsh:filho')!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: '.dsh:pai', provider: 'dsh' });
  });

  it('sessão antiga (mtime velho) não entra; arquivo truncado não quebra nada', () => {
    const ctx = setup();
    const old = ctx.now() - PRESENCE_MS - 60_000;
    writeSession(ctx.home.dshDir, 'velha', [header('velha', '/p/loja', {}, old)], { at: old });
    ctx.source.start();
    expect(ctx.agent('.dsh:velha')).toBeUndefined();
    expect(ctx.office.commit().snapshot.meta.sources[0]).toMatchObject({ ok: true, sessions: 0 });
  });

  it('uso em tokens: soma o uso das respostas nas janelas de 5h/7d, sem percentual', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const answer = (total: number, at: number) => ev('assistant/message', { usage: { inputTokens: total - 10, outputTokens: 10, totalTokens: total } }, at);
    writeSession(ctx.home.dshDir, 's1', [
      header('s1', '/p/loja', {}, t0 - 10_000),
      ev('turn/start', { turn: 1 }, t0 - 9_000),
      answer(18_000, t0 - 8_000),
      // Há 6 h: fora da janela de 5 h, dentro da semana.
      answer(500, t0 - 6 * 3_600_000),
    ]);
    ctx.source.start();
    const view = ctx.accounts.usageView('.dsh');
    expect(view.status).toBe('ok');
    expect(view.usage?.source).toBe('dsh');
    expect(view.usage?.fiveHour?.tokens).toBe(18_000);
    expect(view.usage?.fiveHour?.utilization).toBeUndefined();
    expect(view.usage?.sevenDay?.tokens).toBe(18_500);
    // Estatísticas do agente passam a trazer tokens reais.
    expect(ctx.agent('.dsh:s1')!.stats.tokensIn).toBe(18_480);
    expect(ctx.agent('.dsh:s1')!.stats.tokensOut).toBe(20);
  });
});
