import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppPullRequestsHandlers,
  type GitHubAppPullRequestsRuntime,
} from './github-app-pull-requests-handlers';

const SESSION_COOKIE = '__Host-office_bots_session';
const SESSION = 's'.repeat(43);
const RESULT = {
  repositoryFullName: 'octo/example',
  pullRequests: [{
    number: 17,
    title: 'Add safer parser',
    draft: false,
    updatedAt: '2026-10-30T20:00:00Z',
    headSha: 'a'.repeat(40),
    htmlUrl: 'https://github.com/octo/example/pull/17',
  }],
  hasMore: true,
};

function request(method: string, cookie?: string): IncomingMessage {
  return { method, headers: cookie ? { cookie } : {} } as unknown as IncomingMessage;
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

function setup(load: GitHubAppPullRequestsRuntime['loader']['load'] = vi.fn(async () => RESULT)) {
  const runtime: GitHubAppPullRequestsRuntime = { loader: { load } };
  return { runtime, handlers: createGitHubAppPullRequestsHandlers(runtime) };
}

describe('GitHub App pull request HTTP handler', () => {
  it('returns the selected repository’s bounded PR metadata without caching it', async () => {
    const load = vi.fn(async () => RESULT);
    const { handlers } = setup(load);
    const res = response();

    await handlers.list(request('GET', `${SESSION_COOKIE}=${SESSION}`), res.target);

    expect(load).toHaveBeenCalledWith(SESSION);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual(RESULT);
    expect(res.header('cache-control')).toBe('no-store');
    expect(res.header('x-content-type-options')).toBe('nosniff');
  });

  it('requires a session, allows only GET, and maps missing selection without leaking errors', async () => {
    const load = vi.fn(async () => { throw Object.assign(new Error('private details'), { code: 'repository_required' }); });
    const { handlers } = setup(load);
    const noSession = response();
    await handlers.list(request('GET'), noSession.target);
    expect(noSession.status()).toBe(401);
    expect(load).not.toHaveBeenCalled();

    const wrongMethod = response();
    await handlers.list(request('POST', `${SESSION_COOKIE}=${SESSION}`), wrongMethod.target);
    expect(wrongMethod.status()).toBe(405);
    expect(wrongMethod.header('allow')).toBe('GET');

    const noSelection = response();
    await handlers.list(request('GET', `${SESSION_COOKIE}=${SESSION}`), noSelection.target);
    expect(noSelection.status()).toBe(409);
    expect(noSelection.body()).not.toContain('private details');
  });

  it('returns generic service errors and does not reflect malformed cookie data', async () => {
    const load = vi.fn(async () => { throw Object.assign(new Error('token leaked'), { code: 'adapter_failure' }); });
    const { handlers } = setup(load);
    const invalidCookie = response();
    await handlers.list(request('GET', `${SESSION_COOKIE}=bad`), invalidCookie.target);
    expect(invalidCookie.status()).toBe(401);
    expect(load).not.toHaveBeenCalled();

    const failure = response();
    await handlers.list(request('GET', `${SESSION_COOKIE}=${SESSION}`), failure.target);
    expect(failure.status()).toBe(502);
    expect(failure.body()).not.toContain('token leaked');
  });
});
