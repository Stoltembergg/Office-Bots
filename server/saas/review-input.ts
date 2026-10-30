const STABLE_GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export const REVIEW_INPUT_LIMITS = Object.freeze({
  maxPages: 3,
  maxFiles: 300,
  maxBytes: 1_000_000,
  pageSize: 100,
});

export type ReviewInputErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'adapter_failure'
  | 'invalid_upstream_data'
  | 'incomplete_pull_request'
  | 'pull_request_changed'
  | 'limit_exceeded'
  | 'missing_patch';

/** Errors never contain credentials, adapter errors, GitHub responses, or repository contents. */
export class ReviewInputError extends Error {
  readonly code: ReviewInputErrorCode;

  constructor(code: ReviewInputErrorCode) {
    super('Pull request review input could not be prepared');
    this.name = 'ReviewInputError';
    this.code = code;
  }
}

/** The implementation must validate the live session on every invocation; it must not infer identity from request IDs. */
export interface ReviewInputSessionAuthenticator {
  authenticateSession(sessionCredential: unknown): Promise<unknown>;
}

export interface ReviewInputAccessRequest {
  readonly githubUserId: string;
  readonly installationId: string;
  readonly repositoryId: string;
}

/**
 * Read-only GitHub adapter contract. `validateRepositoryAccess` must freshly establish, from
 * GitHub, that this exact user/installation/repository tuple is authorized under an approved
 * product policy before reading the PR and again before returning the result. It must not rely on a
 * cached grant or trust the IDs supplied here by themselves. Each page request also has to succeed
 * with the live, repository-scoped GitHub credential; failure discards the entire input.
 * No production adapter or permission policy is selected by this module.
 *
 * Each files page carries repository, PR number, and base/head SHA metadata that this module checks
 * against the request. Those checks do not prove that GitHub returned an atomic page for those SHAs,
 * that patch text is intact, or that every changed file/commit was included. `hasNextPage` is used
 * only for pagination and partial-result detection; a successful traversal is not proof of a
 * complete diff. This adapter has no comment or code-execution operation by design.
 */
export interface ReviewInputGitHubAdapter {
  validateRepositoryAccess(input: ReviewInputAccessRequest): Promise<unknown>;
  getPullRequest(input: {
    readonly installationId: string;
    readonly repositoryId: string;
    readonly pullNumber: number;
  }): Promise<unknown>;
  listPullRequestFiles(input: {
    readonly installationId: string;
    readonly repositoryId: string;
    readonly pullNumber: number;
    readonly page: number;
    readonly perPage: number;
    readonly baseSha: string;
    readonly headSha: string;
  }): Promise<unknown>;
}

export interface ReviewInputDependencies {
  readonly sessionAuthenticator: ReviewInputSessionAuthenticator;
  readonly github: ReviewInputGitHubAdapter;
}

export interface ReviewInputRequest {
  /** Opaque session credential; never persisted or returned by this module. */
  readonly sessionCredential: unknown;
  /** Stable decimal GitHub ID. A client-supplied ID is only a selector, never authorization. */
  readonly installationId: unknown;
  /** Stable decimal GitHub ID. A client-supplied ID is only a selector, never authorization. */
  readonly repositoryId: unknown;
  readonly pullNumber: unknown;
}

export interface ReviewInputFile {
  readonly filename: string;
  readonly patch: string;
}

