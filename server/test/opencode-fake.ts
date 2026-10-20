// Servidor do OpenCode simulado para os testes da fonte: a API v2 que a fonte usa (GET /api/info, /api/session,
// /api/session/active, /api/session/:id e o stream SSE /api/event). Os eventos são empurrados pelo teste; cada pedido
// fica em `requests` (a fonte só pode fazer GET). Dados sintéticos: pastas e ids inventados.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSession {
  id: string;
  parentID?: string;
  title?: string;
  directory: string;
  metadata?: Record<string, unknown>;
  created: number;
  updated: number;
  archived?: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  auth?: string;
}

export class FakeOpenCode {
  readonly requests: FakeRequest[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** Sessões com um turno rodando (GET /api/session/active). */
  readonly active = new Set<string>();
  private readonly streams = new Set<ServerResponse>();
  private server: Server | null = null;
  private eventSeq = 0;
  port = 0;

  constructor(private readonly opts: { password?: string; version?: string } = {}) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Streams de eventos abertos agora (o teste espera ≥ 1 antes de empurrar eventos). */
  get streamCount(): number {
    return this.streams.size;
  }

  /** Sobe o servidor (na porta dada, ou numa livre). */
  async start(port = 0): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /** Derruba o servidor e as conexões (como se o `opencode serve` tivesse saído). */
  async stop(): Promise<void> {
    for (const res of this.streams) res.destroy();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Fecha só o stream de eventos (o servidor continua de pé). */
  endStreams(): void {
    for (const res of this.streams) res.end();
    this.streams.clear();
  }

  /** Empurra um evento SSE (envelope como o do servidor real: id, type, created, location, data). */
  emit(type: string, data: Record<string, unknown>, extra: { directory?: string; created?: number } = {}): void {
    const envelope = {
      id: `evt_test_${++this.eventSeq}`,
      type,
      created: extra.created ?? Date.now(),
      ...(extra.directory ? { location: { directory: extra.directory } } : {}),
      data,
    };
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const res of this.streams) res.write(frame);
  }

  /** Só heartbeat (comentário SSE), como o servidor manda para manter a conexão. */
  heartbeat(): void {
    for (const res of this.streams) res.write(': heartbeat\n\n');
  }

  /** Pedidos que não são GET (a fonte nunca deve fazer nenhum). */
  nonGetRequests(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization;
    this.requests.push({ method: req.method ?? '', path: url.pathname, ...(auth ? { auth } : {}) });
    if (this.opts.password !== undefined && auth !== this.expectedAuth()) {
      return this.json(res, 401, { _tag: 'UnauthorizedError', message: 'Unauthorized' });
    }
    if (req.method !== 'GET') return this.json(res, 405, { message: 'método não permitido nesta fixture' });
    if (url.pathname === '/api/info') return this.json(res, 200, { version: this.opts.version ?? '2.1.0', pid: 1, urls: [this.url], paths: { tmp: '/tmp' } });
    if (url.pathname === '/api/event') return this.openStream(res);
    if (url.pathname === '/api/session/active') {
      const data = Object.fromEntries([...this.active].map((id) => [id, { type: 'running' }]));
      return this.json(res, 200, { data });
    }
    if (url.pathname === '/api/session') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const data = [...this.sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, limit).map((s) => this.info(s));
      return this.json(res, 200, { data, cursor: { previous: null, next: null } });
    }
    const m = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const s = this.sessions.get(decodeURIComponent(m[1]));
      if (!s) return this.json(res, 404, { _tag: 'SessionNotFoundError', sessionID: m[1], message: 'Session not found' });
      return this.json(res, 200, { data: this.info(s) });
    }
    return this.json(res, 404, { message: 'não existe nesta fixture' });
  }

  private expectedAuth(): string {
    return `Basic ${Buffer.from(`opencode:${this.opts.password ?? ''}`).toString('base64')}`;
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ id: 'evt_test_connected', type: 'server.connected', data: {} })}\n\n`);
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
  }

  private info(s: FakeSession) {
    return {
      id: s.id,
      ...(s.parentID ? { parentID: s.parentID } : {}),
      projectID: 'projeto-teste',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: s.created, updated: s.updated, ...(s.archived ? { archived: s.archived } : {}) },
      ...(s.title ? { title: s.title } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
      location: { directory: s.directory },
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
