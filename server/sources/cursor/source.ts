// Fonte do Cursor (o agente do editor e o `cursor-agent` da linha de comando, que leem o mesmo ~/.cursor/hooks.json).
//
// Só pelos hooks: `npm run cursor:install` acrescenta mod/habblaud-cursor/hook.mjs nos eventos do Cursor, e cada
// evento chega em POST /api/cursor/events (server/cursor/http.ts) e vem para applyHookEvent. Nada é lido do disco
// (as conversas do Cursor ficam fora do Docker e num formato interno): o agente entra no escritório no primeiro evento
// de uma conversa (`conversation_id`), trabalha até o `stop` e sai no `sessionEnd` ou depois de IDLE_CLOSE_MS sem
// eventos (o editor não avisa quando uma aba de chat é fechada). Sem terminal: o transcript não é lido.
//
// A conta (".cursor") só é registrada no primeiro evento: quem não usa o Cursor não vê conta nenhuma.
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { describeCommand, describeTool, describePrompt } from '../../../shared/activity';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

/** Conversa parada há esse tempo (sem nenhum evento) sai do escritório. */
export const IDLE_CLOSE_MS = 30 * 60_000;
const MAIN_ROLE = 'Cursor';
const ACCOUNT_ID = '.cursor';

export interface CursorLive {
  /**
   * Aplica um evento de hook do Cursor (o stdin dele). `cursorDir` = a pasta ~/.cursor do host (só para mostrar na
   * conta). false = evento desconhecido ou sem conversa.
   */
  applyHookEvent(input: Rec, cursorDir?: string): boolean;
}

interface Conversation {
  key: string;
  id: string;
  cwd: string;
  status: AgentStatus;
  lastAt: number;
  inOffice: boolean;
  seq: number;
}

export interface CursorSourceOptions {
  office: Office;
  accounts: AccountsService;
  /** Pasta mostrada na conta (o ~/.cursor do host, se o hook mandar; senão este). */
  configDir: string;
  now?: () => number;
  pollMs?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Id de conversa aceitável (uuid ou parecido): nada de caminhos nem textos enormes. */
function isConversationId(v: string | undefined): v is string {
  return !!v && /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,127}$/.test(v);
}

/** Atividade de um evento de ferramenta do Cursor (os nomes do Claude Code servem para o describeTool). */
export function describeCursorEvent(event: string, input: Rec): ReturnType<typeof describeTool> | undefined {
  switch (event) {
    case 'beforeSubmitPrompt': {
      const prompt = str(input.prompt);
      return prompt ? describePrompt(prompt) : undefined;
    }
    case 'beforeShellExecution':
    case 'afterShellExecution': {
      const command = str(input.command);
      return command ? describeCommand(command) : undefined;
    }
    case 'afterFileEdit': {
      const file = str(input.file_path);
      return file ? describeTool('Edit', { file_path: file }) : undefined;
    }
    case 'beforeReadFile': {
      const file = str(input.file_path);
      return file ? describeTool('Read', { file_path: file }) : undefined;
    }
    case 'beforeMCPExecution':
    case 'afterMCPExecution': {
      const tool = str(input.tool_name);
      if (!tool) return undefined;
      const server = str(input.server_name) ?? str(input.server) ?? 'mcp';
      return describeTool(tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`, rec(input.tool_input) ?? {});
    }
    case 'preToolUse':
    case 'postToolUse': {
      const tool = str(input.tool_name);
      return tool ? describeTool(tool, rec(input.tool_input) ?? {}) : undefined;
    }
    default:
      return undefined;
  }
}

/** Eventos que dizem "o agente está trabalhando". */
const WORKING = new Set([
  'sessionStart',
  'beforeSubmitPrompt',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'preToolUse',
  'postToolUse',
  'afterAgentThought',
  'preCompact',
  'subagentStart',
  'subagentStop',
]);
/** Eventos que dizem "terminou a vez dele". */
const IDLE = new Set(['stop', 'afterAgentResponse']);

export class CursorSource implements AgentSource, CursorLive {
  readonly provider = 'cursor' as const;
  private readonly convs = new Map<string, Conversation>();
  private entry: AccountEntry | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: CursorSourceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    this.timer = setInterval(() => this.sweep(), this.opts.pollMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    if (!this.entry) return [];
    let sessions = 0;
    for (const c of this.convs.values()) if (c.inOffice) sessions++;
    return [{ label: this.entry.id, provider: 'cursor', path: this.entry.detected.configDir, sessions, ok: true }];
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entry ? [this.entry] : [];
  }

  /** Registra a conta do Cursor (uma só) na primeira vez. */
  private account(cursorDir: string | undefined): AccountEntry {
    if (this.entry) return this.entry;
    const configDir = cursorDir ?? this.opts.configDir;
    const [entry] = this.opts.accounts.setProviderAccounts('cursor', [
      { dir: configDir, detected: { id: ACCOUNT_ID, provider: 'cursor', configDir, short: 'CU', name: 'Cursor', color: '#5cc97b' } },
    ]);
    this.entry = entry;
    return entry;
  }

  applyHookEvent(input: Rec, cursorDir?: string): boolean {
    const event = str(input.hook_event_name);
    if (!event) return false;
    const id = str(input.conversation_id) ?? str(input.session_id);
    if (!isConversationId(id)) return false;
    const acc = this.account(cursorDir);
    const now = this.now();
    const key = `${acc.id}:${id}`;
    const office = this.opts.office;
    let c = this.convs.get(key);

    if (event === 'sessionEnd') {
      if (c?.inOffice) office.closeMain(c.key);
      this.convs.delete(key);
      return true;
    }
    if (!WORKING.has(event) && !IDLE.has(event)) return false;

    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots.map(str).filter((x): x is string => !!x) : [];
    const cwd = str(input.cwd) ?? roots[0];
    if (!c) {
      c = { key, id, cwd: cwd ?? '', status: 'working', lastAt: now, inOffice: false, seq: 0 };
      this.convs.set(key, c);
    }
    if (!c.cwd && cwd) c.cwd = cwd;
    c.lastAt = now;
    const status: AgentStatus = IDLE.has(event) ? 'idle' : 'working';

    if (!c.inOffice || !office.has(c.key)) {
      if (!c.cwd) return true; // sem projeto ainda: espera um evento com workspace_roots
      office.addMain({ id: c.key, provider: 'cursor', account: acc.id, sessionId: c.id, cwd: c.cwd, role: MAIN_ROLE, startedAt: now, status });
      c.inOffice = office.has(c.key);
      c.status = status;
      if (!c.inOffice) return true;
    } else if (c.status !== status) {
      office.setStatus(c.key, status);
      c.status = status;
    }

    const desc = describeCursorEvent(event, input);
    if (desc) {
      const act: Activity = { id: `${c.key}#${event}:${(++c.seq).toString(36)}:${now.toString(36)}`, at: now, ...desc };
      office.addActivity(c.key, act, true);
    } else if (event === 'stop' && str(input.status) === 'error') {
      office.addActivity(c.key, { id: `${c.key}#stop:${now.toString(36)}`, at: now, kind: 'other', icon: '⚠️', text: tr('Parou com erro'), error: true }, true);
    }
    return true;
  }

  /** Tira do escritório as conversas sem evento há IDLE_CLOSE_MS. */
  sweep(): void {
    const now = this.now();
    for (const [key, c] of this.convs) {
      if (now - c.lastAt < IDLE_CLOSE_MS) continue;
      if (c.inOffice && this.opts.office.has(c.key)) this.opts.office.closeMain(c.key);
      this.convs.delete(key);
    }
  }
}
