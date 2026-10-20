// Cliente do servidor do OpenCode (API v2, `opencode serve` 2.x): GETs de leitura e o stream SSE de /api/event. A fonte
// só observa: nunca manda pedido que ocupe o servidor (prompt, comando, permissão, interrupção).
import { tr } from '../../../shared/i18n';

/** Timeout dos GETs (o stream de eventos não tem: a fonte detecta a conexão parada pelo STALL_MS do readSse). */
const REQUEST_TIMEOUT_MS = 10_000;
/** Evento SSE maior que isto (sem fim de bloco) é tratado como erro: a conexão é refeita. */
const MAX_EVENT_CHARS = 8 * 1024 * 1024;

/** Sessão como o servidor a devolve (Session.Info; só os campos que a fonte usa). */
export interface OpenCodeSessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  model?: { id?: string };
  location?: { directory?: string };
  time?: { created?: number; updated?: number; archived?: number };
}

/** Resposta HTTP que não é 2xx (o status basta para decidir; nada do corpo sai no log). */
export class OpenCodeHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** O stream de eventos ficou mudo por tempo demais (conexão morta). */
export class OpenCodeStallError extends Error {
  constructor() {
    super('stall');
  }
}

export interface OpenCodeClientOptions {
  /** Origem do servidor (ex.: http://127.0.0.1:4096). */
  url: string;
  /** Senha do basic auth (usuário `opencode`); ausente = sem cabeçalho de autorização. */
  password?: string;
  fetch?: typeof fetch;
}

export class OpenCodeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenCodeClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Versão do servidor (GET /api/info, sem envelope). */
  async info(): Promise<{ version: string }> {
    const body = (await (await this.get('/api/info')).json()) as { version?: unknown };
    return { version: typeof body.version === 'string' ? body.version : '?' };
  }

  /** Ids das sessões com um turno rodando agora (GET /api/session/active: { data: { [id]: { type: 'running' } } }). */
  async activeIds(): Promise<string[]> {
    const body = (await (await this.get('/api/session/active')).json()) as { data?: Record<string, unknown> };
    return Object.keys(body.data ?? {});
  }

  /** As sessões mais novas (GET /api/session), da primeira página. */
  async recentSessions(limit: number): Promise<OpenCodeSessionInfo[]> {
    const body = (await (await this.get('/api/session', { limit: String(limit), order: 'desc' })).json()) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as OpenCodeSessionInfo[]) : [];
  }

  /** Uma sessão pelo id; undefined se o servidor não a conhece (404). */
  async session(id: string): Promise<OpenCodeSessionInfo | undefined> {
    try {
      const body = (await (await this.get(`/api/session/${encodeURIComponent(id)}`)).json()) as { data?: OpenCodeSessionInfo };
      return body.data;
    } catch (err) {
      if (err instanceof OpenCodeHttpError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Abre o stream SSE de /api/event (resolve com o corpo quando o servidor responde). */
  async openEvents(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.get('/api/event', undefined, { signal, accept: 'text/event-stream', timeout: false });
    if (!res.body) throw new Error(tr('resposta sem corpo'));
    return res.body;
  }

  private async get(path: string, query?: Record<string, string>, o: { signal?: AbortSignal; accept?: string; timeout?: boolean } = {}): Promise<Response> {
    const url = new URL(path, this.opts.url);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: o.accept ?? 'application/json' };
    if (this.opts.password !== undefined) headers.Authorization = `Basic ${Buffer.from(`opencode:${this.opts.password}`).toString('base64')}`;
    const timeout = o.timeout === false ? undefined : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = o.signal && timeout ? AbortSignal.any([o.signal, timeout]) : (o.signal ?? timeout);
    const res = await this.fetchImpl(url, { headers, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new OpenCodeHttpError(res.status);
    }
    return res;
  }
}

/**
 * Lê um stream SSE e chama `onEvent` com o JSON de cada `data:` (comentários, como o heartbeat, e linhas `event:`/`id:`
 * são ignorados; JSON inválido também). Resolve quando o stream acaba; lança se ficar mudo por `stallMs`.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (data: unknown) => void, stallMs: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const chunk = await readWithStall(reader, stallMs);
      if (chunk.done) return;
      buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        onEvent(parsed);
      }
      if (buf.length > MAX_EVENT_CHARS) throw new Error(tr('evento grande demais'));
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readWithStall(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  // Se o stall ganhar a corrida, a leitura pendente é descartada com o cancel do finally de readSse.
  read.catch(() => undefined);
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpenCodeStallError()), stallMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, stalled]);
  } finally {
    clearTimeout(timer);
  }
}
