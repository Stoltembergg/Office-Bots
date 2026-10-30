import { describe, expect, it, vi } from 'vitest';
import { createGitHubAppReviewInputLoader } from './github-app-review-input';
import type { GitHubAppRepositoryReadSession } from './github-app-pull-requests-adapter';
import type { GitHubRepositoriesStore } from './postgres-stores';
import type { SaasSessionManager } from './sessions';

const SESSION = 's'.repeat(43);
const USER_ID = '101';
const INSTALLATION_ID = '303';
const REPOSITORY_ID = '404';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function selectedRepository(isSelected = true) {
  return {
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    fullName: 'octo/example',
    isPrivate: true,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/octo/example',
    isSelected,
  };
}

function repositoryReadSession() {
  const session: GitHubAppRepositoryReadSession = {
    getRepositoryIdentity: vi.fn(async () => ({ repositoryId: REPOSITORY_ID, repositoryFullName: 'octo/example' })),
    getPullRequest: vi.fn(async () => ({
      repositoryId: REPOSITORY_ID,
      number: 17,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    })),
    listPullRequestFiles: vi.fn(async ({ page }) => ({
      repositoryId: REPOSITORY_ID,
      pullNumber: 17,
      page,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [{ filename: 'src/example.ts', patch: '@@ -1 +1 @@\n-old\n+new' }],
      hasNextPage: false,
    })),
    listOpenPullRequests: vi.fn(async () => ({ pullRequests: [], hasMore: false })),
  };
  return session;
}

function setup(options: { readonly repositories?: readonly unknown[] } = {}) {
  const readSession = repositoryReadSession();
  const sessions: SaasSessionManager = {
    create: vi.fn(),
    get: vi.fn(async (token: unknown) => token === SESSION ? { githubUserId: USER_ID, expiresAt: Date.now() + 60_000 } : undefined),
    revoke: vi.fn(),
  };
  const repositoriesStore = {
    listForUser: vi.fn(async () => options.repositories ?? [selectedRepository()]),
    replaceForUser: vi.fn(),
    setSelectedForUser: vi.fn(),
  } as unknown as GitHubRepositoriesStore;
  const github = {
    createRepositoryReadSession: vi.fn(async () => readSession),
    listOpenPullRequests: vi.fn(),
  };
  return {
    loader: createGitHubAppReviewInputLoader({ sessions, repositoriesStore, github }),
    sessions,
    repositoriesStore,
    github,
    readSession,
  };
}

describe('GitHub App review input loader', () => {
  it('reads only the authenticated user’s selected repository and returns bounded patches as unverified input', async () => {
    const { loader, repositoriesStore, github, readSession, sessions } = setup();

    const result = await loader.load({ sessionCredential: SESSION, pullNumber: 17 });

    expect(result).toEqual({
      githubUserId: USER_ID,
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      pullRequest: { number: 17, baseSha: BASE_SHA, headSha: HEAD_SHA },
      files: [{ filename: 'src/example.ts', patch: '@@ -1 +1 @@\n-old\n+new' }],
      completeness: 'unverified',
    });
    expect(repositoriesStore.listForUser).toHaveBeenCalledWith(USER_ID);
    expect(github.createRepositoryReadSession).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      repositoryFullName: 'octo/example',
    });
    expect(readSession.getRepositoryIdentity).toHaveBeenCalledTimes(3);
    expect(readSession.getPullRequest).toHaveBeenCalledTimes(2);
    expect(readSession.listPullRequestFiles).toHaveBeenCalledTimes(1);
    expect(sessions.get).toHaveBeenCalled();
  });

  it('rejects absent or ambiguous repository selections before minting a GitHub token', async () => {
    const { loader, github } = setup({ repositories: [selectedRepository(false)] });

    await expect(loader.load({ sessionCredential: SESSION, pullNumber: 17 }))
      .rejects.toMatchObject({ code: 'repository_required' });
    expect(github.createRepositoryReadSession).not.toHaveBeenCalled();
  });

  it('rejects an invalid PR number before reading session or repository state', async () => {
    const { loader, sessions, repositoriesStore } = setup();

    await expect(loader.load({ sessionCredential: SESSION, pullNumber: 0 }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(sessions.get).not.toHaveBeenCalled();
    expect(repositoriesStore.listForUser).not.toHaveBeenCalled();
  });

  it('discards the input if the repository is no longer selected during pagination', async () => {
    let reads = 0;
    const { loader, readSession, repositoriesStore } = setup();
    vi.mocked(repositoriesStore.listForUser).mockImplementation(async () => {
      reads += 1;
      return reads <= 2 ? [selectedRepository()] : [selectedRepository(false)];
    });
    vi.mocked(readSession.listPullRequestFiles).mockResolvedValue({
      repositoryId: REPOSITORY_ID,
      pullNumber: 17,
      page: 1,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [{ filename: 'src/example.ts', patch: '@@ -1 +1 @@\n-old\n+new' }],
      hasNextPage: true,
    });

    await expect(loader.load({ sessionCredential: SESSION, pullNumber: 17 }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
