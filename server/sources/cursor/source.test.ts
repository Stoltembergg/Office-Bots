// Integração da fonte do Cursor: ~/.cursor/chats temporário (meta.json sintético), AccountsService e Office.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { CURSOR_RECENT_MS } from './files';
import { CursorSource } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const root = join(tmp.dir, '.cursor');
  mkdirSync(join(root, 'chats'), { recursive: true });
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new CursorSource({ accounts, office, roots: [root], now });
  cleanups.unshift(() => source.stop());

  function chat(id: string, meta: Record<string, unknown>, project = 'hash1') {
    const dir = join(root, 'chats', project, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    return dir;
  }
  return {
    root,
    accounts,
    office,
    source,
    chat,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      return office.commit().snapshot.agents;
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
}

const KEY = '.cursor:chat-1';

describe('fonte do Cursor', () => {
  it('chat recente: agente principal na sala do cwd, com título e provider cursor', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now() - 10_000, cwd: '/projetos/loja', title: 'Corrigir o carrinho' });
    ctx.source.start();
    const a = ctx.agent(KEY)!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'cursor',
      account: '.cursor',
      sessionId: 'chat-1',
      roomId: '/projetos/loja',
      role: 'Agente principal (Cursor)',
      title: 'Corrigir o carrinho',
      status: 'working',
    });
    expect(ctx.source.sources()).toEqual([{ label: '.cursor', provider: 'cursor', path: ctx.root, sessions: 1, ok: true }]);
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.cursor', provider: 'cursor', name: 'Cursor', short: 'R' });
  });

  it('presente mas parado há mais que a janela quente: idle', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now() - 10 * 60_000, cwd: '/p/a' });
    ctx.source.start();
    expect(ctx.agent(KEY)?.status).toBe('idle');
  });

  it('passada a janela de presença, o agente sai (com a folga de fechamento)', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now() - 10_000, cwd: '/p/a' });
    ctx.source.start();
    expect(ctx.agent(KEY)).toBeDefined();
    ctx.advance(CURSOR_RECENT_MS + 60_000);
    ctx.poll();
    expect(ctx.agent(KEY)?.status).not.toBe('offline'); // ainda na folga de 1,5 s
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(KEY)?.status).toBe('offline');
    ctx.advance(60_000);
    expect(ctx.poll().find((a) => a.id === KEY)).toBeUndefined();
  });

  it('chat sobrescrito (updatedAtMs novo) volta a ficar presente', () => {
    const ctx = setup();
    const dir = ctx.chat('chat-1', { updatedAtMs: ctx.now() - 10_000, cwd: '/p/a' });
    ctx.source.start();
    ctx.advance(CURSOR_RECENT_MS + 60_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ updatedAtMs: ctx.now(), cwd: '/p/a' }));
    utimesSync(join(dir, 'meta.json'), new Date(), new Date());
    ctx.poll();
    expect(ctx.agent(KEY)?.status).toBe('working');
  });

  it('subagente nunca entra', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now(), cwd: '/p/a', isSubagent: true });
    ctx.source.start();
    expect(ctx.office.commit().snapshot.agents).toEqual([]);
    expect(ctx.source.sources()[0].sessions).toBe(0);
  });

  it('sem cwd não há sala: não entra', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now() });
    ctx.source.start();
    expect(ctx.office.commit().snapshot.agents).toEqual([]);
  });

  it('transcriptPathOf é sempre undefined', () => {
    const ctx = setup();
    ctx.chat('chat-1', { updatedAtMs: ctx.now(), cwd: '/p/a' });
    ctx.source.start();
    expect(ctx.source.transcriptPathOf()).toBeUndefined();
    expect(ctx.source.transcriptPathOf()).toBeUndefined();
  });
});
