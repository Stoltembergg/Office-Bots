// Chamadas à API do terminal interativo (server/http/pty.ts). Erros viram Error com a mensagem do servidor.
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo, PtyInfo } from '../../../shared/types';
import { providerOf } from './provider';
import { tr } from '../../../shared/i18n';

/**
 * Dá para encerrar ou assumir este agente pelo escritório? Só o agente principal de uma sessão do Claude Code: o
 * Codex não tem registro de sessões nem `--resume` aqui, e os agentes do demo não existem de verdade.
 */
export function ptyControllable(a: Pick<AgentInfo, 'id' | 'kind' | 'provider'> | null | undefined): boolean {
  return !!a && a.kind === 'main' && providerOf(a) === 'claude' && !isDemoId(a.id);
}

export async function postPty<T = unknown>(url: string, body: unknown): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  if (res.status === 204) return undefined;
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j as T;
}

const SIZE = { cols: 120, rows: 32 };

/** Sessão nova do Claude Code na pasta (e conta) indicada. */
export function createPty(cwd: string, account?: string): Promise<PtyInfo | undefined> {
  return postPty<PtyInfo>('/api/pty', { cwd, account, ...SIZE });
}

/** Encerra a sessão noutro terminal e continua a mesma conversa aqui. */
export function takeoverAgent(agentId: string): Promise<PtyInfo | undefined> {
  return postPty<PtyInfo>(`/api/agents/${encodeURIComponent(agentId)}/takeover`, SIZE);
}

/** Encerra o agente (aqui ou noutro terminal). */
export async function stopAgent(agentId: string): Promise<void> {
  await postPty(`/api/agents/${encodeURIComponent(agentId)}/stop`, {});
}

export async function closePty(id: string): Promise<void> {
  await postPty(`/api/pty/${encodeURIComponent(id)}/close`, {});
}

/** Tamanho de cada envio de entrada: o servidor recusa mais de 64 K caracteres por POST (server/pty/manager.ts, input). */
export const INPUT_CHUNK = 16 * 1024;

/** Corta a entrada em pedaços de até `max` caracteres sem separar um par substituto (emoji). */
export function splitInput(data: string, max = INPUT_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + max, data.length);
    const c = data.charCodeAt(end - 1);
    if (end < data.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

type SendInput = (id: string, data: string) => Promise<unknown>;

const postInput: SendInput = (id, data) => postPty(`/api/pty/${encodeURIComponent(id)}/input`, { data });

/**
 * Filas de entrada, uma por pty: as teclas de um pty saem na ordem, juntas enquanto o envio anterior não volta, e
 * uma colagem grande vai em pedaços. Um pty lento (ou que sumiu) não segura as teclas de outro.
 */
export class InputQueues {
  private queues = new Map<string, { pending: string; sending: Promise<void> }>();

  constructor(
    private onError: (id: string, err: Error) => void,
    private post: SendInput = postInput,
  ) {}

  send(id: string, data: string): Promise<void> {
    let q = this.queues.get(id);
    if (!q) this.queues.set(id, (q = { pending: '', sending: Promise.resolve() }));
    const queue = q;
    queue.pending += data;
    queue.sending = queue.sending.then(async () => {
      if (!queue.pending) return;
      const all = queue.pending;
      queue.pending = '';
      try {
        for (const chunk of splitInput(all)) await this.post(id, chunk);
      } catch (err) {
        this.onError(id, err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!queue.pending && this.queues.get(id) === queue) this.queues.delete(id);
      }
    });
    return queue.sending;
  }
}
