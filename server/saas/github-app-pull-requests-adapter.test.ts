import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppPullRequestsAdapter,
  GitHubAppPullRequestsAdapterError,
} from './github-app-pull-requests-adapter';

const INSTALLATION_TOKEN = 'ghs_synthetic_installation_token';
const BASE_SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-30T21:00:00.000Z');

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/vnd.github+json; charset=utf-8', ...headers },
  });
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 17,
    title: 'Add safer parser',
    draft: false,
    updated_at: '2026-10-30T20:00:00Z',
    html_url: 'https://github.com/octo/example/pull/17',
    head: { sha: BASE_SHA },
    base: { repo: { id: 9001 } },
    ...overrides,
  };
}

function configuredAdapter(fetch: typeof globalThis.fetch, now = () => NOW) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: keys.publicKey,
    adapter: createGitHubAppPullRequestsAdapter({
      appId: '123456',
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fetch,
      now,
    }),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    installationId: '7001',
    repositoryId: '9001',
    repositoryFullName: 'octo/example',
    ...overrides,
  };
}

describe('GitHub App pull request adapter', () => {
  it('mints a short-lived RS256 app JWT and a read-only installation token restricted to one repository', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith('/app/installations/7001/access_tokens')) {
        return jsonResponse({
          token: INSTALLATION_TOKEN,
          expires_at: '2026-10-30T22:00:00Z',
          permissions: { pull_requests: 'read' },
        }, 201);
      }
      if (href.endsWith('/repos/octo/example')) {
        return jsonResponse({ id: 9001, full_name: 'octo/example' });
      }
      if (href.includes('/repos/octo/example/pulls?')) {
        return jsonResponse([pullRequest()], 200, {
          link: '<https://api.github.com/repos/octo/example/pulls?page=2>; rel="next"',
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
    const { adapter, publicKey } = configuredAdapter(fetch);

    await expect(adapter.listOpenPullRequests(input())).resolves.toEqual({
      pullRequests: [{
        number: 17,
        title: 'Add safer parser',
        draft: false,
        updatedAt: '2026-10-30T20:00:00Z',
        headSha: BASE_SHA,
        htmlUrl: 'https://github.com/octo/example/pull/17',
      }],
      hasMore: true,
    });

    expect(calls).toHaveLength(3);
    expect(new URL(calls[2]!.url).searchParams.toString()).toBe('state=open&sort=updated&direction=desc&per_page=100&page=1');
    const tokenCall = calls[0]!;
    expect(tokenCall.init?.method).toBe('POST');
    expect(JSON.parse(String(tokenCall.init?.body))).toEqual({
      repositories: ['octo/example'],
      permissions: { pull_requests: 'read' },
    });
    const appJwt = (tokenCall.init?.headers as Record<string, string>).authorization?.slice('Bearer '.length);
    expect(appJwt).toBeDefined();
    const [header, payload, signature] = appJwt!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual({
      iss: '123456',
      iat: Math.floor(NOW / 1000) - 30,
      exp: Math.floor(NOW / 1000) + 540,
    });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')))
      .toBe(true);
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: `Bearer ${INSTALLATION_TOKEN}` });
    expect(calls[2]?.init?.headers).toMatchObject({ authorization: `Bearer ${INSTALLATION_TOKEN}` });
  });

  it('rejects pull requests returned for another repository without exposing the response', async () => {
    const responses = [
      jsonResponse({ token: INSTALLATION_TOKEN, expires_at: '2026-10-30T22:00:00Z', permissions: { pull_requests: 'read' } }, 201),
      jsonResponse({ id: 9001, full_name: 'octo/example' }),
      jsonResponse([pullRequest({ base: { repo: { id: 88 } } })]),
    ];
    const fetch = vi.fn(async (): Promise<Response> => responses.shift()!);
    const { adapter } = configuredAdapter(fetch);

    const failure = await adapter.listOpenPullRequests(input()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    expect(String(failure)).not.toContain('octo/example');
  });

  it('rejects duplicate PR numbers in an upstream page', async () => {
    const fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const href = String(url);
      if (href.endsWith('/access_tokens')) {
        return jsonResponse({
          token: INSTALLATION_TOKEN,
          expires_at: '2026-10-30T22:00:00Z',
          permissions: { pull_requests: 'read' },
        }, 201);
      }
      if (href.includes('/pulls?')) return jsonResponse([pullRequest(), pullRequest()]);
      return jsonResponse({ id: 9001, full_name: 'octo/example' });
    });
    const { adapter } = configuredAdapter(fetch);

    await expect(adapter.listOpenPullRequests(input())).rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
  });

  it('rejects a repository identity mismatch before listing pull requests', async () => {
    const fetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const href = String(url);
      if (href.endsWith('/access_tokens')) {
        return jsonResponse({
          token: INSTALLATION_TOKEN,
          expires_at: '2026-10-30T22:00:00Z',
          permissions: { pull_requests: 'read' },
        }, 201);
      }
      if (href.includes('/pulls?')) return jsonResponse([]);
      return jsonResponse({ id: 9002, full_name: 'octo/example' });
    });
    const { adapter } = configuredAdapter(fetch);

    await expect(adapter.listOpenPullRequests(input())).rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects missing read permission, malformed upstream data, and untrusted repository selectors', async () => {
    const missingPermission = [
      jsonResponse({ token: INSTALLATION_TOKEN, expires_at: '2026-10-30T22:00:00Z', permissions: { contents: 'read' } }, 201),
    ];
    const { adapter } = configuredAdapter(vi.fn(async (): Promise<Response> => missingPermission.shift()!));
    await expect(adapter.listOpenPullRequests(input())).rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);

    const unusedFetch = vi.fn(async (): Promise<Response> => jsonResponse([]));
    const invalid = configuredAdapter(unusedFetch).adapter;
    await expect(invalid.listOpenPullRequests(input({ repositoryFullName: 'octo/../secrets' })))
      .rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    await expect(invalid.listOpenPullRequests(input({ repositoryFullName: 'octo/..' })))
      .rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    await expect(invalid.listOpenPullRequests(input({ installationId: '7001?x=1' })))
      .rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    expect(unusedFetch).not.toHaveBeenCalled();
  });

  it('times out when a fetch implementation ignores abort and hides upstream errors', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const adapter = createGitHubAppPullRequestsAdapter({
      appId: '123456',
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      fetch: vi.fn(async (): Promise<Response> => await new Promise(() => undefined)),
      timeoutMs: 5,
      now: () => NOW,
    });

    await expect(adapter.listOpenPullRequests(input())).rejects.toBeInstanceOf(GitHubAppPullRequestsAdapterError);
    await expect(adapter.listOpenPullRequests(input())).rejects.not.toThrow('synthetic_installation_token');
  });
});
