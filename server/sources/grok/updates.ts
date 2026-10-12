// Conversa do Grok (`updates.jsonl` da sessão): uma linha por update do ACP, com horário (`_meta.agentTimestampMs`,
// ou `timestamp` em segundos) e o update em `params.update.sessionUpdate`:
// - user_message_chunk: instrução do usuário (abre o turno);
// - agent_message_chunk / agent_thought_chunk: resposta e raciocínio (cada linha já vem com o texto inteiro);
// - tool_call: ferramenta chamada (`_meta["x.ai/tool"].name` e `rawInput`); tool_call_update: o resultado (`status`
//   completed/failed e `content`);
// - plan: a lista de tarefas; turn_completed: fim do turno (com o uso de tokens);
// - auto_compact_*: compactação. O resto (hooks, tarefas em segundo plano, memória) não muda o escritório.
// Daqui saem as atividades do agente (parseGrokLine) e o terminal (createGrokTerminalParser).
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { Activity, AgentStats, TaskItem, TaskStatus, TerminalEntry } from '../../../shared/types';
import { INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, TITLE_ARG_MAX, type TerminalParser } from '../terminal';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Uma linha de updates.jsonl já aberta: o update, o horário e o id do evento. */
export interface GrokUpdate {
  type: string;
  update: Rec;
  at: number;
  eventId?: string;
}

export function readUpdate(line: string, now: number): GrokUpdate | undefined {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  const o = rec(j);
  const params = rec(o?.params);
  const update = rec(params?.update);
  const type = str(update?.sessionUpdate);
  if (!o || !params || !update || !type) return undefined;
  const meta = rec(params._meta);
  const ms = num(meta?.agentTimestampMs);
  const secs = num(o.timestamp);
  const at = ms ?? (secs !== undefined ? (secs < 1e12 ? secs * 1000 : secs) : now);
  const eventId = str(meta?.eventId);
  return eventId ? { type, update, at, eventId } : { type, update, at };
}

/** Nome da ferramenta do Grok (`_meta["x.ai/tool"].name`; senão o título). */
export function toolName(u: Rec): string {
  const meta = rec(rec(u._meta)?.['x.ai/tool']);
  return str(meta?.name) ?? str(u.title) ?? 'ferramenta';
}

/** Ferramentas do Grok no vocabulário do Claude Code (o que describeTool e o terminal já sabem descrever). */
export function describeGrokTool(name: string, input: Rec): { desc: ActivityDescription; tool: string } {
  switch (name) {
    case 'read_file':
      return { desc: describeTool('Read', { file_path: input.target_file }), tool: 'Read' };
    case 'write':
      return { desc: describeTool('Write', { file_path: input.file_path }), tool: 'Write' };
    case 'search_replace':
      return { desc: describeTool('Edit', { file_path: input.file_path }), tool: 'Edit' };
    case 'grep':
      return { desc: describeTool('Grep', { pattern: input.pattern, path: input.path, glob: input.glob }), tool: 'Grep' };
    case 'list_dir':
      return { desc: describeTool('LS', { path: input.target_directory }), tool: 'LS' };
    case 'run_terminal_command':
      return { desc: describeTool('Bash', { command: input.command, description: input.description }), tool: 'Bash' };
    case 'monitor':
      return { desc: describeTool('Monitor', { command: input.command, description: input.description }), tool: 'Monitor' };
    case 'get_command_or_subagent_output':
      return { desc: describeTool('TaskOutput', input), tool: 'TaskOutput' };
    case 'kill_command_or_subagent':
      return { desc: describeTool('TaskStop', input), tool: 'TaskStop' };
    case 'web_fetch':
      return { desc: describeTool('WebFetch', { url: input.url }), tool: 'WebFetch' };
    case 'web_search':
      return { desc: describeTool('WebSearch', { query: input.query }), tool: 'WebSearch' };
    case 'todo_write':
      return { desc: describeTool('TodoWrite', input), tool: 'TodoWrite' };
    case 'spawn_subagent':
      return { desc: describeTool('Agent', { description: str(input.description) ?? str(input.prompt)?.slice(0, 60), subagent_type: input.subagent_type }), tool: 'Agent' };
    case 'ask_user_question':
      return { desc: describeTool('AskUserQuestion', input), tool: 'AskUserQuestion' };
    case 'search_tool':
      return { desc: describeTool('ToolSearch', input), tool: 'ToolSearch' };
    case 'use_tool': {
      const inner = str(input.tool_name) ?? str(input.name);
      return { desc: describeTool(inner ?? name, rec(input.arguments) ?? rec(input.input) ?? {}), tool: inner ?? name };
    }
    default:
      return { desc: describeTool(name, input), tool: name };
  }
}

const TASK_STATUS = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

