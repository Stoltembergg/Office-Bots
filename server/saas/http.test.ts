import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSaasHttpHandler, type SaasRoute } from './http';

interface TestServer {
  readonly base: string;
  close(): Promise<void>;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

const servers: TestServer[] = [];

async function serve(routes: readonly SaasRoute[]): Promise<TestServer> {
  const server = http.createServer(createSaasHttpHandler({ routes }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const testServer: TestServer = {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  servers.push(testServer);
  return testServer;
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string } = {},
): Promise<HttpResult> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method: options.method ?? 'GET',
        headers: options.cookie ? { Cookie: options.cookie } : undefined,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('handler HTTP SaaS isolado', () => {
  it('recusa rotas legadas e desconhecidas com e sem cookie sem encaminhá-las', async () => {
    const forwarded: string[] = [];
    const server = await serve([
      {
        method: 'POST',
        path: '/__test/allowed',
        handle: (req, res) => {
          forwarded.push(`${req.method} ${req.url}`);
          res.writeHead(204).end();
        },
      },
    ]);

    const blockedPaths = [
      '/api/snapshot',
      '/api/stream',
      '/api/agents',
      '/api/agents/agent-1',
      '/api/sessions',
      '/api/sessions/session-1',
      '/api/world',
      '/api/world/status',
      '/api/pty',
      '/api/pty/session-1',
      '/api/not-registered',
      '/not-a-saas-route',
    ];

    for (const path of blockedPaths) {
      for (const cookie of [undefined, 'session=synthetic']) {
        const result = await request(server.base, path, { cookie });
        expect(result.status, `${path} with cookie ${cookie ?? '(none)'}`).toBe(404);
        expect(result.body).toBe('Not Found\n');
      }
    }

    expect(forwarded).toEqual([]);
  });

  it('encaminha somente o método e caminho exatos explicitamente injetados', async () => {
    const forwarded: string[] = [];
    const server = await serve([
      {
        method: 'POST',
        path: '/__test/allowed',
        handle: (req, res) => {
          forwarded.push(`${req.method} ${req.url}`);
          res.writeHead(204).end();
        },
      },
    ]);

    for (const cookie of [undefined, 'session=synthetic']) {
      expect((await request(server.base, '/__test/allowed', { method: 'POST', cookie })).status).toBe(204);
    }
    expect(forwarded).toEqual(['POST /__test/allowed', 'POST /__test/allowed']);

    for (const [method, path] of [
      ['GET', '/__test/allowed'],
      ['PUT', '/__test/allowed'],
      ['POST', '/__test/allowed/'],
      ['POST', '/__test/allowed/child'],
      ['POST', '/__test/other'],
    ]) {
      expect((await request(server.base, path, { method })).status).toBe(404);
    }
    expect(forwarded).toHaveLength(2);
  });

  it('recusa formas de path e métodos HTTP não permitidos sem refletir dados da requisição', async () => {
    const forwarded: string[] = [];
    const server = await serve([
      {
        method: 'POST',
        path: '/__test/allowed',
        handle: (_req, res) => {
          forwarded.push('called');
          res.writeHead(204).end();
        },
      },
    ]);

    for (const [method, path] of [
      ['GET', '//__test/allowed'],
      ['GET', 'http://elsewhere.invalid/__test/allowed'],
      ['OPTIONS', '*'],
      ['TRACE', '/__test/allowed'],
    ]) {
      const result = await request(server.base, path, { method });
      expect(result.status).toBe(404);
      expect(result.body).toBe('Not Found\n');
    }
    expect(forwarded).toEqual([]);
  });
});
