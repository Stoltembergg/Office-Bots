import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubAppRepositoriesHandlers } from './github-app-repositories-handlers';
import type { GitHubAppRepositoriesRuntime } from './github-app-repositories-runtime';

const SESSION_COOKIE = '__Host-office_bots_session';
const BINDING_COOKIE = '__Host-office_bots_app_binding';
const TOKEN = 'ghu_synthetic_ephemeral_token';
const REPOSITORIES = [{
  repositoryId: '9001',
  installationId: '7001',
  fullName: 'octo/example',
  isPrivate: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octo/example',
  isSelected: false,
}];

function request(
  method: string,
  url = '/',
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  return { method, url, headers, body } as unknown as IncomingMessage;
}

function response(): {
  target: ServerResponse;
  status: () => number;
  header: (name: string) => unknown;
  body: () => string;
} {
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

function setup(overrides: Record<string, unknown> = {}) {
  const runtime = {
    appOrigin: 'https://office-bots.example',
    appSlug: 'office-bots',
    flow: {
      beginAuthorization: vi.fn(async () => ({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=state' })),
      completeAuthorization: vi.fn(async () => ({
        githubUserId: '12345',
        installationCount: 1,
        repositories: REPOSITORIES.map(({ isSelected: _selected, ...repository }) => repository),
      })),
    },
    sessions: {
      get: vi.fn(async () => ({ githubUserId: '12345', expiresAt: Date.now() + 60_000 })),
    },
    repositoriesStore: {
      replaceForUser: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => REPOSITORIES),
      setSelectedForUser: vi.fn(async () => true),
    },
    now: () => 20_000,
    ...overrides,
  } as unknown as GitHubAppRepositoriesRuntime;
  return { handlers: createGitHubAppRepositoriesHandlers(runtime), runtime };
}

describe('GitHub App repository HTTP handlers', () => {
  it('starts user authorization only for the authenticated Office account', async () => {
    const { handlers, runtime } = setup();
    const res = response();

    await handlers.authorize(request('GET', '/api/github/app/authorize', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
    }), res.target);

    expect(res.status()).toBe(302);
    expect(res.header('location')).toBe('https://github.com/login/oauth/authorize?state=state');
    expect(runtime.flow.beginAuthorization).toHaveBeenCalledWith('12345', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(cookies(res.header('set-cookie')).find((value) => value.startsWith(`${BINDING_COOKIE}=`)))
      .toMatch(/; Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('synchronizes repository metadata after callback and never puts credentials in redirects', async () => {
    const { handlers, runtime } = setup();
    const binding = 'b'.repeat(43);
    const res = response();

    await handlers.callback(request('GET', '/api/github/app/callback?code=oauth-code&state=oauth-state', {
      cookie: `${BINDING_COOKIE}=${binding}; ${SESSION_COOKIE}=${'s'.repeat(43)}`,
    }), res.target);

    expect(runtime.flow.completeAuthorization).toHaveBeenCalledWith({
      code: 'oauth-code',
      state: 'oauth-state',
      browserBinding: binding,
      expectedGithubUserId: '12345',
    });
    expect(runtime.repositoriesStore.replaceForUser).toHaveBeenCalledWith(
      '12345',
      [{
        repositoryId: '9001',
        installationId: '7001',
        fullName: 'octo/example',
        isPrivate: true,
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/octo/example',
      }],
      20_000,
    );
    expect(res.status()).toBe(303);
    expect(res.header('location')).toBe('https://office-bots.example/?github=connected');
    expect(String(res.header('location'))).not.toContain(TOKEN);
    expect(cookies(res.header('set-cookie')).find((value) => value.startsWith(`${BINDING_COOKIE}=`)))
      .toContain('Max-Age=0');
  });

  it('shows an install link when the authorized user has no installation of this app', async () => {
    const { handlers, runtime } = setup({
      flow: {
        beginAuthorization: vi.fn(),
        completeAuthorization: vi.fn(async () => ({ githubUserId: '12345', installationCount: 0, repositories: [] })),
      },
    });
    const res = response();

    await handlers.callback(request('GET', '/api/github/app/callback?code=oauth-code&state=oauth-state', {
      cookie: `${BINDING_COOKIE}=${'b'.repeat(43)}; ${SESSION_COOKIE}=${'s'.repeat(43)}`,
    }), res.target);

    expect(res.header('location')).toBe('https://office-bots.example/?github=install-required');
    expect(runtime.repositoriesStore.replaceForUser).toHaveBeenCalledWith('12345', [], 20_000);
  });

  it('returns only the signed-in user’s repositories', async () => {
    const { handlers, runtime } = setup();
    const res = response();

    await handlers.repositories(request('GET', '/api/github/repositories', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
    }), res.target);

    expect(res.status()).toBe(200);
    expect(runtime.repositoriesStore.listForUser).toHaveBeenCalledWith('12345');
    expect(JSON.parse(res.body())).toEqual({ repositories: [{
      repositoryId: '9001',
      fullName: 'octo/example',
      isPrivate: true,
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/octo/example',
      isSelected: false,
    }] });
    expect(res.header('cache-control')).toBe('no-store');
  });

  it('requires an Office session for repository reads and refuses cross-origin selection changes', async () => {
    const unauthenticated = setup({ sessions: { get: vi.fn(async () => undefined) } });
    const read = response();
    await unauthenticated.handlers.repositories(request('GET', '/api/github/repositories'), read.target);
    expect(read.status()).toBe(401);

    const { handlers, runtime } = setup();
    const rejected = response();
    await handlers.selectRepository(request('PUT', '/api/github/repositories/selected', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    }, { repositoryId: '9001' }), rejected.target);
    expect(rejected.status()).toBe(403);
    expect(runtime.repositoriesStore.setSelectedForUser).not.toHaveBeenCalled();
  });

  it('rejects a repository ID that the current user does not own', async () => {
    const { handlers, runtime } = setup({ repositoriesStore: {
      replaceForUser: vi.fn(),
      listForUser: vi.fn(),
      setSelectedForUser: vi.fn(async () => false),
    } });
    const res = response();

    await handlers.selectRepository(request('PUT', '/api/github/repositories/selected', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
      origin: 'https://office-bots.example',
      'content-type': 'application/json',
    }, { repositoryId: '9001' }), res.target);

    expect(res.status()).toBe(404);
    expect(runtime.repositoriesStore.setSelectedForUser).toHaveBeenCalledWith('12345', '9001', 20_000);
  });

  it('rejects oversized or unexpected selection payloads before touching the repository store', async () => {
    const { handlers, runtime } = setup();
    const oversized = response();
    await handlers.selectRepository(request('PUT', '/api/github/repositories/selected', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
      origin: 'https://office-bots.example',
      'content-type': 'application/json',
      'content-length': '2048',
    }, { repositoryId: '9001' }), oversized.target);
    expect(oversized.status()).toBe(400);

    const extraFields = response();
    await handlers.selectRepository(request('PUT', '/api/github/repositories/selected', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
      origin: 'https://office-bots.example',
      'content-type': 'application/json',
    }, { repositoryId: '9001', ownerId: '67890' }), extraFields.target);
    expect(extraFields.status()).toBe(400);
    expect(runtime.repositoriesStore.setSelectedForUser).not.toHaveBeenCalled();
  });

  it('installs only the configured GitHub App and does not use a caller-supplied destination', async () => {
    const { handlers, runtime } = setup();
    const res = response();

    await handlers.install(request('GET', '/api/github/app/install?next=https://attacker.example', {
      cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
    }), res.target);

    expect(res.status()).toBe(302);
    expect(res.header('location')).toBe('https://github.com/apps/office-bots/installations/new');
    expect(String(res.header('location'))).not.toContain('attacker');
    expect(runtime.sessions.get).toHaveBeenCalledOnce();
  });
});
