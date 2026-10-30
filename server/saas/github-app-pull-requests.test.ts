import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppPullRequestsLoader,
  GitHubAppPullRequestsError,
  type GitHubAppPullRequestsGitHubAdapter,
} from './github-app-pull-requests';
import type { GitHubRepositoriesStore } from './postgres-stores';
import type { SaasSessionManager } from './sessions';

const REPOSITORY = {
  repositoryId: '9001',
  installationId: '7001',
  fullName: 'octo/example',
  isPrivate: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octo/example',
  isSelected: true,
};

const PULL_REQUESTS = {
  pullRequests: [{
    number: 17,
    title: 'Add safer parser',
    draft: false,
    updatedAt: '2026-10-30T20:00:00Z',
    headSha: 'a'.repeat(40),
    htmlUrl: 'https://github.com/octo/example/pull/17',
  }],
  hasMore: false,
};

function setup(overrides: {
  session?: unknown;
  repositories?: readonly (typeof REPOSITORY)[];
  listOpenPullRequests?: GitHubAppPullRequestsGitHubAdapter['listOpenPullRequests'];
} = {}) {
  const sessions = {
    get: vi.fn(async () => Object.hasOwn(overrides, 'session') ? overrides.session : { githubUserId: '12345', expiresAt: 30_000 }),
  } as unknown as SaasSessionManager;
  const repositoriesStore = {
    listForUser: vi.fn(async () => overrides.repositories ?? [REPOSITORY]),
  } as unknown as GitHubRepositoriesStore;
  const github: GitHubAppPullRequestsGitHubAdapter = {
    listOpenPullRequests: overrides.listOpenPullRequests ?? vi.fn(async () => PULL_REQUESTS),
  };
  return {
    loader: createGitHubAppPullRequestsLoader({ sessions, repositoriesStore, github }),
    sessions,
    repositoriesStore,
    github,
  };
}

describe('GitHub App pull request loader', () => {
  it('loads only the signed-in user’s selected repository and validates the PR response', async () => {
    const { loader, sessions, repositoriesStore, github } = setup();

    await expect(loader.load('s'.repeat(43))).resolves.toEqual({
      repositoryFullName: 'octo/example',
      pullRequests: PULL_REQUESTS.pullRequests,
      hasMore: false,
    });
    expect(sessions.get).toHaveBeenCalledWith('s'.repeat(43));
    expect(repositoriesStore.listForUser).toHaveBeenCalledWith('12345');
    expect(github.listOpenPullRequests).toHaveBeenCalledWith({
      installationId: '7001',
      repositoryId: '9001',
      repositoryFullName: 'octo/example',
    });
  });

  it('does not call GitHub without a valid Office session or a selected repository', async () => {
    const unauthenticated = setup({ session: undefined });
    await expect(unauthenticated.loader.load('s'.repeat(43))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(unauthenticated.repositoriesStore.listForUser).not.toHaveBeenCalled();
    expect(unauthenticated.github.listOpenPullRequests).not.toHaveBeenCalled();

    const noSelection = setup({ repositories: [{ ...REPOSITORY, isSelected: false }] });
    await expect(noSelection.loader.load('s'.repeat(43))).rejects.toMatchObject({ code: 'repository_required' });
    expect(noSelection.github.listOpenPullRequests).not.toHaveBeenCalled();
  });

  it('rejects malformed selected repository rows and malformed upstream PR summaries', async () => {
    const badRepository = setup({ repositories: [{ ...REPOSITORY, repositoryId: '9001?owner=other' }] });
    await expect(badRepository.loader.load('s'.repeat(43))).rejects.toMatchObject({ code: 'repository_required' });
    expect(badRepository.github.listOpenPullRequests).not.toHaveBeenCalled();

    const malformedPullRequests = setup({ listOpenPullRequests: vi.fn(async () => ({
      pullRequests: [{ ...PULL_REQUESTS.pullRequests[0], htmlUrl: 'https://attacker.example' }],
      hasMore: false,
    })) });
    await expect(malformedPullRequests.loader.load('s'.repeat(43)))
      .rejects.toBeInstanceOf(GitHubAppPullRequestsError);
  });

  it('hides session store and GitHub adapter failures', async () => {
    const sessionFailure = setup();
    vi.mocked(sessionFailure.sessions.get).mockRejectedValueOnce(new Error('secret session store detail'));
    const sessionError = await sessionFailure.loader.load('s'.repeat(43)).catch((error: unknown) => error);
    expect(sessionError).toMatchObject({ code: 'unauthenticated' });
    expect(String(sessionError)).not.toContain('secret session store detail');

    const githubFailure = setup({
      listOpenPullRequests: vi.fn(async () => { throw new Error('GitHub token must not leak'); }),
    });
    await expect(githubFailure.loader.load('s'.repeat(43))).rejects.toMatchObject({ code: 'adapter_failure' });
    await expect(githubFailure.loader.load('s'.repeat(43))).rejects.not.toThrow('GitHub token must not leak');
  });
});
