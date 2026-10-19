// Parser do store.db do Cursor Agent → Activity (linha do tempo do drawer) + estatísticas.
// MVP: só blobs JSON plaintext; blobs binários (árvore cifrada) são ignorados.
// Tokens por sessão não vêm nos blobs plaintext (ficam na árvore cifrada) — tokensIn/Out ficam 0.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describePrompt, describeTool, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { Activity, AgentStats, TaskItem, TaskStatus } from '../../../shared/types';

export interface CursorStoreParseOptions {
  /** Prefixo dos ids de Activity (ex.: `.cursor:chatId`). */
  idPrefix?: string;
  /** Só blobs com `rowid` maior que este valor (poll incremental). */
  afterRowId?: number;
  /** Âncora do fim da linha do tempo (meta.json `updatedAtMs` ou agora). */
  endAtMs?: number;
  /** Limite de atividades retornadas (mais recentes). Default: sem corte no parse completo. */
  limit?: number;
}

export interface CursorStoreParseResult {
  activities: Activity[];
  /** Maior `rowid` visto (para o próximo poll). */
  maxRowId: number;
  stats: AgentStats;
  model?: string;
  /** Modo de aprovação do Cursor, já mapeado para rótulos do drawer (ex.: bypassPermissions). */
  permissionMode?: string;
  tasks: TaskItem[];
}

interface BlobRow {
  rowid: number;
  data: Buffer | Uint8Array | string;
}

function asBuffer(data: BlobRow['data']): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  return Buffer.from(data);
}

function tryParseJson(buf: Buffer): unknown | undefined {
  if (buf.length < 2) return undefined;
  const c0 = buf[0];
  if (c0 !== 0x7b /* { */ && c0 !== 0x5b /* [ */) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

function normalizeToolCallId(raw: string): string {
  const first = raw.split(/\r?\n/)[0]?.trim() || raw.trim();
  if (first.length <= 80 && /^[\w.:/-]+$/.test(first)) return first;
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function extractUserQuery(text: string): string | undefined {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m?.[1]?.trim()) return m[1].trim();
  // Ignora envelopes de sistema / contexto injetado.
  if (/^\s*<(?:user_info|agent_transcripts|hooks_context|system_reminder)\b/i.test(text)) return undefined;
  if (/^\s*<timestamp>/i.test(text) && !/<user_query>/i.test(text)) return undefined;
  const t = text.trim();
  if (!t || t.length < 2) return undefined;
  if (t.length > 4000) return t.slice(0, 4000);
  return t;
}

function mapToolName(name: string): string {
  switch (name) {
    case 'Shell':
      return 'Bash';
    case 'StrReplace':
      return 'Edit';
    case 'Delete':
      return 'Edit';
    case 'AskQuestion':
      return 'AskUserQuestion';
    default:
      return name;
  }
}

function normalizeArgs(name: string, args: unknown): Record<string, unknown> {
  const input = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
  if (name === 'Glob' || mapToolName(name) === 'Glob') {
    if (typeof input.glob_pattern === 'string' && !input.pattern) input.pattern = input.glob_pattern;
  }
  return input;
}

function describeCursorTool(toolName: string, args: unknown): ActivityDescription {
  const mapped = mapToolName(toolName);
  return describeTool(mapped, normalizeArgs(toolName, args));
}

function textFromContentPart(part: Record<string, unknown>): string | undefined {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return undefined;
}

function isErrorResult(part: Record<string, unknown>): boolean {
  if (part.isError === true || part.error === true) return true;
  const st = part.status;
  if (typeof st === 'string' && /^(error|failed|failure)$/i.test(st)) return true;
  return false;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function countEditLines(toolName: string, args: unknown): { added: number; removed: number } {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (toolName === 'StrReplace') {
    const oldS = typeof input.old_string === 'string' ? input.old_string : '';
    const newS = typeof input.new_string === 'string' ? input.new_string : '';
    return { added: lineCount(newS), removed: lineCount(oldS) };
  }
  if (toolName === 'Write') {
    const contents = typeof input.contents === 'string' ? input.contents : '';
    return { added: lineCount(contents), removed: 0 };
  }
  if (toolName === 'Delete') return { added: 0, removed: 1 };
  return { added: 0, removed: 0 };
}

/** approvalMode do Cursor → valor que o drawer já traduz (permissionLabel). */
export function mapCursorApprovalMode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  switch (raw) {
    case 'unrestricted':
      return 'bypassPermissions';
    case 'default':
      return 'default';
    case 'allowlist':
    case 'ask':
      return 'default';
    default:
      return raw;
  }
}

function mapTodoStatus(raw: unknown): TaskStatus {
  if (typeof raw !== 'string') return 'pending';
  const s = raw.toLowerCase();
  if (s.includes('in_progress') || s.includes('in-progress') || s === 'doing') return 'in_progress';
  if (s.includes('completed') || s.includes('complete') || s === 'done') return 'completed';
  return 'pending';
}

function todosToTasks(raw: unknown): TaskItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskItem[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const t = item as Record<string, unknown>;
    const title = typeof t.content === 'string' ? t.content : typeof t.title === 'string' ? t.title : undefined;
    if (!title?.trim()) return;
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : String(i + 1);
    out.push({ id, title: truncate(title.trim(), 120), status: mapTodoStatus(t.status) });
  });
  return out;
}