/** Entradas do update `plan` como tarefas. */
export function planTasks(entries: unknown): TaskItem[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const out: TaskItem[] = [];
  entries.forEach((raw, i) => {
    const e = rec(raw);
    const title = str(e?.content);
    if (!title) return;
    const s = str(e?.status) as TaskStatus | undefined;
    out.push({ id: String(i + 1), title: truncate(maskSecrets(title.slice(0, 480)), 120), status: s && TASK_STATUS.has(s) ? s : 'pending' });
  });
  return out;
}

// ------------------------------------------------------------------ estado e atividades

export interface GrokState {
  /** Turno aberto (instrução vista e ainda sem turn_completed); undefined = nada visto ainda. */
  turnOpen?: boolean;
  firstAt?: number;
  lastAt?: number;
  /** Primeira instrução: o título enquanto o summary.json não tiver um. */
  firstPrompt?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  /** Ferramentas abertas (toolCallId → id da atividade), para marcar erro no resultado. */
  open: Map<string, string>;
}

export function createGrokState(): GrokState {
  return { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, open: new Map() };
}

export type GrokSignal = { type: 'turnStart' } | { type: 'turnEnd' } | { type: 'progress' };

export interface GrokLineResult {
  activities: Array<{ activity: Activity; current: boolean }>;
  signals: GrokSignal[];
  /** Tarefas, números ou título mudaram. */
  changed: boolean;
  at: number;
}

/** Instrução recebida pelo Grok: "Recebeu “…”" (kind 'prompt', a base do "Concluiu em X"). */
function describeGrokPrompt(text: string): ActivityDescription {
  const shown = truncate(maskSecrets(text.slice(0, 1_000)), 34);
  return { ...describePrompt(text), text: truncate(`Recebeu “${shown}”`, 46) };
}

const OPEN_MAX = 256;

export function parseGrokLine(s: GrokState, line: string, ctx: { idPrefix: string; now: number }): GrokLineResult {
  const out: GrokLineResult = { activities: [], signals: [], changed: false, at: ctx.now };
  const u = readUpdate(line, ctx.now);
  if (!u) return out;
  out.at = u.at;
  const key = u.eventId ?? `${u.type}:${u.at}`;
  const push = (desc: ActivityDescription & { tool?: string; error?: boolean }, id = key, current = true) =>
    out.activities.push({ activity: { id: `${ctx.idPrefix}#${id}`, at: u.at, ...desc }, current });
  const seen = () => {
    if (s.firstAt === undefined || u.at < s.firstAt) s.firstAt = u.at;
    if (s.lastAt === undefined || u.at > s.lastAt) s.lastAt = u.at;
  };
  switch (u.type) {
    case 'user_message_chunk': {
      const text = str(rec(u.update.content)?.text);
      if (!text) return out;
      seen();
      s.firstPrompt ??= truncate(maskSecrets(text.slice(0, 1_000)), 90);
      s.turnOpen = true;
      out.signals.push({ type: 'turnStart' });
      push(describeGrokPrompt(text));
      out.changed = true;
      return out;
    }
    case 'agent_message_chunk': {
      const text = str(rec(u.update.content)?.text);
      if (!text) return out;
      seen();
      out.signals.push({ type: 'progress' });
      push(SPECIAL.respond(maskSecrets(text.slice(0, 1_000))));
      return out;
    }
    case 'agent_thought_chunk':
      seen();
      out.signals.push({ type: 'progress' });
      return out;
    case 'tool_call': {
      const callId = str(u.update.toolCallId);
      if (!callId) return out;
      seen();
      const name = toolName(u.update);
      const { desc, tool } = describeGrokTool(name, rec(u.update.rawInput) ?? {});
      s.stats.toolCalls++;
      if (tool === 'Agent') s.stats.subagents++;
      s.open.set(callId, key);
      if (s.open.size > OPEN_MAX) s.open.delete(s.open.keys().next().value as string);
      out.signals.push({ type: 'progress' });
      push({ ...desc, tool }, callId);
      out.changed = true;
      return out;
    }
    case 'tool_call_update': {
      const callId = str(u.update.toolCallId);
      const status = str(u.update.status);
      if (!callId || (status !== 'completed' && status !== 'failed')) return out;
      seen();
      s.open.delete(callId);
      out.signals.push({ type: 'progress' });
      if (status === 'failed') push({ ...SPECIAL.error(toolName(u.update), resultText(u.update).split('\n')[0] ?? ''), tool: toolName(u.update), error: true }, `${callId}:e`, false);
      return out;
    }
    case 'plan': {
      const tasks = planTasks(u.update.entries);
      if (!tasks) return out;
      seen();
      s.tasks = tasks;
      out.changed = true;
      return out;
    }
    case 'turn_completed': {
      seen();
      s.turnOpen = false;
      const usage = rec(u.update.usage);
      const inTok = num(usage?.inputTokens);
      const outTok = num(usage?.outputTokens);
      if (inTok !== undefined) s.stats.tokensIn += inTok;
      if (outTok !== undefined) s.stats.tokensOut += outTok;
      out.signals.push({ type: 'turnEnd' });
      out.changed = true;
      return out;
    }
    case 'auto_compact_started':
      seen();
      push(SPECIAL.compact());
      return out;
    default:
      return out;
  }
}