export interface PreparedReviewInput {
  readonly githubUserId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly pullRequest: {
    readonly number: number;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly files: readonly ReviewInputFile[];
  /**
   * This data is never review-ready: present patches do not prove their integrity or that every
   * commit/file was read. Consumers must not treat this input as a complete review diff.
   */
  readonly completeness: 'unverified';
}

interface ParsedRequest {
  readonly sessionCredential: unknown;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly pullNumber: number;
}

interface ParsedPullRequest {
  readonly number: number;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly headSha: string;
}

interface ParsedFilesPage {
  readonly files: readonly ReviewInputFile[];
  readonly hasNextPage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function isStableGitHubId(value: unknown): value is string {
  return typeof value === 'string' && STABLE_GITHUB_ID_PATTERN.test(value);
}

function parseRequest(value: unknown): ParsedRequest {
  try {
    if (!isRecord(value)) throw new Error();
    const sessionCredential = ownDataProperty(value, 'sessionCredential');
    const installationId = ownDataProperty(value, 'installationId');
    const repositoryId = ownDataProperty(value, 'repositoryId');
    const pullNumber = ownDataProperty(value, 'pullNumber');
    if (
      typeof sessionCredential !== 'string' ||
      sessionCredential.length === 0 ||
      sessionCredential.length > 8_192 ||
      !isStableGitHubId(installationId) ||
      !isStableGitHubId(repositoryId) ||
      typeof pullNumber !== 'number' ||
      !Number.isSafeInteger(pullNumber) ||
      pullNumber < 1
    ) {
      throw new Error();
    }
    return { sessionCredential, installationId, repositoryId, pullNumber };
  } catch {
    throw new ReviewInputError('invalid_request');
  }
}

function readAuthenticatedUser(value: unknown): string | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const githubUserId = ownDataProperty(value, 'githubUserId');
    return isStableGitHubId(githubUserId) ? githubUserId : undefined;
  } catch {
    return undefined;
  }
}

function matchesAccessGrant(value: unknown, expected: ReviewInputAccessRequest): boolean {
  try {
    if (!isRecord(value)) return false;
    return (
      ownDataProperty(value, 'authorized') === true &&
      ownDataProperty(value, 'githubUserId') === expected.githubUserId &&
      ownDataProperty(value, 'installationId') === expected.installationId &&
      ownDataProperty(value, 'repositoryId') === expected.repositoryId
    );
  } catch {
    return false;
  }
}

function parsePullRequest(value: unknown, expected: ParsedRequest): ParsedPullRequest {
  let repositoryId: unknown;
  let number: unknown;
  let base: unknown;
  let head: unknown;
  let baseSha: unknown;
  let headSha: unknown;
  try {
    if (!isRecord(value)) throw new Error();
    repositoryId = ownDataProperty(value, 'repositoryId');
    number = ownDataProperty(value, 'number');
    base = ownDataProperty(value, 'base');
    head = ownDataProperty(value, 'head');
    if (!isRecord(base) || !isRecord(head)) throw new Error();
    baseSha = ownDataProperty(base, 'sha');
    headSha = ownDataProperty(head, 'sha');
  } catch {
    throw new ReviewInputError('incomplete_pull_request');
  }

  if (
    !isStableGitHubId(repositoryId) ||
    repositoryId !== expected.repositoryId ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number !== expected.pullNumber
  ) {
    throw new ReviewInputError('invalid_upstream_data');
  }
  if (
    typeof baseSha !== 'string' ||
    !GIT_COMMIT_SHA_PATTERN.test(baseSha) ||
    typeof headSha !== 'string' ||
    !GIT_COMMIT_SHA_PATTERN.test(headSha)
  ) {
    throw new ReviewInputError('incomplete_pull_request');
  }

  return {
    number,
    repositoryId,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
  };
}

