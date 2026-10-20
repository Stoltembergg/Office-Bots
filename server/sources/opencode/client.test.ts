// Cliente HTTP e leitor SSE do OpenCode: autenticação, 404, stream fragmentado, heartbeat e stream mudo.
import { afterEach, describe, expect, it } from 'vitest';
import { FakeOpenCode } from '../../test/opencode-fake';
import { OpenCodeClient, OpenCodeHttpError, OpenCodeStallError, readSse } from './client';

const enc = new TextEncoder();

/** Corpo de resposta com estes pedaços, um por vez (simula o TCP fragmentando o stream). */
function chunked(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

let fake: FakeOpenCode | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

describe('readSse', () => {
  it('entrega o JSON de cada data:, ignora heartbeat, event: e JSON inválido', async () => {
    const got: unknown[] = [];
    await readSse(
      chunked([': heartbeat\n\n', 'event: x\ndata: {"type":"a"}\n\n', 'data: nao-json\n\n', 'data: {"type":"b"}\n\n']),
      (d) => got.push(d),
      1000,
    );
    expect(got).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('junta blocos partidos entre pedaços e aceita CRLF', async () => {
    const got: unknown[] = [];
    await readSse(chunked(['data: {"ty', 'pe":"a"}\r\n', '\r\ndata: {"type"', ':"b"}\n\n']), (d) => got.push(d), 1000);
    expect(got).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('um stream que fica mudo lança StallError', async () => {
    const mute = new ReadableStream<Uint8Array>({ start() {} });
    await expect(readSse(mute, () => undefined, 30)).rejects.toBeInstanceOf(OpenCodeStallError);
  });
});

describe('OpenCodeClient', () => {
  it('manda basic auth (usuário opencode) quando há senha, e não manda sem ela', async () => {
    fake = new FakeOpenCode({ password: 'senha-de-teste' });
    await fake.start();
    const withPw = new OpenCodeClient({ url: fake.url, password: 'senha-de-teste' });
    await expect(withPw.info()).resolves.toEqual({ version: '2.1.0' });
    expect(fake.requests.at(-1)?.auth).toBe(`Basic ${Buffer.from('opencode:senha-de-teste').toString('base64')}`);

    const without = new OpenCodeClient({ url: fake.url });
    await expect(without.info()).rejects.toMatchObject({ status: 401 });
  });

  it('senha errada: HTTP 401 vira OpenCodeHttpError', async () => {
    fake = new FakeOpenCode({ password: 'certa' });
    await fake.start();
    const client = new OpenCodeClient({ url: fake.url, password: 'errada' });
    await expect(client.activeIds()).rejects.toBeInstanceOf(OpenCodeHttpError);
  });

  it('session(): 404 vira undefined; sessão existente volta com o diretório', async () => {
    fake = new FakeOpenCode();
    await fake.start();
    fake.sessions.set('ses_teste_1', { id: 'ses_teste_1', directory: '/projetos/alfa', created: 1, updated: 2 });
    const client = new OpenCodeClient({ url: fake.url });
    expect(await client.session('ses_nao_existe')).toBeUndefined();
    expect((await client.session('ses_teste_1'))?.location?.directory).toBe('/projetos/alfa');
  });

  it('recentSessions() pede as mais novas primeiro; activeIds() lê o mapa de rodando', async () => {
    fake = new FakeOpenCode();
    await fake.start();
    fake.sessions.set('ses_antiga', { id: 'ses_antiga', directory: '/a', created: 1, updated: 1 });
    fake.sessions.set('ses_nova', { id: 'ses_nova', directory: '/b', created: 5, updated: 9 });
    fake.active.add('ses_nova');
    const client = new OpenCodeClient({ url: fake.url });
    expect((await client.recentSessions(10)).map((s) => s.id)).toEqual(['ses_nova', 'ses_antiga']);
    expect(await client.activeIds()).toEqual(['ses_nova']);
  });

  it('openEvents() abre o stream e o primeiro evento é server.connected', async () => {
    fake = new FakeOpenCode();
    await fake.start();
    const client = new OpenCodeClient({ url: fake.url });
    const ac = new AbortController();
    const body = await client.openEvents(ac.signal);
    const got: unknown[] = [];
    const reading = readSse(body, (d) => {
      got.push(d);
      ac.abort();
    }, 1000).catch(() => undefined);
    await reading;
    expect(got).toEqual([expect.objectContaining({ type: 'server.connected' })]);
  });
});