function extractTodosFromMessage(msg: Record<string, unknown>): TaskItem[] | undefined {
  const po = msg.providerOptions;
  if (!po || typeof po !== 'object') return undefined;
  const cursor = (po as Record<string, unknown>).cursor;
  if (!cursor || typeof cursor !== 'object') return undefined;
  const hl = (cursor as Record<string, unknown>).highLevelToolCallResult;
  if (!hl || typeof hl !== 'object') return undefined;
  const output = (hl as Record<string, unknown>).output;
  if (!output || typeof output !== 'object') return undefined;
  const success = (output as Record<string, unknown>).success;
  if (!success || typeof success !== 'object') return undefined;
  const todos = (success as Record<string, unknown>).todos;
  const tasks = todosToTasks(todos);
  return tasks.length ? tasks : undefined;
}

function extractModelFromPart(part: Record<string, unknown>): string | undefined {
  const po = part.providerOptions;
  if (!po || typeof po !== 'object') return undefined;
  const cursor = (po as Record<string, unknown>).cursor;
  if (!cursor || typeof cursor !== 'object') return undefined;
  const name = (cursor as Record<string, unknown>).modelName;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function decodeStoreMetaValue(value: Buffer): Record<string, unknown> | undefined {
  const asText = value.toString('utf8');
  try {
    if (asText.startsWith('{')) {
      const j = JSON.parse(asText);
      return j && typeof j === 'object' ? (j as Record<string, unknown>) : undefined;
    }
    if (/^[0-9a-f]+$/i.test(asText) && asText.length % 2 === 0) {
      const j = JSON.parse(Buffer.from(asText, 'hex').toString('utf8'));
      return j && typeof j === 'object' ? (j as Record<string, unknown>) : undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readStoreSessionMeta(db: DatabaseSync): { permissionMode?: string; model?: string } {
  try {
    const row = db.prepare('SELECT value FROM meta LIMIT 1').get() as { value?: Buffer | Uint8Array | string } | undefined;
    if (!row?.value) return {};
    const decoded = decodeStoreMetaValue(asBuffer(row.value));
    if (!decoded) return {};
    const out: { permissionMode?: string; model?: string } = {};
    const approval = mapCursorApprovalMode(typeof decoded.approvalMode === 'string' ? decoded.approvalMode : undefined);
    if (approval) out.permissionMode = approval;
    if (typeof decoded.lastUsedModel === 'string' && decoded.lastUsedModel.trim() && decoded.lastUsedModel !== 'default') {
      out.model = decoded.lastUsedModel.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Lê `store.db` do Cursor (readonly) e emite Activities + estatísticas a partir dos blobs JSON plaintext.
 */
export function parseCursorStore(storePath: string, opts: CursorStoreParseOptions = {}): CursorStoreParseResult {
  const idPrefix = opts.idPrefix ?? 'cursor';
  const afterRowId = opts.afterRowId ?? 0;
  const endAtMs = opts.endAtMs ?? Date.now();
  const empty: CursorStoreParseResult = {
    activities: [],
    maxRowId: afterRowId,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    tasks: [],
  };

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
  } catch {
    return empty;
  }

  const raw: Activity[] = [];
  let maxRowId = afterRowId;
  let toolCalls = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let model: string | undefined;
  let permissionMode: string | undefined;
  let tasks: TaskItem[] = [];
  const pendingNames = new Map<string, string>();

  try {
    const session = readStoreSessionMeta(db);
    permissionMode = session.permissionMode;
    model = session.model;

    const rows = db
      .prepare(
        afterRowId > 0
          ? 'SELECT rowid, data FROM blobs WHERE rowid > ? ORDER BY rowid ASC'
          : 'SELECT rowid, data FROM blobs ORDER BY rowid ASC',
      )
      .all(...(afterRowId > 0 ? [afterRowId] : [])) as unknown as BlobRow[];

    for (const row of rows) {
      if (row.rowid > maxRowId) maxRowId = row.rowid;
      const json = tryParseJson(asBuffer(row.data));
      if (!json || typeof json !== 'object') continue;
      const msg = json as Record<string, unknown>;
      const role = typeof msg.role === 'string' ? msg.role : undefined;

      const fromHl = extractTodosFromMessage(msg);
      if (fromHl) tasks = fromHl;

      // user/system com content string
      if (typeof msg.content === 'string') {
        if (role === 'user') {
          const q = extractUserQuery(msg.content);
          if (q) {
            const desc = describePrompt(q);
            raw.push({
              id: `${idPrefix}#r${row.rowid}:prompt`,
              at: 0,
              kind: desc.kind,
              icon: desc.icon,
              text: desc.text,
              ...(desc.detail ? { detail: desc.detail } : {}),
            });
          }
        }
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      let partIdx = 0;
      for (const part of msg.content as unknown[]) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        const type = typeof p.type === 'string' ? p.type : undefined;
        const suffix = `:r${row.rowid}:i${partIdx++}`;

        const partModel = extractModelFromPart(p);
        if (partModel) model = partModel;

        if (type === 'tool-call') {
          const toolName = typeof p.toolName === 'string' ? p.toolName : 'ferramenta';
          const rawId = typeof p.toolCallId === 'string' ? p.toolCallId : `${row.rowid}-${partIdx}`;
          const toolCallId = normalizeToolCallId(rawId);
          const desc = describeCursorTool(toolName, p.args);
          toolCalls++;
          const lines = countEditLines(toolName, p.args);
          linesAdded += lines.added;
          linesRemoved += lines.removed;
          pendingNames.set(toolCallId, toolName);
          if (toolName === 'TodoWrite' || toolName === 'TodoWriteTool') {
            const t = todosToTasks((p.args as Record<string, unknown> | undefined)?.todos);
            if (t.length) tasks = t;
          }
          raw.push({
            id: `${idPrefix}#${toolCallId}`,
            at: 0,
            kind: desc.kind,
            icon: desc.icon,
            text: desc.text,
            tool: toolName,
            ...(desc.detail ? { detail: desc.detail } : {}),
            ...(desc.questions?.length ? { questions: desc.questions } : {}),
          });
          continue;
        }

        if (type === 'tool-result') {
          const rawId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
          if (!rawId) continue;
          const toolCallId = normalizeToolCallId(rawId);
          const name = pendingNames.get(toolCallId);
          if (isErrorResult(p)) {
            const desc = SPECIAL.error(name);
            raw.push({
              id: `${idPrefix}#${toolCallId}:err`,
              at: 0,
              kind: desc.kind,
              icon: desc.icon,
              text: desc.text,
              error: true,
              ...(name ? { tool: name } : {}),
              ...(desc.detail ? { detail: desc.detail } : {}),
            });
          }
          continue;
        }

        if (type === 'text' && role === 'user') {
          const text = textFromContentPart(p);
          if (!text?.trim()) continue;
          const q = extractUserQuery(text);
          if (!q) continue;
          const desc = describePrompt(q);
          raw.push({
            id: `${idPrefix}${suffix}:prompt`,
            at: 0,
            kind: desc.kind,
            icon: desc.icon,
            text: desc.text,
            ...(desc.detail ? { detail: desc.detail } : {}),
          });
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  // Dedup por id (mesmo toolCallId pode reaparecer se o blob for regravado).
  const seen = new Set<string>();
  const unique: Activity[] = [];
  for (const a of raw) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    unique.push(a);
  }

  const n = unique.length;
  for (let i = 0; i < n; i++) {
    unique[i] = { ...unique[i]!, at: endAtMs - (n - 1 - i) * 500 };
  }

  let activities = unique;
  if (opts.limit !== undefined && opts.limit >= 0 && activities.length > opts.limit) {
    activities = activities.slice(-opts.limit);
  }

  const stats: AgentStats = {
    toolCalls,
    tokensIn: 0,
    tokensOut: 0,
    subagents: 0,
  };
  if (linesAdded || linesRemoved) {
    stats.linesAdded = linesAdded;
    stats.linesRemoved = linesRemoved;
  }

  return {
    activities,
    maxRowId,
    stats,
    tasks,
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}
