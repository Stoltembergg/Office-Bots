// Print colado na caixa de mensagem: Ctrl+V com uma imagem na área de transferência manda a imagem ao Habblaud
// (POST /api/paste), que a grava no computador (o servidor no modo Node, o auxiliar do host no Docker; ver
// server/paste/paste.ts), e devolve o caminho para entrar no texto: a mensagem de um plugin só leva texto, e o agente
// lê a imagem pelo caminho.
import { tr } from '../../../shared/i18n';

const POLL_MS = 400;
const WAIT_MS = 30_000;
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

interface PasteReply {
  id: string;
  status: 'queued' | 'sent' | 'done' | 'failed';
  path?: string;
  error?: string;
}

/** As imagens de um evento de colar (vazio = colar texto normal). */
export function pastedImages(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (const it of Array.from(items)) {
    if (it.kind !== 'file' || !TYPES[it.type]) continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** Nome do arquivo gravado: print-AAAAMMDD-HHMMSS.png (a área de transferência só chama tudo de image.png). */
export function printName(type: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `print-${stamp}.${TYPES[type] ?? 'png'}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr('não consegui ler a imagem')));
    r.readAsDataURL(file);
  });
}

/** Manda a imagem e espera o caminho onde ela foi gravada no computador. Lança com o motivo. */
export async function uploadPaste(file: File): Promise<string> {
  let r = await api<PasteReply>('/api/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: printName(file.type), type: file.type, data: await fileToBase64(file) }),
  });
  const end = Date.now() + WAIT_MS;
  while ((r.status === 'queued' || r.status === 'sent') && Date.now() < end) {
    await new Promise((ok) => setTimeout(ok, POLL_MS));
    r = await api<PasteReply>(`/api/paste/${encodeURIComponent(r.id)}`);
  }
  if (r.status !== 'done' || !r.path) throw new Error(r.error || tr('o computador não respondeu a tempo'));
  return r.path;
}
