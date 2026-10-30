import {
  createReviewInputLoader,
  ReviewInputError,
  type PreparedReviewInput,
  type ReviewInputAccessRequest,
  type ReviewInputGitHubAdapter,
} from './review-input';
import type {
  GitHubAppPullRequestsRequest,
  GitHubAppRepositoryReadSession,
  GitHubAppPullRequestsAdapter,
} from './github-app-pull-requests-adapter';
import type { GitHubRepositoriesStore } from './postgres-stores';
import type { SaasSessionManager } from './sessions';

const SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type GitHubAppReviewInputErrorCode =
  | 'configuration'
  | 'unauthenticated'
  | 'repository_required'
  | 'adapter_failure';

export class GitHubAppReviewInputError extends Error {
  readonly code: GitHubAppReviewInputErrorCode;

  constructor(code: GitHubAppReviewInputErrorCode) {
    super('Pull request input could not be prepared');
    this.name = 'GitHubAppReviewInputError';
    this.code = code;
  }
}

export interface GitHubAppReviewInputDependencies {
  readonly sessions: SaasSessionManager;
  readonly repositoriesStore: GitHubRepositoriesStore;
  readonly github: GitHubAppPullRequestsAdapter;
}

export interface GitHubAppReviewInputRequest {
  readonly sessionCredential: unknown;
  readonly pullNumber: unknown;
}

