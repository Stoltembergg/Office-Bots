import { afterEach, describe, expect, it } from 'vitest';
import { createAuthService } from '../auth/service';
import { sessionsLockError } from './sessions';
import { setQuiet } from '../log';
import { request, servePermissions, type PermissionServer } from '../test/permission-server';

setQuiet(true);

const REMOTE = { Host: '192.168.0.10' };
const PASSWORD = 'segredo-forte';
const NEED_AUTH = { error: 'autenticação necessária' };

let srv: PermissionServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function start(withAuth: boolean): Promise<PermissionServer> {
  srv = await servePermissions({ auth: withAuth ? createAuthService({ password: PASSWORD }) : undefined });
  return srv;
}

function login(base: string, password: string, host: Record<string, string> = REMOTE) {
  return request(base, '/api/auth/login', { method: 'POST', headers: host, body: { password } });
}

async function loginCookie(base: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(r.status).toBe(200);
  const setCookie = r.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

describe('rotas HTTP com auth', () => {
  it('sem auth no handler: /api/auth/* é 404 e o snapshot local segue 200', async () => {
    const { base } = await start(false);
    expect((await request(base, '/api/auth/session')).status).toBe(404);
    expect((await request(base, '/api/auth/login', { method: 'POST', body: { password: 'x' } })).status).toBe(404);
    expect((await request(base, '/api/snapshot', { headers: { Host: 'localhost' } })).status).toBe(200);
    // Sem auth o Host remoto continua com as mensagens antigas.
    const perm = await request(base, '/api/permissions', { headers: REMOTE });
    expect(perm.status).toBe(403);
    expect((perm.json as { error: string }).error).toContain('próprio computador');
  });

  it('sem auth: health traz authRequired false', async () => {
    const { base } = await start(false);
    const r = await request(base, '/api/health');
    expect((r.json as { authRequired: boolean }).authRequired).toBe(false);
  });

  it('com auth, Host remoto sem cookie: rotas fechadas 401, health e session abertos', async () => {
    const { base } = await start(true);
    for (const path of ['/api/snapshot', '/api/stream', '/api/mod/summary', '/api/agents/x', '/api/stats', '/api/updates', '/api/permissions', '/api/timeline/days']) {
      const r = await request(base, path, { headers: REMOTE });
      expect(r.status, path).toBe(401);
      expect(r.json, path).toEqual(NEED_AUTH);
    }
    for (const [method, path] of [
      ['POST', '/api/demo'],
      ['POST', '/api/rooms/rename'],
      ['PUT', '/api/agents/x/character'],
      ['POST', '/api/updates/check'],
    ] as const) {
      const r = await request(base, path, { method, headers: REMOTE, body: {} });
      expect(r.status, path).toBe(401);
      expect(r.json, path).toEqual(NEED_AUTH);
    }
    const health = await request(base, '/api/health', { headers: REMOTE });
    expect(health.status).toBe(200);
    expect((health.json as { authRequired: boolean }).authRequired).toBe(true);
    const session = await request(base, '/api/auth/session', { headers: REMOTE });
    expect(session.status).toBe(200);
    expect(session.json).toEqual({ required: true, authenticated: false });
  });

  it('login com a senha certa: 200 + cookie, e o snapshot remoto abre', async () => {
    const { base } = await start(true);
    const r = await login(base, PASSWORD);
    expect(r.status).toBe(200);
    const cookie = await loginCookie(base);
    expect(cookie).toMatch(/^habblaud_session=/);
    const snap = await request(base, '/api/snapshot', { headers: { ...REMOTE, Cookie: cookie } });
    expect(snap.status).toBe(200);
    const session = await request(base, '/api/auth/session', { headers: { ...REMOTE, Cookie: cookie } });
    expect(session.json).toEqual({ required: true, authenticated: true });
    const perm = await request(base, '/api/permissions', { headers: { ...REMOTE, Cookie: cookie } });
    expect(perm.status).not.toBe(401);
    expect(perm.status).not.toBe(403);
  });

  it('login com cookie de Set-Cookie é devolvido no cabeçalho', async () => {
    const { base } = await start(true);
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'localhost' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.headers.get('set-cookie')).toContain('habblaud_session=');
  });

  it('senha errada: 401; depois de 5 falhas o limite responde 429', async () => {
    const { base } = await start(true);
    for (let i = 0; i < 5; i++) expect((await login(base, 'errada')).status).toBe(401);
    expect((await login(base, 'errada')).status).toBe(429);
    expect((await login(base, PASSWORD)).status).toBe(429);
  });

  it('login com corpo sem senha: 400', async () => {
    const { base } = await start(true);
    const r = await request(base, '/api/auth/login', { method: 'POST', headers: REMOTE, body: {} });
    expect(r.status).toBe(400);
  });

  it('métodos errados em /api/auth/*: 405', async () => {
    const { base } = await start(true);
    expect((await request(base, '/api/auth/login', { headers: REMOTE })).status).toBe(405);
    expect((await request(base, '/api/auth/logout', { headers: REMOTE })).status).toBe(405);
    expect((await request(base, '/api/auth/session', { method: 'POST', headers: REMOTE, body: {} })).status).toBe(405);
  });

  it('logout: o snapshot remoto volta a 401', async () => {
    const { base } = await start(true);
    const cookie = await loginCookie(base);
    expect((await request(base, '/api/snapshot', { headers: { ...REMOTE, Cookie: cookie } })).status).toBe(200);
    const out = await request(base, '/api/auth/logout', { method: 'POST', headers: { ...REMOTE, Cookie: cookie }, body: {} });
    expect(out.status).toBe(200);
    expect((await request(base, '/api/snapshot', { headers: { ...REMOTE, Cookie: cookie } })).status).toBe(401);
  });

  it('Host localhost sem cookie com auth ligada: snapshot 200 e permissions sem 401 por Host', async () => {
    const { base } = await start(true);
    const local = { Host: 'localhost' };
    expect((await request(base, '/api/snapshot', { headers: local })).status).toBe(200);
    const perm = await request(base, '/api/permissions', { headers: local });
    expect(perm.status).not.toBe(401);
    expect(perm.status).not.toBe(403);
  });

  it('POST /api/codex/events com cookie válido mas Host remoto: 403', async () => {
    const { base } = await start(true);
    const cookie = await loginCookie(base);
    const r = await request(base, '/api/codex/events', { method: 'POST', headers: { ...REMOTE, Cookie: cookie }, body: {} });
    expect(r.status).toBe(403);
  });

  it('recurso desligado continua 403 (não 401)', async () => {
    srv = await servePermissions({ enabled: false, auth: createAuthService({ password: PASSWORD }) });
    const r = await request(srv.base, '/api/permissions', { headers: REMOTE });
    expect(r.status).toBe(403);
  });

  it('sessionsLockError: 401 só quando falta privilégio com auth; recurso desligado segue 403', () => {
    expect(sessionsLockError(false, 'localhost')).toContain('terminal desligado');
    expect(sessionsLockError(true, '192.168.0.10')).toContain('próprio computador');
    expect(sessionsLockError(true, '192.168.0.10', true)).toBeUndefined();
    expect(sessionsLockError(true, 'localhost', false)).toBe('autenticação necessária');
    expect(sessionsLockError(false, '192.168.0.10', false)).toContain('terminal desligado');
  });
});