function parseFilesPage(
  value: unknown,
  expected: ParsedRequest & ParsedPullRequest,
  expectedPage: number,
): ParsedFilesPage {
  let repositoryId: unknown;
  let pullNumber: unknown;
  let pageNumber: unknown;
  let baseSha: unknown;
  let headSha: unknown;
  let files: unknown;
  let hasNextPage: unknown;
  try {
    if (!isRecord(value)) throw new Error();
    repositoryId = ownDataProperty(value, 'repositoryId');
    pullNumber = ownDataProperty(value, 'pullNumber');
    pageNumber = ownDataProperty(value, 'page');
    baseSha = ownDataProperty(value, 'baseSha');
    headSha = ownDataProperty(value, 'headSha');
    files = ownDataProperty(value, 'files');
    hasNextPage = ownDataProperty(value, 'hasNextPage');
  } catch {
    throw new ReviewInputError('invalid_upstream_data');
  }

  if (
    repositoryId !== expected.repositoryId ||
    pullNumber !== expected.pullNumber ||
    pageNumber !== expectedPage ||
    typeof baseSha !== 'string' ||
    baseSha.toLowerCase() !== expected.baseSha ||
    typeof headSha !== 'string' ||
    headSha.toLowerCase() !== expected.headSha
  ) {
    throw new ReviewInputError('pull_request_changed');
  }
  if (!Array.isArray(files) || typeof hasNextPage !== 'boolean') {
    throw new ReviewInputError('invalid_upstream_data');
  }
  if (files.length > REVIEW_INPUT_LIMITS.pageSize) throw new ReviewInputError('limit_exceeded');
  if (hasNextPage && files.length === 0) throw new ReviewInputError('invalid_upstream_data');

  const parsedFiles: ReviewInputFile[] = [];
  for (const file of files) {
    let filename: unknown;
    let patch: unknown;
    try {
      if (!isRecord(file)) throw new Error();
      filename = ownDataProperty(file, 'filename');
      patch = ownDataProperty(file, 'patch');
    } catch {
      throw new ReviewInputError('invalid_upstream_data');
    }
    if (typeof filename !== 'string' || filename.length === 0 || filename.includes('\0')) {
      throw new ReviewInputError('invalid_upstream_data');
    }
    if (typeof patch !== 'string' || patch.length === 0) throw new ReviewInputError('missing_patch');
    if (patch.includes('\0')) throw new ReviewInputError('invalid_upstream_data');
    parsedFiles.push(Object.freeze({ filename, patch }));
  }

  return { files: parsedFiles, hasNextPage };
}

function samePullRequest(left: ParsedPullRequest, right: ParsedPullRequest): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.number === right.number &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha
  );
}

/**
 * Prepares a bounded, read-only, explicitly unverified PR input using injected session and GitHub
 * adapters only. It does not issue network calls itself, persist credentials, invoke AI, publish
 * comments, or execute code. A successful result is not ready to be treated as a complete review.
 */
