// Cliente do `codex app-server` (JSON-RPC por linhas) para UM CODEX_HOME: sobe o processo quando precisa, abre ou
// retoma threads em always-approve (approvalPolicy "never", sandbox "danger-full-access", o mesmo do
// --dangerously-bypass-approvals-and-sandbox) e manda mensagens (turn/start; com um turno aberto, turn/steer).
// Pedidos do agente (aprovação de comando, de arquivo, de permissões; pergunta) vão para `onAgentRequest`. A conversa
// continua vindo do rollout que o Codex grava (sources/codex): este cliente não lê nem guarda o que o agente diz.
import { tr } from '../../../shared/i18n';
import { JsonRpcError, spawnJsonRpc, type JsonRpcPeer } from './jsonrpc';

export type CodexAgentRequest =
  | { kind: 'approval'; threadId: string; tool: 'Bash' | 'Edit' | 'Permissions'; input: Record<string, unknown>; cwd?: string; reason?: string }
  | { kind: 'question'; threadId: string; questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }>; isOther: boolean }> };

export type CodexAgentReply = { kind: 'approval'; allow: boolean } | { kind: 'question'; answers: Record<string, string[]> | null };

export interface CodexAppServerOptions {
  bin: string;
  codexHome: string;
  env?: NodeJS.ProcessEnv;
  onAgentRequest: (r: CodexAgentRequest) => Promise<CodexAgentReply>;
  onClosed?: (threads: string[], reason: string) => void;
  requestTimeoutMs?: number;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const ALWAYS_APPROVE = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const;

export class CodexAppServer {
  private conn: { peer: JsonRpcPeer; kill: () => void; ready: Promise<void> } | undefined;
  /** threadId -> turno aberto (null = parado). */
  private readonly hosted = new Map<string, string | null>();

  constructor(private readonly opts: CodexAppServerOptions) {}

  hosts(threadId: string): boolean {
    return this.hosted.has(threadId);
  }

  threads(): string[] {
    return [...this.hosted.keys()];
  }

  async startThread(p: { cwd: string; prompt?: string }): Promise<string> {
    const peer = await this.peer();
    const r = rec(await peer.request('thread/start', { cwd: p.cwd, ...ALWAYS_APPROVE }));
    const id = str(rec(r.thread).id);
    if (!id) throw new JsonRpcError(tr('o Codex não devolveu o id do thread'));
    this.hosted.set(id, null);
    if (p.prompt) await this.send(id, p.prompt);
    return id;
  }

  async resumeThread(threadId: string): Promise<void> {
    const peer = await this.peer();
    await peer.request('thread/resume', { threadId, ...ALWAYS_APPROVE });
    this.hosted.set(threadId, null);
  }

  async send(threadId: string, text: string): Promise<void> {
    const peer = await this.peer();
    const input = [{ type: 'text', text }];
    const turn = this.hosted.get(threadId);
    if (turn) {
      try {
        await peer.request('turn/steer', { threadId, expectedTurnId: turn, input });
        return;
      } catch (err) {
        // O turno acabou entre a leitura e o envio: vira um turno novo.
        if (!(err instanceof JsonRpcError) || peer.closed) throw err;
      }
    }
    const r = rec(await peer.request('turn/start', { threadId, input }));
    const id = str(rec(r.turn).id);
    if (id && this.hosted.has(threadId)) this.hosted.set(threadId, id);
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.hosted.get(threadId);
    if (!turn || !this.conn) return;
    await this.conn.peer.request('turn/interrupt', { threadId, turnId: turn });
  }

  async release(threadId: string): Promise<void> {
    if (!this.hosted.delete(threadId) || !this.conn) return;
    await this.conn.peer.request('thread/unsubscribe', { threadId }).catch(() => undefined);
  }

  stop(): void {
    this.conn?.kill();
    this.conn = undefined;
  }

  private async peer(): Promise<JsonRpcPeer> {
    if (!this.conn || this.conn.peer.closed) this.conn = this.connect();
    await this.conn.ready;
    return this.conn.peer;
  }

  private connect(): { peer: JsonRpcPeer; kill: () => void; ready: Promise<void> } {
    const { peer, kill } = spawnJsonRpc(this.opts.bin, ['app-server'], {
      env: { ...(this.opts.env ?? process.env), CODEX_HOME: this.opts.codexHome },
      defaultTimeoutMs: this.opts.requestTimeoutMs ?? 30_000,
      onRequest: (method, params) => this.onAgentRequest(method, rec(params)),
      onNotification: (method, params) => this.onNotification(method, rec(params)),
    });
    peer.onClose((reason) => {
      const threads = [...this.hosted.keys()];
      this.hosted.clear();
      if (threads.length) this.opts.onClosed?.(threads, reason);
    });
    const ready = peer
      .request('initialize', { clientInfo: { name: 'habblaud', version: '1' } })
      .then(() => peer.notify('initialized'));
    return { peer, kill, ready };
  }

  private onNotification(method: string, p: Rec): void {
    const threadId = str(p.threadId);
    if (!threadId || !this.hosted.has(threadId)) return;
    if (method === 'turn/started') this.hosted.set(threadId, str(rec(p.turn).id) ?? null);
    else if (method === 'turn/completed') this.hosted.set(threadId, null);
  }

  private async onAgentRequest(method: string, p: Rec): Promise<unknown> {
    const threadId = str(p.threadId) ?? '';
    if (method === 'item/tool/requestUserInput') {
      const questions = (Array.isArray(p.questions) ? p.questions : []).map((q) => {
        const r = rec(q);
        return {
          id: str(r.id) ?? '',
          header: str(r.header) ?? '',
          question: str(r.question) ?? '',
          isOther: r.isOther === true,
          options: (Array.isArray(r.options) ? r.options : []).map((o) => ({ label: str(rec(o).label) ?? '', description: str(rec(o).description) ?? '' })),
        };
      });
      const reply = await this.opts.onAgentRequest({ kind: 'question', threadId, questions });
      if (reply.kind !== 'question' || !reply.answers) throw new JsonRpcError(tr('cancelado no Habblaud'), -32800);
      return { answers: Object.fromEntries(Object.entries(reply.answers).map(([k, v]) => [k, { answers: v }])) };
    }
    const tool =
      method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
        ? 'Bash'
        : method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
          ? 'Edit'
          : method === 'item/permissions/requestApproval'
            ? 'Permissions'
            : undefined;
    if (!tool) throw new JsonRpcError(tr('método desconhecido: {0}', [method]), -32601);
    const input: Rec =
      tool === 'Bash' ? { command: str(p.command) ?? '' } : tool === 'Edit' ? { reason: str(p.reason) ?? '' } : { permissions: p.permissions ?? null };
    const reply = await this.opts.onAgentRequest({ kind: 'approval', threadId, tool, input, cwd: str(p.cwd), reason: str(p.reason) });
    return approvalResponse(method, p, reply.kind === 'approval' && reply.allow);
  }
}

/**
 * Resposta a um pedido de aprovação no formato de cada método: os novos (item/*) com accept/decline, os antigos
 * (execCommandApproval, applyPatchApproval) com approved/denied, e o de permissões com as permissões concedidas (as
 * pedidas, ou nenhuma) só para o turno.
 */
export function approvalResponse(method: string, params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') return { permissions: allow ? (params.permissions ?? {}) : {}, scope: 'turn' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: allow ? 'approved' : 'denied' };
  return { decision: allow ? 'accept' : 'decline' };
}
