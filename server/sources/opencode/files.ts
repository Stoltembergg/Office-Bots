// Leitura dos arquivos que o plugin do OpenCode escreve. Só leitura, nunca escreve.
//
// O plugin do OpenCode (que roda NATIVO no Windows, onde tem acesso ao banco) grava três coisas na pasta de
// dados, e é disto que a fonte vive — nunca do opencode.db, que exigiria lock de arquivo e falharia no WSL:
//
//   sessions/<sessionId>.jsonl       a conversa, em JSONL no mesmo formato do transcript do Claude Code
//                                    (type: user|assistant|system; blocos text/thinking/tool_use/tool_result),
//                                    para o parser do Claude Code ser reaproveitado sem tradução;
//   open-sessions/<sessionId>.lock   marcador de presença: o arquivo EXISTINDO significa sessão aberta, e o
//                                    mtime é a última atividade (mesma técnica do thread-writer-locks do Codex);
//   sessions/<sessionId>.meta.json   { sessionId, cwd, parentId, agent, model, title, startedAt }.
//
// Tudo opcional e tolerante: arquivo faltando, corrompido ou de outra versão nunca derruba a leitura.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Subpasta com a conversa de cada sessão. */
export const SESSIONS_DIR = 'sessions';
/** Subpasta com os marcadores de presença das sessões abertas. */
export const OPEN_DIR = 'open-sessions';

export interface OpenCodeLock {
  sessionId: string;
  path: string;
  /** mtime do marcador = última atividade conhecida da sessão. */
  at: number;
}

export interface OpenCodeMeta {
  sessionId: string;
  /** Projeto (a pasta em que a sessão está): é dela que sai a sala do escritório. */
  cwd: string;
  /** Sessão que chamou esta (subagente); ausente = sessão principal. */
  parentId?: string;
  /** Agente do OpenCode ("build", "plan"...). */
  agent?: string;
  model?: string;
  title?: string;
  startedAt?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function sessionsDir(dir: string): string {
  return join(dir, SESSIONS_DIR);
}

export function openDir(dir: string): string {
  return join(dir, OPEN_DIR);
}

export function transcriptPath(dir: string, sessionId: string): string {
  return join(sessionsDir(dir), `${sessionId}.jsonl`);
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Sessões abertas: uma entrada por marcador em `open-sessions/`. O nome do arquivo (sem extensão) é o
 * sessionId. Um marcador com nome(video) inválido é ignorado, não derruba a leitura.
 */
export function readLocks(dir: string): OpenCodeLock[] {
  const base = openDir(dir);
  const out: OpenCodeLock[] = [];
  for (const name of readDirNames(base)) {
    if (!name.endsWith('.lock')) continue;
    const sessionId = name.slice(0, -'.lock'.length).trim();
    if (!sessionId) continue;
    const path = join(base, name);
    try {
      const at = statSync(path).mtimeMs;
      if (!Number.isFinite(at)) continue;
      out.push({ sessionId, path, at });
    } catch {
      // someu entre o readdir e o stat
    }
  }
  out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return out;
}

/** Os metadados de uma sessão, ou undefined se ainda não houver (o plugin escreve ao abrir a sessão). */
export function readMeta(dir: string, sessionId: string): OpenCodeMeta | undefined {
  const path = join(sessionsDir(dir), `${sessionId}.meta.json`);
  let raw: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(8 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      raw = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const r = j as Record<string, unknown>;
  const cwd = str(r.cwd);
  // Sem cwd não há sala para o personagem: o resto é inútil.
  if (!cwd) return undefined;
  const meta: OpenCodeMeta = { sessionId: str(r.sessionId) ?? sessionId, cwd };
  const parentId = str(r.parentId);
  if (parentId) meta.parentId = parentId;
  const agent = str(r.agent);
  if (agent) meta.agent = agent;
  const model = str(r.model);
  if (model) meta.model = model;
  const title = str(r.title);
  if (title) meta.title = title;
  const startedAt = num(r.startedAt);
  if (startedAt !== undefined) meta.startedAt = startedAt;
  return meta;
}

/** O arquivo da conversa existe? (sem ele ainda não há nada para mostrar no escritório). */
export function hasTranscript(dir: string, sessionId: string): boolean {
  return existsSync(transcriptPath(dir, sessionId));
}

/** mtime da conversa, para decidir se há o que ler de novo. 0 = ainda não existe. */
export function transcriptMtime(dir: string, sessionId: string): number {
  try {
    return statSync(transcriptPath(dir, sessionId)).mtimeMs;
  } catch {
    return 0;
  }
}

/** As sessões que têm conversa, para o histórico e para a linha do tempo. */
export function listSessionIds(dir: string): string[] {
  const out: string[] = [];
  for (const name of readDirNames(sessionsDir(dir))) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length).trim();
    if (id) out.push(id);
  }
  out.sort((a, b) => b.localeCompare(a));
  return out;
}