import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppRepositoriesAdapter,
  GitHubAppRepositoriesAdapterError,
} from './github-app-repositories-adapter';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/vnd.github+json; charset=utf-8' },
  });
}

function repo(id: number, fullName: string, installationId: number) {
  const [login, name] = fullName.split('/');
  return {
    id,
    name,
    full_name: fullName,
    owner: { login },
    private: true,
    default_branch: 'main',
    html_url: `https://github.com/${fullName}`,
    installationId,
  };
}

describe('GitHub App repositories API adapter', () => {
  it('lists only this app’s user-authorized repositories and follows pagination', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/user/installations?')) {
        const page = new URL(url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse({
            total_count: 101,
            installations: Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, app_slug: 'some-other-app' })),
          });
        }
        if (page === '2') return jsonResponse({ total_count: 101, installations: [{ id: 22, app_slug: 'office-bots' }] });
      }
      if (url.includes('/user/installations/22/repositories?')) {
        const page = new URL(url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse({
            total_count: 101,
            repositories: Array.from({ length: 100 }, (_, index) =>
              repo(101 + index, `octo/repo-${String(index + 1).padStart(3, '0')}`, 22)),
          });
        }
        if (page === '2') return jsonResponse({ total_count: 101, repositories: [repo(201, 'octo/repo-101', 22)] });
      }
      return jsonResponse({ total_count: 0, installations: [], repositories: [] });
    });
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch });

    await expect(adapter.listRepositories('ghu_test_token')).resolves.toEqual({
      installationCount: 1,
      repositories: expect.arrayContaining([
        {
          repositoryId: '101',
          installationId: '22',
          fullName: 'octo/repo-001',
          isPrivate: true,
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/octo/repo-001',
        },
        {
          repositoryId: '201',
          installationId: '22',
          fullName: 'octo/repo-101',
          isPrivate: true,
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/octo/repo-101',
        },
      ]),
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/user/installations',
      '/user/installations',
      '/user/installations/22/repositories',
      '/user/installations/22/repositories',
    ]);
    expect(calls.every((call) => (call.init?.headers as Record<string, string>).authorization === 'Bearer ghu_test_token'))
      .toBe(true);
    expect(calls.some((call) => call.url.includes('/11/'))).toBe(false);
    expect(calls[0]?.url).toContain('per_page=100&page=1');
    expect(calls[1]?.url).toContain('per_page=100&page=2');
  });

  it('rejects malformed and spoofed GitHub response records without exposing upstream data', async () => {
    const fetch = vi.fn(async (): Promise<Response> => jsonResponse({
      total_count: 1,
      installations: [{ id: 22, app_slug: 'office-bots' }],
    }));
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch });

    await expect(adapter.listRepositories('ghu_test_token')).rejects.toBeInstanceOf(GitHubAppRepositoriesAdapterError);
    await expect(adapter.listRepositories('ghu_test_token')).rejects.not.toThrow('office-bots');
  });

  it('rejects malformed installation IDs before constructing a repository endpoint', async () => {
    const fetch = vi.fn(async (): Promise<Response> => jsonResponse({
      total_count: 1,
      installations: [{ id: '../22', app_slug: 'office-bots' }],
    }));
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch });

    await expect(adapter.listRepositories('ghu_test_token')).rejects.toBeInstanceOf(GitHubAppRepositoriesAdapterError);
  });

  it('returns no repositories for installations belonging to another app', async () => {
    const fetch = vi.fn(async (): Promise<Response> => jsonResponse({
      total_count: 1,
      installations: [{ id: 22, app_slug: 'another-app' }],
    }));
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch });

    await expect(adapter.listRepositories('ghu_test_token')).resolves.toEqual({ installationCount: 0, repositories: [] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fails when pagination exceeds its explicit repository bound', async () => {
    const fetch = vi.fn(async (): Promise<Response> => jsonResponse({ total_count: 10_001, installations: [] }));
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch });

    await expect(adapter.listRepositories('ghu_test_token')).rejects.toBeInstanceOf(GitHubAppRepositoriesAdapterError);
  });

  it('times out even when the fetch implementation ignores abort', async () => {
    const fetch = vi.fn(async (): Promise<Response> => await new Promise(() => undefined));
    const adapter = createGitHubAppRepositoriesAdapter({ appSlug: 'office-bots', fetch, timeoutMs: 5 });

    await expect(adapter.listRepositories('ghu_test_token')).rejects.toBeInstanceOf(GitHubAppRepositoriesAdapterError);
  });
});