/** Texto do resultado de uma ferramenta (`content[].content.text`). */
export function resultText(u: Rec): string {
  const parts: string[] = [];
  const content = u.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const inner = rec(rec(c)?.content);
      const t = str(inner?.text) ?? str(rec(c)?.text);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------ terminal

/** Argumento que vai no título da ferramenta: "Read(server/index.ts)", "Bash(npm test)". */
function titleArg(tool: string, input: Rec): string | undefined {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(input[k]);
      if (v) return v;
    }
    return undefined;
  };
  switch (tool) {
    case 'read_file':
      return pick('target_file');
    case 'write':
    case 'search_replace':
      return pick('file_path');
    case 'grep':
      return pick('pattern');
    case 'list_dir':
      return pick('target_directory');
    case 'run_terminal_command':
    case 'monitor':
      return pick('command');
    case 'web_fetch':
      return pick('url');
    default:
      return pick('description', 'command', 'file_path', 'path', 'query', 'url');
  }
}

/** Argumentos mostrados abaixo do título: o comando, a troca do search_replace ou o JSON (sem `variant`). */
function toolInput(tool: string, input: Rec): string | undefined {
  if (tool === 'run_terminal_command' || tool === 'monitor') return str(input.command);
  if (tool === 'search_replace') {
    const before = typeof input.old_string === 'string' ? input.old_string : '';
    const after = typeof input.new_string === 'string' ? input.new_string : '';
    return `${before.split('\n').map((l) => `- ${l}`).join('\n')}\n${after.split('\n').map((l) => `+ ${l}`).join('\n')}`;
  }
  const { variant: _variant, ...rest } = input;
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : undefined;
}

function clip(text: string, max: number): string {
  return truncate(maskSecrets(text.slice(0, max + 256)), max);
}

function clipLines(text: string): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  let truncated = lines.length > RESULT_MAX_LINES || text.length > RESULT_MAX;
  const kept = lines.slice(0, RESULT_MAX_LINES).join('\n');
  const shown = maskSecrets(kept.slice(0, RESULT_MAX + 256)).slice(0, RESULT_MAX);
  if (shown.length < kept.length) truncated = true;
  return { text: shown, truncated };
}

/** Terminal de uma sessão do Grok: instruções, respostas, raciocínio, ferramentas e resultados. */
export function createGrokTerminalParser(now: () => number = Date.now): TerminalParser {
  const seen = new Set<string>();
  return {
    push(line: string): TerminalEntry[] {
      const u = readUpdate(line, now());
      if (!u) return [];
      const id = u.eventId ?? `${u.type}:${u.at}`;
      if (seen.has(id)) return [];
      seen.add(id);
      if (seen.size > 20_000) seen.delete(seen.values().next().value as string);
      const text = str(rec(u.update.content)?.text);
      switch (u.type) {
        case 'user_message_chunk':
          return text ? [{ kind: 'user', id, at: u.at, text: clip(text, TEXT_MAX) }] : [];
        case 'agent_message_chunk':
          return text ? [{ kind: 'assistant', id, at: u.at, text: clip(text, TEXT_MAX) }] : [];
        case 'agent_thought_chunk':
          return text ? [{ kind: 'thinking', id, at: u.at, text: clip(text, THINKING_MAX) }] : [];
        case 'tool_call': {
          const callId = str(u.update.toolCallId);
          if (!callId) return [];
          const name = toolName(u.update);
          const input = rec(u.update.rawInput) ?? {};
          const { tool } = describeGrokTool(name, input);
          const arg = titleArg(name, input);
          const entry: TerminalEntry = { kind: 'tool', id: callId, at: u.at, tool, title: arg ? `${tool}(${clip(arg.split('\n')[0], TITLE_ARG_MAX)})` : tool };
          const shown = toolInput(name, input);
          if (shown) entry.input = clip(shown, INPUT_MAX);
          return [entry];
        }
        case 'tool_call_update': {
          const callId = str(u.update.toolCallId);
          const status = str(u.update.status);
          if (!callId || (status !== 'completed' && status !== 'failed')) return [];
          const r = clipLines(resultText(u.update));
          const entry: TerminalEntry = { kind: 'result', id, at: u.at, toolUseId: callId, text: r.text };
          if (status === 'failed') entry.error = true;
          if (r.truncated) entry.truncated = true;
          return [entry];
        }
        case 'auto_compact_completed':
          return [{ kind: 'system', id, at: u.at, text: 'Conversa compactada' }];
        case 'turn_completed': {
          const reason = str(u.update.stop_reason);
          return reason && reason !== 'end_turn' ? [{ kind: 'system', id, at: u.at, text: `Turno encerrado (${reason})`, level: 'warn' }] : [];
        }
        default:
          return [];
      }
    },
  };
}
