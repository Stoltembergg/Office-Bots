// Print colado na caixa de mensagem: o navegador manda a imagem da área de transferência (POST /api/paste, JSON
// base64: o guard exige JSON em todo POST) e consulta GET /api/paste/:id até o caminho chegar. A mensagem de um plugin
// só leva texto (o Claude Code não expande imagens de `$.prompt.submit`), então a imagem é gravada no computador, em
// ~/.habblaud/attachments/<data>-<id>/ (spawn/attachments.ts), e a caixa ganha o caminho para o agente ler:
// - modo Node: o próprio servidor grava;
// - Docker: o auxiliar do host (scripts/codex-bridge.ts) busca em POST /api/host/paste/poll e devolve o caminho em
//   POST /api/host/paste/ack. "Disponível" = auxiliar visto há pouco.
// A imagem fica só na memória e some assim que é entregue; o caminho, até ser lido (ou 5 min).
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import { parseAttachment, type Attachment } from '../spawn/attachments';

export const HOST_PRESENCE_MS = 10_000;
const QUEUED_TIMEOUT_MS = 30_000;
const SENT_TIMEOUT_MS = 30_000;
const KEEP_MS = 5 * 60_000;
const MAX_OPEN = 8;
const ERROR_MAX = 300;
const PATH_MAX = 1_000;
/** Só imagens: é um print, e o agente as lê pelo caminho. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type PasteStatus = 'queued' | 'sent' | 'done' | 'failed';

export interface PasteInfo {
  id: string;
  status: PasteStatus;
  path?: string;
  error?: string;
}

interface Entry {
  info: PasteInfo;
  file: Attachment | null;
  at: number;
}

export interface PasteServiceOptions {
  /** Modo Node: grava aqui e devolve o caminho. Ausente: fila para o auxiliar do host. */
  write?: (id: string, file: Attachment) => string;
  now?: () => number;
  newId?: () => string;
}

export type PasteSubmit = { paste: PasteInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

/** Confere o corpo de POST /api/paste: {name, type (imagem), data (base64)}. */
export function parsePaste(raw: unknown): Attachment | { error: string } {
  const a = parseAttachment(raw);
  if ('error' in a) return a;
  if (!IMAGE_TYPES.has(a.type)) return { error: tr('só dá para colar imagens (PNG, JPEG, GIF ou WebP)') };
  return a;
}

export class PasteService {
  private readonly entries = new Map<string, Entry>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: PasteServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  available(): boolean {
    return !!this.opts.write || this.host.present();
  }

  submit(raw: unknown): PasteSubmit {
    this.prune();
    const file = parsePaste(raw);
    if ('error' in file) return { error: 'invalid', reason: file.error };
    if (!this.available()) return { error: 'unavailable', reason: tr('colar print indisponível: o auxiliar (npm run codex:bridge) parou') };
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('prints demais esperando: aguarde o anterior') };
    const info: PasteInfo = { id: this.opts.newId?.() ?? randomUUID(), status: 'queued' };
    const entry: Entry = { info, file, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.write) this.writeHere(entry, this.opts.write);
    else this.host.wake();
    return { paste: { ...info } };
  }

  get(id: string): PasteInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Rodada do auxiliar: marca presença e entrega as imagens da fila (base64), que saem da memória aqui. */
  poll(): Array<{ id: string; name: string; type: string; data: string }> {
    this.host.seen();
    this.prune();
    const out: Array<{ id: string; name: string; type: string; data: string }> = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued' || !e.file) continue;
      e.info.status = 'sent';
      e.at = this.now();
      out.push({ id: e.info.id, name: e.file.name, type: e.file.type, data: e.file.data.toString('base64') });
      e.file = null;
    }
    return out;
  }

  /** Rodada com espera (?wait=1): sem imagem na fila, fica parada até chegar uma ou passar `ms`. */
  pollWait(ms: number, signal?: AbortSignal): Promise<Array<{ id: string; name: string; type: string; data: string }>> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      if (x.ok === true && typeof x.path === 'string' && x.path) this.finish(e, x.path);
      else this.fail(e, typeof x.error === 'string' && x.error ? x.error : tr('o auxiliar não gravou o print'));
    }
  }

  private writeHere(e: Entry, write: (id: string, file: Attachment) => string): void {
    const file = e.file;
    e.file = null;
    e.info.status = 'sent';
    if (!file) return this.fail(e, tr('imagem perdida'));
    try {
      this.finish(e, write(e.info.id, file));
    } catch (err) {
      this.fail(e, (err as Error).message || tr('não consegui gravar o print'));
    }
  }

  private finish(e: Entry, path: string): void {
    e.info.status = 'done';
    e.info.path = path.slice(0, PATH_MAX);
    e.at = this.now();
  }

  private fail(e: Entry, error: string): void {
    e.file = null;
    e.info.status = 'failed';
    e.info.error = error.slice(0, ERROR_MAX);
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.fail(e, tr('o auxiliar do computador não buscou o print'));
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.fail(e, tr('gravar o print demorou demais'));
      else if ((e.info.status === 'done' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
