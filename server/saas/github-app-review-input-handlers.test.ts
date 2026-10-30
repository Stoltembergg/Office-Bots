import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppReviewInputHandlers,
  type GitHubAppReviewInputRuntime,
} from './github-app-review-input-handlers';

const SESSION_COOKIE = '__Host-office_bots_session';
const SESSION = 's'.repeat(43);
const PREPARED_INPUT = {
  githubUserId: '101',
  installationId: '303',
  repositoryId: '404',
  pullRequest: { number: 17, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
  files: [{ filename: 'src/example.ts', patch: 'synthetic private patch content' }],
  completeness: 'unverified' as const,
};

function request(method: string, url: string, cookie?: string): IncomingMessage {
  return { method, url, headers: cookie ? { cookie } : {} } as unknown as IncomingMessage;
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
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    end(chunk?: string | Uint8Array) {
      if (typeof chunk === 'string') bodyText += chunk;
      else if (chunk) bodyText += Buffer.from(chunk).toString('utf8');
      state.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { target, status: () => statusCode, header: (name) => headers.get(name.toLowerCase()), body: () => bodyText };
}

function setup(load = vi.fn(async () => PREPARED_INPUT)) {
  const runtime: GitHubAppReviewInputRuntime = { loader: { load } };
  return { loader: runtime.loader, handlers: createGitHubAppReviewInputHandlers(runtime) };
}

describe('GitHub App review input HTTP handler', () => {
  it('returns only PR refs and filenames, never patches or authorization identifiers', async () => {
    const load = vi.fn(async () => PREPARED_INPUT);
    const { handlers } = setup(load);
    const res = response();

    await handlers.prepare(request('GET', '/api/github/pull-requests/input?number=17', `${SESSION_COOKIE}=${SESSION}`), res.target);

    expect(load).toHaveBeenCalledWith({ sessionCredential: SESSION, pullNumber: 17 });
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.body())).toEqual({
      pullRequest: { number: 17, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      files: [{ filename: 'src/example.ts' }],
      completeness: 'unverified',
    });
    expect(res.body()).not.toContain('synthetic private patch content');
    expect(res.body()).not.toContain('installationId');
    expect(res.body()).not.toContain('repositoryId');
    expect(res.header('cache-control')).toBe('no-store');
  });

  it('requires exactly one positive numeric PR number and an authenticated session', async () => {
    const load = vi.fn(async () => PREPARED_INPUT);
    const { handlers } = setup(load);
    for (const url of [
      '/api/github/pull-requests/input',
      '/api/github/pull-requests/input?number=0',
      '/api/github/pull-requests/input?number=17&number=18',
      '/api/github/pull-requests/input?number=17&repositoryId=404',
    ]) {
      const res = response();
      await handlers.prepare(request('GET', url, `${SESSION_COOKIE}=${SESSION}`), res.target);
      expect(res.status()).toBe(400);
    }
    const unauthenticated = response();
    await handlers.prepare(request('GET', '/api/github/pull-requests/input?number=17'), unauthenticated.target);
    expect(unauthenticated.status()).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it('maps missing selection and provider failures without leaking errors', async () => {
    const missingSelection = setup(vi.fn(async () => {
      throw Object.assign(new Error('private db row'), { code: 'repository_required' });
    }));
    const conflict = response();
    await missingSelection.handlers.prepare(request('GET', '/api/github/pull-requests/input?number=17', `${SESSION_COOKIE}=${SESSION}`), conflict.target);
    expect(conflict.status()).toBe(409);
    expect(conflict.body()).not.toContain('private db row');

    const failure = setup(vi.fn(async () => {
      throw Object.assign(new Error('synthetic private patch'), { code: 'adapter_failure' });
    }));
    const unavailable = response();
    await failure.handlers.prepare(request('GET', '/api/github/pull-requests/input?number=17', `${SESSION_COOKIE}=${SESSION}`), unavailable.target);
    expect(unavailable.status()).toBe(502);
    expect(unavailable.body()).not.toContain('synthetic private patch');
  });
});