interface SelectedRepository extends GitHubAppPullRequestsRequest {
  readonly githubUserId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function validFullName(value: unknown): value is string {
  if (typeof value !== 'string' || !REPOSITORY_NAME_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function selectedRepository(value: unknown, githubUserId: string): SelectedRepository | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  let selected: SelectedRepository | undefined;
  try {
    for (const raw of value) {
      if (!isRecord(raw)) return undefined;
      const isSelected = ownDataProperty(raw, 'isSelected');
      if (typeof isSelected !== 'boolean') return undefined;
      if (!isSelected) continue;
      if (selected) return undefined;
      const repositoryId = ownDataProperty(raw, 'repositoryId');
      const installationId = ownDataProperty(raw, 'installationId');
      const repositoryFullName = ownDataProperty(raw, 'fullName');
      if (
        typeof repositoryId !== 'string' || !GITHUB_ID_PATTERN.test(repositoryId) ||
        typeof installationId !== 'string' || !GITHUB_ID_PATTERN.test(installationId) ||
        !validFullName(repositoryFullName)
      ) return undefined;
      selected = Object.freeze({ githubUserId, repositoryId, installationId, repositoryFullName });
    }
  } catch {
    return undefined;
  }
  return selected;
}

function selectedMatches(value: unknown, expected: SelectedRepository): boolean {
  const actual = selectedRepository(value, expected.githubUserId);
  return actual?.repositoryId === expected.repositoryId &&
    actual.installationId === expected.installationId &&
    actual.repositoryFullName === expected.repositoryFullName;
}

function sameAccessTuple(value: ReviewInputAccessRequest, expected: SelectedRepository): boolean {
  return value.githubUserId === expected.githubUserId &&
    value.installationId === expected.installationId &&
    value.repositoryId === expected.repositoryId;
}

function sameRepositoryRequest(value: unknown, expected: SelectedRepository): boolean {
  if (!isRecord(value)) return false;
  return ownDataProperty(value, 'installationId') === expected.installationId &&
    ownDataProperty(value, 'repositoryId') === expected.repositoryId;
}

function validPullNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Resolves the selected repo from private state and keeps patches inside this request's server memory. */
export function createGitHubAppReviewInputLoader(deps: GitHubAppReviewInputDependencies): {
  load(request: GitHubAppReviewInputRequest): Promise<PreparedReviewInput>;
} {
  let sessions: SaasSessionManager;
  let repositoriesStore: GitHubRepositoriesStore;
  let github: GitHubAppPullRequestsAdapter;
  try {
    if (!isRecord(deps)) throw new Error();
    sessions = deps.sessions;
    repositoriesStore = deps.repositoriesStore;
    github = deps.github;
    if (
      !isRecord(sessions) || typeof sessions.get !== 'function' ||
      !isRecord(repositoriesStore) || typeof repositoriesStore.listForUser !== 'function' ||
      !isRecord(github) || typeof github.createRepositoryReadSession !== 'function'
    ) throw new Error();
  } catch {
    throw new GitHubAppReviewInputError('configuration');
  }

  return Object.freeze({
    async load(untrustedRequest: GitHubAppReviewInputRequest): Promise<PreparedReviewInput> {
      let sessionCredential: unknown;
      let pullNumber: unknown;
      try {
        if (!isRecord(untrustedRequest)) throw new Error();
        sessionCredential = ownDataProperty(untrustedRequest, 'sessionCredential');
        pullNumber = ownDataProperty(untrustedRequest, 'pullNumber');
      } catch {
        throw new ReviewInputError('invalid_request');
      }
      if (typeof sessionCredential !== 'string' || !SESSION_CREDENTIAL_PATTERN.test(sessionCredential) || !validPullNumber(pullNumber)) {
        throw new ReviewInputError('invalid_request');
      }

      let identity: unknown;
      try {
        identity = await sessions.get(sessionCredential);
      } catch {
        throw new GitHubAppReviewInputError('unauthenticated');
      }
      if (!isRecord(identity)) throw new GitHubAppReviewInputError('unauthenticated');
      const githubUserId = ownDataProperty(identity, 'githubUserId');
      if (typeof githubUserId !== 'string' || !GITHUB_ID_PATTERN.test(githubUserId)) {
        throw new GitHubAppReviewInputError('unauthenticated');
      }

      let repositoryRows: unknown;
      try {
        repositoryRows = await repositoriesStore.listForUser(githubUserId);
      } catch {
        throw new GitHubAppReviewInputError('adapter_failure');
      }
      const selected = selectedRepository(repositoryRows, githubUserId);
      if (!selected) throw new GitHubAppReviewInputError('repository_required');

      let readSession: GitHubAppRepositoryReadSession;
      try {
        readSession = await github.createRepositoryReadSession({
          installationId: selected.installationId,
          repositoryId: selected.repositoryId,
          repositoryFullName: selected.repositoryFullName,
        });
      } catch {
        throw new GitHubAppReviewInputError('adapter_failure');
      }

      let authorizedForNextRead = false;
      const reviewGitHub: ReviewInputGitHubAdapter = {
        async validateRepositoryAccess(input) {
          authorizedForNextRead = false;
          if (!sameAccessTuple(input, selected)) return undefined;
          let currentRows: unknown;
          try {
            currentRows = await repositoriesStore.listForUser(selected.githubUserId);
          } catch {
            throw new Error('repository selection unavailable');
          }
          if (!selectedMatches(currentRows, selected)) return undefined;
          let actual: unknown;
          try {
            actual = await readSession.getRepositoryIdentity();
          } catch {
            throw new Error('repository access unavailable');
          }
          if (
            !isRecord(actual) ||
            ownDataProperty(actual, 'repositoryId') !== selected.repositoryId ||
            ownDataProperty(actual, 'repositoryFullName') !== selected.repositoryFullName
          ) return undefined;
          authorizedForNextRead = true;
          return Object.freeze({ authorized: true, ...input });
        },
        async getPullRequest(input) {
          if (!authorizedForNextRead || !sameRepositoryRequest(input, selected) || !validPullNumber(ownDataProperty(input, 'pullNumber'))) {
            throw new Error('repository access unavailable');
          }
          authorizedForNextRead = false;
          return readSession.getPullRequest(ownDataProperty(input, 'pullNumber') as number);
        },
        async listPullRequestFiles(input) {
          if (!authorizedForNextRead || !sameRepositoryRequest(input, selected)) {
            throw new Error('repository access unavailable');
          }
          authorizedForNextRead = false;
          const pullNumberFromInput = ownDataProperty(input, 'pullNumber');
          const page = ownDataProperty(input, 'page');
          const perPage = ownDataProperty(input, 'perPage');
          const baseSha = ownDataProperty(input, 'baseSha');
          const headSha = ownDataProperty(input, 'headSha');
          if (
            !validPullNumber(pullNumberFromInput) || !Number.isSafeInteger(page) || typeof page !== 'number' || page < 1 ||
            !Number.isSafeInteger(perPage) || typeof perPage !== 'number' || perPage < 1 || perPage > 100 ||
            typeof baseSha !== 'string' || typeof headSha !== 'string'
          ) throw new Error('repository access unavailable');
          return readSession.listPullRequestFiles({
            pullNumber: pullNumberFromInput,
            page,
            perPage,
            baseSha,
            headSha,
          });
        },
      };

      const loader = createReviewInputLoader({
        sessionAuthenticator: {
          async authenticateSession(credential) {
            const current = await sessions.get(credential);
            return current ? { githubUserId: current.githubUserId } : undefined;
          },
        },
        github: reviewGitHub,
      });
      return loader.load({
        sessionCredential,
        installationId: selected.installationId,
        repositoryId: selected.repositoryId,
        pullNumber,
      });
    },
  });
}
