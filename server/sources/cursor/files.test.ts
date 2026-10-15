import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  CURSOR_RECENT_MS,
  discoverCursorRoots,
  isCursorPresent,
  isCursorWorking,
  listCursorChats,
} from './files';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function cursorRoot(home: string, name = '.cursor'): string {
  const root = join(home, name);
  mkdirSync(join(root, 'chats', 'proj-hash', 'chat-1'), { recursive: true });
  return root;
}

function writeMeta(chatDir: string, meta: Record<string, unknown>): void {
  writeFileSync(join(chatDir, 'meta.json'), JSON.stringify(meta));
}

describe('cursor files', () => {
  it('discoverCursorRoots: sem chats/ não descobre', () => {
    const { dir: home, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, 'sem-chats'), { recursive: true });
    expect(discoverCursorRoots({}, home)).toEqual([]);
    expect(discoverCursorRoots({ HABBLAUD_CURSOR_DIRS: join(home, 'sem-chats') }, home)).toEqual([]);
  });

  it('discoverCursorRoots: ~/.cursor com chats/ e override por env', () => {
    const { dir: home, cleanup } = tempDir();
    cleanups.push(cleanup);
    const main = cursorRoot(home);
    const extra = cursorRoot(home, 'cursor-alt');
    expect(discoverCursorRoots({}, home)).toEqual([main]);
    expect(discoverCursorRoots({ HABBLAUD_CURSOR_DIR: extra }, home)).toEqual([extra]);
    expect(discoverCursorRoots({ HABBLAUD_CURSOR_DIRS: `${extra}, ${join(home, 'nao-existe')}` }, home)).toEqual([extra]);
  });

  it('listCursorChats + presença: cwd recente → presente e working', () => {
    const { dir: home, cleanup } = tempDir();
    cleanups.push(cleanup);
    const root = cursorRoot(home);
    const chatDir = join(root, 'chats', 'hash-a', 'chat-recent');
    mkdirSync(chatDir, { recursive: true });
    const now = 1_700_000_000_000;
    const updatedAtMs = now - 60_000;
    writeMeta(chatDir, { updatedAtMs, cwd: '/proj/foo', title: 'Fix bug', isSubagent: false });

    const listed = listCursorChats(root, now);
    expect(listed).toHaveLength(1);
    const recent = listed.find((m) => m.chatId === 'chat-recent');
    expect(recent).toMatchObject({
      chatId: 'chat-recent',
      dir: chatDir,
      cwd: '/proj/foo',
      title: 'Fix bug',
      updatedAtMs,
      isSubagent: false,
    });
    expect(isCursorPresent(recent!, now)).toBe(true);
    expect(isCursorWorking(recent!, now)).toBe(true);
  });

  it('updatedAtMs antigo → não presente', () => {
    const now = 1_700_000_000_000;
    const meta = {
      chatId: 'old',
      dir: '/x/old',
      updatedAtMs: now - CURSOR_RECENT_MS - 1,
      isSubagent: false,
    };
    expect(isCursorPresent(meta, now)).toBe(false);
    expect(isCursorWorking(meta, now)).toBe(false);
  });

  it('isSubagent true ainda entra na listagem; cwd ausente fica undefined', () => {
    const { dir: home, cleanup } = tempDir();
    cleanups.push(cleanup);
    const root = cursorRoot(home);
    const chatDir = join(root, 'chats', 'hash-b', 'sub-1');
    mkdirSync(chatDir, { recursive: true });
    const now = 2_000_000_000_000;
    writeMeta(chatDir, { updatedAtMs: now - 1_000, title: 'Worker', isSubagent: true });

    const listed = listCursorChats(root, now);
    const sub = listed.find((m) => m.chatId === 'sub-1');
    expect(sub?.isSubagent).toBe(true);
    expect(sub?.cwd).toBeUndefined();
    expect('cwd' in sub!).toBe(false);
  });

  it('store.db mtime conta para presença', () => {
    const now = 1_700_000_000_000;
    const meta = {
      chatId: 's',
      dir: '/x/s',
      updatedAtMs: now - CURSOR_RECENT_MS - 1,
      storeMtimeMs: now - 30_000,
      isSubagent: false,
    };
    expect(isCursorPresent(meta, now)).toBe(true);
    expect(isCursorWorking(meta, now)).toBe(true);
    expect(isCursorWorking(meta, now, 10_000)).toBe(false);
  });
});
