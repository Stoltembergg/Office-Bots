// Arquivos do Grok (CLI `grok`, GROK_HOME ou ~/.grok). Node puro e sem dependências do servidor: também é importado
// por scripts/docker-up.ts (via tsx) no host.
//
// - active_sessions.json: as sessões ABERTAS (session_id, pid, cwd, opened_at), mantido pelo próprio Grok;
// - sessions/<cwd codificado>/<session_id>/: uma pasta por sessão, agrupada pela pasta de trabalho (encodeURIComponent
//   do cwd; nome longo demais vira slug + hash, com o caminho original num arquivo `.cwd` do grupo). Dela o Habblaud
//   lê só `updates.jsonl` (a conversa, no formato de updates do ACP) e `summary.json` (título, cwd, horários).
//
// Privacidade: NUNCA lê auth.json, config.toml nem nada fora de active_sessions.json e sessions/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../../accounts/detect';

export const ACTIVE_FILE = 'active_sessions.json';
export const SESSIONS_DIR = 'sessions';
export const UPDATES_FILE = 'updates.jsonl';
export const SUMMARY_FILE = 'summary.json';

/** Id de sessão aceito (UUID do Grok ou o `-s` de um cliente): nada de barra nem `..`. */
export function isGrokSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Pasta do Grok observada: HABBLAUD_GROK_DIR (no Docker, a montada) ou GROK_HOME ou ~/.grok. Só vale se tiver
 * sessions/ ou active_sessions.json (o Grok já rodou ali).
 */
export function discoverGrokDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string | undefined {
  const raw = env.HABBLAUD_GROK_DIR?.trim() || env.GROK_HOME?.trim();
  const dir = raw ? expandHome(raw, home) : join(home, '.grok');
  if (isDir(join(dir, SESSIONS_DIR))) return dir;
  try {
    statSync(join(dir, ACTIVE_FILE));
    return dir;
  } catch {
    return undefined;
  }
}

export interface ActiveSession {
  sessionId: string;
  pid?: number;
  cwd: string;
  openedAt?: number;
}

/** Sessões abertas segundo o Grok. null = arquivo ausente ou ilegível (escrita no meio): o chamador mantém o que tinha. */
export function readActiveSessions(dir: string): ActiveSession[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, ACTIVE_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: ActiveSession[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const sessionId = str(r.session_id);
    const cwd = str(r.cwd);
    if (!sessionId || !cwd || !isGrokSessionId(sessionId)) continue;
    const s: ActiveSession = { sessionId, cwd };
    if (typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0) s.pid = r.pid;
    const opened = str(r.opened_at) ? Date.parse(r.opened_at as string) : NaN;
    if (Number.isFinite(opened)) s.openedAt = opened;
    out.push(s);
  }
  return out;
}

/**
 * Pasta da sessão: primeiro o grupo do cwd (encodeURIComponent, o caso comum), depois os outros grupos (cwd longo
 * demais, que vira slug + hash). undefined = ainda não existe.
 */
export function findSessionDir(dir: string, sessionId: string, cwd?: string): string | undefined {
  if (!isGrokSessionId(sessionId)) return undefined;
  const root = join(dir, SESSIONS_DIR);
  if (cwd) {
    const direct = join(root, encodeURIComponent(cwd), sessionId);
    if (isDir(direct)) return direct;
  }
  let groups: string[];
  try {
    groups = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const g of groups) {
    const p = join(root, g, sessionId);
    if (isDir(p)) return p;
  }
  return undefined;
}

/** Pasta de trabalho de um grupo de sessions/: o nome decodificado, ou o `.cwd` de um nome longo demais. */
export function groupCwd(groupDir: string, name: string): string | undefined {
  try {
    const cwd = readFileSync(join(groupDir, '.cwd'), 'utf8').trim();
    if (cwd) return cwd;
  } catch {
    // sem .cwd: o nome é o cwd codificado
  }
  try {
    const decoded = decodeURIComponent(name);
    return decoded.startsWith('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sessões com a conversa modificada desde `since` (epoch ms), com o cwd do summary.json (ou do nome do grupo). É a
 * presença no Docker: active_sessions.json é trocado por rename (active_sessions.json.tmp), e um bind de arquivo
 * único ficaria preso à versão antiga.
 */
export function recentSessions(dir: string, since: number): ActiveSession[] {
  const root = join(dir, SESSIONS_DIR);
  const out: ActiveSession[] = [];
  let groups: string[];
  try {
    groups = readdirSync(root);
  } catch {
    return [];
  }
  for (const g of groups) {
    const groupDir = join(root, g);
    let ids: string[];
    try {
      ids = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!isGrokSessionId(id)) continue;
      let mtime: number;
      try {
        mtime = statSync(join(groupDir, id, UPDATES_FILE)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since) continue;
      const cwd = readSummary(join(groupDir, id)).cwd ?? groupCwd(groupDir, g);
      if (cwd) out.push({ sessionId: id, cwd, openedAt: mtime });
    }
  }
  return out;
}

export interface GrokSummary {
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  /** `session_kind` ('subagent', 'headless'); ausente = sessão do TUI. Subagentes ficam fora do histórico. */
  kind?: string;
}

/** summary.json da sessão (o índice que o próprio Grok usa no /resume). */
export function readSummary(sessionDir: string): GrokSummary {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(sessionDir, SUMMARY_FILE), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: GrokSummary = {};
  const info = raw.info && typeof raw.info === 'object' ? (raw.info as Record<string, unknown>) : {};
  const title = str(raw.generated_title) ?? str(raw.session_summary);
  if (title) out.title = title;
  const cwd = str(info.cwd);
  if (cwd) out.cwd = cwd;
  const model = str(raw.current_model_id);
  if (model) out.model = model;
  const created = str(raw.created_at) ? Date.parse(raw.created_at as string) : NaN;
  if (Number.isFinite(created)) out.createdAt = created;
  const updated = str(raw.updated_at) ? Date.parse(raw.updated_at as string) : NaN;
  if (Number.isFinite(updated)) out.updatedAt = updated;
  const kind = str(raw.session_kind);
  if (kind) out.kind = kind;
  return out;
}
