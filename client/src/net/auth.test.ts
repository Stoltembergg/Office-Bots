import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthSession, getAuth, login, logout, onAuthRequired, reportUnauthorized, setAuth } from './auth';

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAuth({ required: false, authenticated: false });
});

describe('fetchAuthSession', () => {
  it('404 (senha não definida): login não é exigido', async () => {
    mockFetch(404, { error: 'rota desconhecida' });
    expect(await fetchAuthSession()).toEqual({ required: false, authenticated: false });
  });

  it('200: lê required e authenticated', async () => {
    const fn = mockFetch(200, { required: true, authenticated: false });
    expect(await fetchAuthSession()).toEqual({ required: true, authenticated: false });
    expect(fn).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({ credentials: 'same-origin' }));
    mockFetch(200, { required: true, authenticated: true });
    expect(await fetchAuthSession()).toEqual({ required: true, authenticated: true });
  });

  it('corpo inesperado vira booleano falso; erro do servidor lança', async () => {
    mockFetch(200, { required: 'sim' });
    expect(await fetchAuthSession()).toEqual({ required: false, authenticated: false });
    mockFetch(500, {});
    await expect(fetchAuthSession()).rejects.toThrow();
  });
});

describe('login', () => {
  it('traduz o status do servidor', async () => {
    const fn = mockFetch(200, { ok: true, authenticated: true });
    expect(await login('segredo')).toBe('ok');
    expect(fn).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'segredo' }) }));
    mockFetch(401, { error: 'Invalid password.' });
    expect(await login('x')).toBe('unauthorized');
    mockFetch(429, { error: 'Too many login attempts.' });
    expect(await login('x')).toBe('rate_limited');
    mockFetch(500, {});
    expect(await login('x')).toBe('error');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await login('x')).toBe('error');
  });

  it('login ok marca a sessão como autenticada', async () => {
    mockFetch(200, { ok: true });
    await login('segredo');
    expect(getAuth().authenticated).toBe(true);
  });
});

describe('logout', () => {
  it('POST em /api/auth/logout e limpa o estado', async () => {
    setAuth({ required: true, authenticated: true });
    const fn = mockFetch(200, { ok: true });
    await logout();
    expect(fn).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    );
    expect(getAuth()).toEqual({ required: true, authenticated: false });
  });

  it('falha de rede no logout não lança', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(logout()).resolves.toBeUndefined();
  });
});

describe('401 no meio da sessão', () => {
  it('reportUnauthorized zera authenticated e avisa uma vez por vez', () => {
    setAuth({ required: true, authenticated: true });
    const cb = vi.fn();
    const off = onAuthRequired(cb);
    reportUnauthorized();
    expect(getAuth()).toEqual({ required: true, authenticated: false });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    reportUnauthorized();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
