// Integração da fonte do Cursor: ~/.cursor/chats temporário (meta.json sintético), AccountsService e Office.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function setup(presenceMs?: number) {
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
  const source = new CursorSource({ accounts, office, roots: [root], now, presenceMs });
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

  it('janela de presença de HABBLAUD_IDLE_LEAVE_MIN (presenceMs) no lugar de CURSOR_RECENT_MS', () => {
    const ctx = setup(30 * 60_000);
    ctx.chat('chat-1', { updatedAtMs: ctx.now() - 10_000, cwd: '/p/a' });
    ctx.source.start();
    ctx.advance(CURSOR_RECENT_MS + 60_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(KEY)?.status).toBe('idle');
    ctx.advance(30 * 60_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(KEY)?.status).toBe('offline');
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

  it('store.db: linha do tempo e estatísticas (tools, linhas, modelo, permissões)', () => {
    const ctx = setup();
    const dir = ctx.chat('chat-1', {
      updatedAtMs: ctx.now(),
      createdAtMs: ctx.now() - 60_000,
      cwd: '/projetos/loja',
      title: 'Carrinho',
    });
    const db = new DatabaseSync(join(dir, 'store.db'));
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB);');
    const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    ins.run(
      'b1',
      Buffer.from(
        JSON.stringify({
          role: 'user',
          content: [{ type: 'text', text: '<user_query>\nCorrigir o carrinho\n</user_query>' }],
        }),
      ),
    );
    ins.run(
      'b2',
      Buffer.from(
        JSON.stringify({
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'Read',
              args: { path: '/projetos/loja/Cart.ts' },
              providerOptions: { cursor: { modelName: 'grok-4.7-high-fast' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'Shell',
              args: { command: 'npm test', description: 'Testes' },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-3',
              toolName: 'Write',
              args: { path: '/projetos/loja/Cart.ts', contents: 'line1\nline2\nline3\n' },
            },
          ],
        }),
      ),
    );
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(JSON.stringify({ approvalMode: 'unrestricted', lastUsedModel: 'default' })).toString('hex'),
    );
    db.close();
    utimesSync(join(dir, 'store.db'), new Date(), new Date());

    ctx.source.start();
    const a = ctx.agent(KEY)!;
    expect(a.title).toBe('Carrinho');
    expect(a.startedAt).toBe(ctx.now() - 60_000);
    expect(a.stats?.toolCalls).toBe(3);
    expect(a.stats?.linesAdded).toBe(4);
    expect(a.model).toBe('grok-4.7-high-fast');
    expect(a.permissionMode).toBe('bypassPermissions');
    expect(a.activity?.kind).toBe('write');
    expect(a.recent.some((x) => x.kind === 'prompt')).toBe(true);
    expect(a.recent.some((x) => x.kind === 'read' && /Cart\.ts/.test(x.text))).toBe(true);
    expect(a.recent.some((x) => x.tool === 'Shell')).toBe(true);
  });

  it('poll de uso grava Cursor Models / Other Models na conta .cursor', async () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const authPath = join(tmp.dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ accessToken: 'test-token' }));
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
    const source = new CursorSource({
      accounts,
      office,
      roots: [root],
      now,
      authPath,
      fetch: async () =>
        new Response(
          JSON.stringify({
            enabled: true,
            billingCycleEnd: clock + 86_400_000,
            planUsage: { autoPercentUsed: 21, apiPercentUsed: 55 },
          }),
          { status: 200 },
        ),
    });
    cleanups.unshift(() => source.stop());
    source.start();
    await new Promise((r) => setTimeout(r, 20));
    const info = accounts.list(new Map())[0];
    expect(info).toMatchObject({
      id: '.cursor',
      usageStatus: 'ok',
      usage: {
        source: 'cursor',
        fiveHour: { utilization: 21 },
        sevenDay: { utilization: 55 },
      },
    });
  });
});
