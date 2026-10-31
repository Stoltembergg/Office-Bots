import type {
  GitHubAppPullRequestsRequest,
  GitHubPullRequestSummary,
  GitHubPullRequestsPage,
} from './github-app-pull-requests-adapter.js';
import type { GitHubRepositoriesStore } from './postgres-stores.js';
import type { SaasSessionManager } from './sessions.js';

const SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export type GitHubAppPullRequestsErrorCode =
  | 'configuration'
  | 'unauthenticated'
  | 'repository_required'
  | 'adapter_failure';

export class GitHubAppPullRequestsError extends Error {
  readonly code: GitHubAppPullRequestsErrorCode;

  constructor(code: GitHubAppPullRequestsErrorCode) {
    super('Pull requests could not be loaded');
    this.name = 'GitHubAppPullRequestsError';
    this.code = code;
  }
}

export interface GitHubAppPullRequestsGitHubAdapter {
  listOpenPullRequests(input: GitHubAppPullRequestsRequest): Promise<unknown>;
}

export interface GitHubAppPullRequestsLoaderDependencies {
  readonly sessions: SaasSessionManager;
  readonly repositoriesStore: GitHubRepositoriesStore;
  readonly github: GitHubAppPullRequestsGitHubAdapter;
}

export interface GitHubAppPullRequestsResult {
  readonly repositoryFullName: string;
  readonly pullRequests: readonly GitHubPullRequestSummary[];
  readonly hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function validRepositoryFullName(value: string): boolean {
  if (!REPOSITORY_NAME_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function sessionUserId(value: unknown): string | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const githubUserId = ownDataProperty(value, 'githubUserId');
    return typeof githubUserId === 'string' && GITHUB_ID_PATTERN.test(githubUserId) ? githubUserId : undefined;
  } catch {
    return undefined;
  }
}

function selectedRepository(value: unknown): GitHubAppPullRequestsRequest | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  let selection: GitHubAppPullRequestsRequest | undefined;
  let selectedCount = 0;
  try {
    for (const rawRepository of value) {
      if (!isRecord(rawRepository)) return undefined;
      const isSelected = ownDataProperty(rawRepository, 'isSelected');
      if (typeof isSelected !== 'boolean') return undefined;
      if (!isSelected) continue;
      selectedCount += 1;
      const repositoryId = ownDataProperty(rawRepository, 'repositoryId');
      const installationId = ownDataProperty(rawRepository, 'installationId');
      const repositoryFullName = ownDataProperty(rawRepository, 'fullName');
      if (
        typeof repositoryId !== 'string' ||
        !GITHUB_ID_PATTERN.test(repositoryId) ||
        typeof installationId !== 'string' ||
        !GITHUB_ID_PATTERN.test(installationId) ||
        typeof repositoryFullName !== 'string' ||
        !validRepositoryFullName(repositoryFullName) ||
        ownDataProperty(rawRepository, 'htmlUrl') !== `https://github.com/${repositoryFullName}`
      ) {
        return undefined;
      }
      selection = Object.freeze({ installationId, repositoryId, repositoryFullName });
    }
  } catch {
    return undefined;
  }
  return selectedCount === 1 ? selection : undefined;
}

function parseUpdatedAt(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function parsePullRequests(value: unknown, repositoryFullName: string): GitHubPullRequestsPage {
  if (!isRecord(value)) throw new GitHubAppPullRequestsError('adapter_failure');
  const pullRequests = ownDataProperty(value, 'pullRequests');
  const hasMore = ownDataProperty(value, 'hasMore');
  if (!Array.isArray(pullRequests) || pullRequests.length > 100 || typeof hasMore !== 'boolean') {
    throw new GitHubAppPullRequestsError('adapter_failure');
  }
  const numbers = new Set<number>();
  const result: GitHubPullRequestSummary[] = [];
  for (const rawPullRequest of pullRequests) {
    try {
      if (!isRecord(rawPullRequest)) throw new Error();
      const number = ownDataProperty(rawPullRequest, 'number');
      const title = ownDataProperty(rawPullRequest, 'title');
      const draft = ownDataProperty(rawPullRequest, 'draft');
      const updatedAt = ownDataProperty(rawPullRequest, 'updatedAt');
      const headSha = ownDataProperty(rawPullRequest, 'headSha');
      const htmlUrl = ownDataProperty(rawPullRequest, 'htmlUrl');
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        numbers.has(number) ||
        typeof title !== 'string' ||
        title.length === 0 ||
        title.length > 512 ||
        /[\x00-\x1f\x7f]/.test(title) ||
        typeof draft !== 'boolean' ||
        !parseUpdatedAt(updatedAt) ||
        typeof headSha !== 'string' ||
        !COMMIT_SHA_PATTERN.test(headSha) ||
        htmlUrl !== `https://github.com/${repositoryFullName}/pull/${number}`
      ) {
        throw new Error();
      }
      numbers.add(number);
      result.push(Object.freeze({ number, title, draft, updatedAt, headSha: headSha.toLowerCase(), htmlUrl }));
    } catch {
      throw new GitHubAppPullRequestsError('adapter_failure');
    }
  }
  return Object.freeze({ pullRequests: Object.freeze(result), hasMore });
}

/** Resolves the user's selected repository from the session-scoped private store; no repo ID comes from the client. */
export function createGitHubAppPullRequestsLoader(deps: GitHubAppPullRequestsLoaderDependencies): {
  load(sessionCredential: unknown): Promise<GitHubAppPullRequestsResult>;
} {
  let sessions: SaasSessionManager;
  let repositoriesStore: GitHubRepositoriesStore;
  let github: GitHubAppPullRequestsGitHubAdapter;
  try {
    if (!isRecord(deps)) throw new Error();
    sessions = deps.sessions;
    repositoriesStore = deps.repositoriesStore;
    github = deps.github;
    if (
      !isRecord(sessions) ||
      !isRecord(repositoriesStore) ||
      !isRecord(github) ||
      typeof sessions.get !== 'function' ||
      typeof repositoriesStore.listForUser !== 'function' ||
      typeof github.listOpenPullRequests !== 'function'
    ) {
      throw new Error();
    }
  } catch {
    throw new GitHubAppPullRequestsError('configuration');
  }

  return Object.freeze({
    async load(sessionCredential: unknown): Promise<GitHubAppPullRequestsResult> {
      if (typeof sessionCredential !== 'string' || !SESSION_CREDENTIAL_PATTERN.test(sessionCredential)) {
        throw new GitHubAppPullRequestsError('unauthenticated');
      }
      let session: unknown;
      try {
        session = await sessions.get(sessionCredential);
      } catch {
        throw new GitHubAppPullRequestsError('unauthenticated');
      }
      const githubUserId = sessionUserId(session);
      if (!githubUserId) throw new GitHubAppPullRequestsError('unauthenticated');

      let repositories: unknown;
      try {
        repositories = await repositoriesStore.listForUser(githubUserId);
      } catch {
        throw new GitHubAppPullRequestsError('adapter_failure');
      }
      const selected = selectedRepository(repositories);
      if (!selected) throw new GitHubAppPullRequestsError('repository_required');

      let upstream: unknown;
      try {
        upstream = await github.listOpenPullRequests.call(github, selected);
      } catch {
        throw new GitHubAppPullRequestsError('adapter_failure');
      }
      const parsed = parsePullRequests(upstream, selected.repositoryFullName);
      return Object.freeze({
        repositoryFullName: selected.repositoryFullName,
        pullRequests: parsed.pullRequests,
        hasMore: parsed.hasMore,
      });
    },
  });
}