export function createReviewInputLoader(deps: ReviewInputDependencies): {
  load(request: ReviewInputRequest): Promise<PreparedReviewInput>;
} {
  let sessionAuthenticator: ReviewInputSessionAuthenticator;
  let github: ReviewInputGitHubAdapter;
  let authenticateSession: ReviewInputSessionAuthenticator['authenticateSession'];
  let validateRepositoryAccess: ReviewInputGitHubAdapter['validateRepositoryAccess'];
  let getPullRequest: ReviewInputGitHubAdapter['getPullRequest'];
  let listPullRequestFiles: ReviewInputGitHubAdapter['listPullRequestFiles'];
  try {
    if (!isRecord(deps)) throw new Error();
    sessionAuthenticator = deps.sessionAuthenticator;
    github = deps.github;
    if (!isRecord(sessionAuthenticator) || !isRecord(github)) throw new Error();
    authenticateSession = sessionAuthenticator.authenticateSession;
    validateRepositoryAccess = github.validateRepositoryAccess;
    getPullRequest = github.getPullRequest;
    listPullRequestFiles = github.listPullRequestFiles;
    if (
      typeof authenticateSession !== 'function' ||
      typeof validateRepositoryAccess !== 'function' ||
      typeof getPullRequest !== 'function' ||
      typeof listPullRequestFiles !== 'function'
    ) {
      throw new Error();
    }
  } catch {
    throw new ReviewInputError('configuration');
  }

  return {
    async load(untrustedRequest: ReviewInputRequest): Promise<PreparedReviewInput> {
      const request = parseRequest(untrustedRequest);
      let initialUserId: string | undefined;

      const authenticateUser = async (): Promise<string> => {
        let identity: unknown;
        try {
          identity = await authenticateSession.call(sessionAuthenticator, request.sessionCredential);
        } catch {
          throw new ReviewInputError('unauthenticated');
        }
        const githubUserId = readAuthenticatedUser(identity);
        if (!githubUserId || (initialUserId !== undefined && githubUserId !== initialUserId)) {
          throw new ReviewInputError('unauthenticated');
        }
        if (initialUserId === undefined) initialUserId = githubUserId;
        return githubUserId;
      };

      const revalidateAccess = async (githubUserId: string): Promise<void> => {
        const accessRequest = Object.freeze({
          githubUserId,
          installationId: request.installationId,
          repositoryId: request.repositoryId,
        });
        let grant: unknown;
        try {
          grant = await validateRepositoryAccess.call(github, accessRequest);
        } catch {
          throw new ReviewInputError('adapter_failure');
        }
        if (!matchesAccessGrant(grant, accessRequest)) throw new ReviewInputError('forbidden');
      };

      const readPullRequest = async (): Promise<ParsedPullRequest> => {
        const githubUserId = await authenticateUser();
        await revalidateAccess(githubUserId);
        let pullRequest: unknown;
        try {
          pullRequest = await getPullRequest.call(github, {
            installationId: request.installationId,
            repositoryId: request.repositoryId,
            pullNumber: request.pullNumber,
          });
        } catch {
          throw new ReviewInputError('adapter_failure');
        }
        return parsePullRequest(pullRequest, request);
      };

      const initialPullRequest = await readPullRequest();
      const expected = Object.freeze({ ...request, ...initialPullRequest });
      const files: ReviewInputFile[] = [];
      const filenames = new Set<string>();
      let byteCount = 0;
      let pageNumber = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        if (pageNumber > REVIEW_INPUT_LIMITS.maxPages) throw new ReviewInputError('limit_exceeded');
        // Recheck session and current repository selection before every page. The following GitHub
        // request also has to succeed with the short-lived, repository-scoped installation token.
        await revalidateAccess(await authenticateUser());
        let rawPage: unknown;
        try {
          rawPage = await listPullRequestFiles.call(github, {
            installationId: request.installationId,
            repositoryId: request.repositoryId,
            pullNumber: request.pullNumber,
            page: pageNumber,
            perPage: REVIEW_INPUT_LIMITS.pageSize,
            baseSha: initialPullRequest.baseSha,
            headSha: initialPullRequest.headSha,
          });
        } catch {
          throw new ReviewInputError('adapter_failure');
        }

        const page = parseFilesPage(rawPage, expected, pageNumber);
        for (const file of page.files) {
          if (filenames.has(file.filename)) throw new ReviewInputError('invalid_upstream_data');
          filenames.add(file.filename);
          byteCount += Buffer.byteLength(file.filename, 'utf8') + Buffer.byteLength(file.patch, 'utf8');
          if (byteCount > REVIEW_INPUT_LIMITS.maxBytes) throw new ReviewInputError('limit_exceeded');
          files.push(file);
          if (files.length > REVIEW_INPUT_LIMITS.maxFiles) throw new ReviewInputError('limit_exceeded');
        }

        hasNextPage = page.hasNextPage;
        if (hasNextPage && (pageNumber >= REVIEW_INPUT_LIMITS.maxPages || files.length >= REVIEW_INPUT_LIMITS.maxFiles)) {
          throw new ReviewInputError('limit_exceeded');
        }
        pageNumber += 1;
      }
      if (files.length === 0) throw new ReviewInputError('incomplete_pull_request');

      // Re-read under a freshly authenticated and authorized tuple to detect PR ref changes while
      // pages were being fetched. Echoed page refs are checked above, but neither check proves the
      // API supplied a complete or integrity-verified diff.
      const finalPullRequest = await readPullRequest();
      if (!samePullRequest(initialPullRequest, finalPullRequest)) {
        throw new ReviewInputError('pull_request_changed');
      }

      return Object.freeze({
        githubUserId: initialUserId!,
        installationId: request.installationId,
        repositoryId: request.repositoryId,
        pullRequest: Object.freeze({
          number: initialPullRequest.number,
          baseSha: initialPullRequest.baseSha,
          headSha: initialPullRequest.headSha,
        }),
        files: Object.freeze(files),
        completeness: 'unverified',
      });
    },
  };
}
