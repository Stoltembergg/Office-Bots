// Pastas do Cursor (~/.cursor/chats/...) que a fonte lê: meta.json por conversa e mtime de store.db (sem abrir o SQLite).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome } from '../../accounts/detect';

export const CURSOR_RECENT_MS = 10 * 60_000;
/** Hot window for status `working` (vs idle while still present). */
export const CURSOR_WORKING_MS = 5 * 60_000;

export interface CursorChatMeta {
  chatId: string;
  /** Absolute path to chat directory (contains meta.json / store.db). */
  dir: string;
  title?: string;
  cwd?: string;
  /** Início da conversa (meta.json `createdAtMs`), quando houver. */
  createdAtMs?: number;
  updatedAtMs: number;
  isSubagent: boolean;
  storeMtimeMs?: number;
}

const CHATS = 'chats';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasChatsDir(root: string): boolean {
  return isDir(join(root, CHATS));
}

function cursorOverridePaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const raw = splitList(env.HABBLAUD_CURSOR_DIRS);
  const list = raw.length ? raw : splitList(env.HABBLAUD_CURSOR_DIR);
  return [...new Set(list.map((p) => expandHome(p, home)))];
}

/** Root dirs that contain a `chats/` subdirectory (usually ~/.cursor). */
export function discoverCursorRoots(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = cursorOverridePaths(env, home);
  if (override.length) return override.filter(hasChatsDir);
  const def = join(home, '.cursor');
  return hasChatsDir(def) ? [def] : [];
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMeta(chatDir: string, chatId: string): CursorChatMeta | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(chatDir, 'meta.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rec = parsed as Record<string, unknown>;
  const updatedAtMs = rec.updatedAtMs;
  if (typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)) return undefined;

  const meta: CursorChatMeta = {
    chatId,
    dir: resolve(chatDir),
    updatedAtMs,
    isSubagent: rec.isSubagent === true,
  };
  if (typeof rec.title === 'string' && rec.title.trim()) meta.title = rec.title.trim();
  if (typeof rec.cwd === 'string' && rec.cwd.trim()) meta.cwd = rec.cwd.trim();
  if (typeof rec.createdAtMs === 'number' && Number.isFinite(rec.createdAtMs)) meta.createdAtMs = rec.createdAtMs;

  const storePath = join(chatDir, 'store.db');
  try {
    meta.storeMtimeMs = statSync(storePath).mtimeMs;
  } catch {
    // sem store.db
  }
  return meta;
}

/** All chat metas under root/chats (skips unreadable). */
export function listCursorChats(root: string, _now?: number): CursorChatMeta[] {
  const chatsRoot = join(root, CHATS);
  const out: CursorChatMeta[] = [];
  for (const projectHash of listDir(chatsRoot)) {
    const projectDir = join(chatsRoot, projectHash);
    if (!isDir(projectDir)) continue;
    for (const chatId of listDir(projectDir)) {
      const chatDir = join(projectDir, chatId);
      if (!isDir(chatDir)) continue;
      const meta = readMeta(chatDir, chatId);
      if (meta) out.push(meta);
    }
  }
  return out;
}

function activityMs(meta: CursorChatMeta): number {
  return Math.max(meta.updatedAtMs, meta.storeMtimeMs ?? 0);
}

export function isCursorPresent(meta: CursorChatMeta, now: number, recentMs: number = CURSOR_RECENT_MS): boolean {
  return now - activityMs(meta) <= recentMs;
}

export function isCursorWorking(meta: CursorChatMeta, now: number, workingMs: number = CURSOR_WORKING_MS): boolean {
  return now - activityMs(meta) <= workingMs;
}
