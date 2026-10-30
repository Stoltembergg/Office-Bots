import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubWebAuthHandlers } from './github-web-auth-handlers';
import type { GitHubWebAuthRuntime } from './github-web-auth-runtime';

const BINDING_COOKIE = '__Host-office_bots_oauth_binding';
const SESSION_COOKIE = '__Host-office_bots_session';

function request(method: string, url = '/', headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

function response(): { target: ServerResponse; status: () => number; header: (name: string) => unknown; body: () => string } {
  let statusCode = 0;
  let bodyText = '';
  const headers = new Map<string, unknown>();
  const state = { headersSent: false, writableEnded: false };
  const target = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead(code: number, values: Record<string, unknown> = {}) {
      statusCode = code;
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value);
      state.headersSent = true;
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string | Uint8Array) {
      if (typeof chunk === 'string') bodyText += chunk;
      else if (chunk) bodyText += Buffer.from(chunk).toString('utf8');
      state.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return {
    target,
    status: () => statusCode,
    header: (name) => headers.get(name.toLowerCase()),
    body: () => bodyText,
  };
}

function cookies(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function setup() {
  const runtime = {
    appOrigin: 'https://office-bots.example',
    flow: {
      beginAuthorization: vi.fn(async () => ({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=state' })),
      completeAuthorization: vi.fn(async () => ({ githubUserId: '12345' })),
    },
    sessions: {
      create: vi.fn(async () => ({ token: 'a'.repeat(43), expiresAt: Date.now() + 7 * 24 * 60 * 60_000 })),
      get: vi.fn(async () => ({ githubUserId: '12345', expiresAt: Date.now() + 60_000 })),
      revoke: vi.fn(async () => true),
    },
  } as unknown as GitHubWebAuthRuntime;
  return { handlers: createGitHubWebAuthHandlers(runtime), runtime };
}

describe('GitHub web auth HTTP handlers', () => {
  it('starts OAuth with a short-lived, secure browser-binding cookie', async () => {
    const { handlers, runtime } = setup();
    const res = response();

    await handlers.start(request('GET'), res.target);

    expect(res.status()).toBe(302);
    expect(res.header('location')).toBe('https://github.com/login/oauth/authorize?state=state');
    const setCookie = cookies(res.header('set-cookie'));
    const bindingCookie = setCookie.find((value) => value.startsWith(`${BINDING_COOKIE}=`));
    expect(bindingCookie).toMatch(/; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect((bindingCookie?.split('=', 2)[1] ?? '').split(';')[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runtime.flow.beginAuthorization).toHaveBeenCalledOnce();
  });

  it('creates an opaque session after a valid callback and clears OAuth state', async () => {
    const { handlers, runtime } = setup();
    const binding = 'b'.repeat(43);
    const res = response();

    await handlers.callback(
      request('GET', '/api/auth/github/callback?code=oauth-code&state=oauth-state', {
        cookie: `${BINDING_COOKIE}=${binding}`,
      }),
      res.target,
    );

    expect(runtime.flow.completeAuthorization).toHaveBeenCalledWith({
      code: 'oauth-code',
      state: 'oauth-state',
      browserBinding: binding,
    });
    expect(runtime.sessions.create).toHaveBeenCalledWith('12345');
    expect(res.status()).toBe(303);
    expect(res.header('location')).toBe('https://office-bots.example/?login=success');
    const setCookie = cookies(res.header('set-cookie'));
    expect(setCookie.find((value) => value.startsWith(`${SESSION_COOKIE}=`))).toMatch(/; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(setCookie.find((value) => value.startsWith(`${BINDING_COOKIE}=`))).toContain('Max-Age=0');
  });

  it('returns only the authenticated identity, never the session token', async () => {
    const { handlers } = setup();
    const res = response();

    await handlers.session(request('GET', '/api/session', { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` }), res.target);

    expect(res.status()).toBe(200);
    expect(res.header('cache-control')).toBe('no-store');
    expect(JSON.parse(res.body())).toEqual({ authenticated: true, githubUserId: '12345' });
    expect(res.body()).not.toContain('a'.repeat(43));
  });

  it('rejects cross-origin logout and revokes same-origin logout', async () => {
    const { handlers, runtime } = setup();
    const token = 'a'.repeat(43);
    const rejected = response();

    await handlers.logout(request('POST', '/api/logout', {
      origin: 'https://attacker.example',
      cookie: `${SESSION_COOKIE}=${token}`,
    }), rejected.target);

    expect(rejected.status()).toBe(403);
    expect(runtime.sessions.revoke).not.toHaveBeenCalled();

    const accepted = response();
    await handlers.logout(request('POST', '/api/logout', {
      origin: 'https://office-bots.example',
      cookie: `${SESSION_COOKIE}=${token}`,
    }), accepted.target);

    expect(accepted.status()).toBe(200);
    expect(runtime.sessions.revoke).toHaveBeenCalledWith(token);
    expect(cookies(accepted.header('set-cookie')).join(';')).toContain('Max-Age=0');
  });
});
