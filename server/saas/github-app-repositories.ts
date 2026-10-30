import { createHash, randomBytes } from 'node:crypto';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_STATE_TTL_MS = 5 * 60_000;
const MAX_STATE_TTL_MS = 10 * 60_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOSITORIES = 10_000;
const MAX_INSTALLATIONS = 100;

export type GitHubAppRepositoriesAuthErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'invalid_state'
  | 'state_store_failure'
  | 'adapter_failure'
  | 'identity_mismatch'
  | 'internal_failure';

/** Deliberately contains no code, state, token, or upstream response details. */
export class GitHubAppRepositoriesAuthError extends Error {
  readonly code: GitHubAppRepositoriesAuthErrorCode;

  constructor(code: GitHubAppRepositoriesAuthErrorCode) {
    super('GitHub repository authorization could not be completed');
    this.name = 'GitHubAppRepositoriesAuthError';
    this.code = code;
  }
}

export interface GitHubAppAuthorizationStateStore {
  issue(
    state: string,
    githubUserId: string,
    bindingDigest: string,
    codeVerifier: string,
    expiresAt: number,
    now: number,
  ): Promise<void>;
  /** Atomically consumes a valid state bound to the supplied browser digest. */
  consume(
    state: string,
    bindingDigest: string,
    now: number,
  ): Promise<{ readonly githubUserId: string; readonly codeVerifier: string } | undefined>;
}

export interface GitHubRepositorySummary {
  readonly repositoryId: string;
  readonly installationId: string;
  readonly fullName: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string | null;
  readonly htmlUrl: string;
}

export interface GitHubAppRepositoriesAdapter {
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly redirectUri: string;
  }): Promise<unknown>;
  getIdentity(accessToken: string): Promise<unknown>;
  listRepositories(accessToken: string): Promise<unknown>;
}

export interface GitHubAppRepositoriesAuthorizationConfig {
  readonly clientId: string;
  /** Fixed server configuration; callbacks cannot override it. */
  readonly callbackUrl: string;
  readonly stateTtlMs?: number;
}

export interface GitHubAppRepositoriesAuthorizationDeps {
  readonly config: GitHubAppRepositoriesAuthorizationConfig;
  readonly stateStore: GitHubAppAuthorizationStateStore;
  readonly adapter: GitHubAppRepositoriesAdapter;
  readonly now?: () => number;
}

export interface GitHubAppRepositoriesAuthorizationStart {
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}

export interface GitHubAppRepositoriesAuthorizationResult {
  readonly githubUserId: string;
  readonly installationCount: number;
  readonly repositories: readonly GitHubRepositorySummary[];
}

export interface GitHubAppRepositoriesAuthorizationFlow {
  beginAuthorization(githubUserId: string, browserBinding: string): Promise<GitHubAppRepositoriesAuthorizationStart>;
  completeAuthorization(input: unknown): Promise<GitHubAppRepositoriesAuthorizationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function digestBinding(binding: string): string {
  return createHash('sha256').update(binding, 'utf8').digest('hex');
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function configuredCallbackUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('?') || value.includes('#')) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizedId(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === 'string' && pattern.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const result = String(value);
    return pattern.test(result) ? result : undefined;
  }
  return undefined;
}

function readIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return normalizedId(ownDataProperty(value, 'id'), USER_ID_PATTERN);
  } catch {
    return undefined;
  }
}

function readRepositories(value: unknown): {
  readonly installationCount: number;
  readonly repositories: readonly GitHubRepositorySummary[];
} | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const installationCount = ownDataProperty(value, 'installationCount');
    const repositories = ownDataProperty(value, 'repositories');
    if (
      typeof installationCount !== 'number' ||
      !Number.isSafeInteger(installationCount) ||
      installationCount < 0 ||
      installationCount > MAX_INSTALLATIONS ||
      !Array.isArray(repositories) ||
      repositories.length > MAX_REPOSITORIES
    ) {
      return undefined;
    }

    const seen = new Set<string>();
    const normalized: GitHubRepositorySummary[] = [];
    for (const rawRepository of repositories) {
      if (!isRecord(rawRepository)) return undefined;
      const repositoryId = normalizedId(ownDataProperty(rawRepository, 'repositoryId'), REPOSITORY_ID_PATTERN);
      const installationId = normalizedId(ownDataProperty(rawRepository, 'installationId'), REPOSITORY_ID_PATTERN);
      const fullName = ownDataProperty(rawRepository, 'fullName');
      const isPrivate = ownDataProperty(rawRepository, 'isPrivate');
      const defaultBranch = ownDataProperty(rawRepository, 'defaultBranch');
      const htmlUrl = ownDataProperty(rawRepository, 'htmlUrl');
      if (
        !repositoryId ||
        !installationId ||
        seen.has(repositoryId) ||
        typeof fullName !== 'string' ||
        !REPOSITORY_NAME_PATTERN.test(fullName) ||
        typeof isPrivate !== 'boolean' ||
        (defaultBranch !== null && (typeof defaultBranch !== 'string' || defaultBranch.length > 255 || /[\x00-\x1f\x7f]/.test(defaultBranch))) ||
        typeof htmlUrl !== 'string' ||
        htmlUrl !== `https://github.com/${fullName}`
      ) {
        return undefined;
      }
      seen.add(repositoryId);
      normalized.push(Object.freeze({ repositoryId, installationId, fullName, isPrivate, defaultBranch, htmlUrl }));
    }
    return { installationCount, repositories: Object.freeze(normalized) };
  } catch {
    return undefined;
  }
}

/**
 * A server-only OAuth flow for listing repositories through the current Office session. It never
 * persists or returns the GitHub token; the adapter uses it to fetch the identity and repositories
 * before this method resolves.
 */
export function createGitHubAppRepositoriesAuthorizationFlow(
  deps: GitHubAppRepositoriesAuthorizationDeps,
): GitHubAppRepositoriesAuthorizationFlow {
  try {
    if (!isRecord(deps)) throw new Error();
    const config = deps.config;
    const stateStore = deps.stateStore;
    const adapter = deps.adapter;
    const clock = deps.now ?? Date.now;
    if (!isRecord(config) || !isRecord(stateStore) || !isRecord(adapter) || typeof clock !== 'function') throw new Error();

    const clientId = config.clientId;
    const callbackUrl = configuredCallbackUrl(config.callbackUrl);
    const stateTtlMs = config.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    const issueState = stateStore.issue;
    const consumeState = stateStore.consume;
    const exchangeCode = adapter.exchangeCode;
    const getIdentity = adapter.getIdentity;
    const listRepositories = adapter.listRepositories;
    if (
      typeof clientId !== 'string' ||
      !CLIENT_ID_PATTERN.test(clientId) ||
      !callbackUrl ||
      typeof stateTtlMs !== 'number' ||
      !Number.isSafeInteger(stateTtlMs) ||
      stateTtlMs < 1_000 ||
      stateTtlMs > MAX_STATE_TTL_MS ||
      typeof issueState !== 'function' ||
      typeof consumeState !== 'function' ||
      typeof exchangeCode !== 'function' ||
      typeof getIdentity !== 'function' ||
      typeof listRepositories !== 'function'
    ) {
      throw new Error();
    }

    return {
      async beginAuthorization(githubUserId: string, browserBinding: string): Promise<GitHubAppRepositoriesAuthorizationStart> {
        if (!USER_ID_PATTERN.test(githubUserId) || !BINDING_PATTERN.test(browserBinding)) {
          throw new GitHubAppRepositoriesAuthError('invalid_request');
        }
        let now: number;
        try {
          now = clock();
        } catch {
          throw new GitHubAppRepositoriesAuthError('internal_failure');
        }
        if (!validTimestamp(now) || !Number.isSafeInteger(now + stateTtlMs)) {
          throw new GitHubAppRepositoriesAuthError('internal_failure');
        }

        let state: string;
        let codeVerifier: string;
        try {
          state = randomBytes(32).toString('base64url');
          codeVerifier = randomBytes(32).toString('base64url');
        } catch {
          throw new GitHubAppRepositoriesAuthError('internal_failure');
        }
        if (
          !STATE_PATTERN.test(state) ||
          !CODE_VERIFIER_PATTERN.test(codeVerifier) ||
          state === browserBinding ||
          codeVerifier === state ||
          codeVerifier === browserBinding
        ) {
          throw new GitHubAppRepositoriesAuthError('internal_failure');
        }

        const expiresAt = now + stateTtlMs;
        const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
        const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL);
        authorizationUrl.searchParams.set('client_id', clientId);
        authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizationUrl.searchParams.set('state', state);
        authorizationUrl.searchParams.set('code_challenge', codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        try {
          await issueState.call(stateStore, state, githubUserId, digestBinding(browserBinding), codeVerifier, expiresAt, now);
        } catch {
          throw new GitHubAppRepositoriesAuthError('state_store_failure');
        }
        return Object.freeze({ authorizationUrl: authorizationUrl.href, expiresAt });
      },

      async completeAuthorization(input: unknown): Promise<GitHubAppRepositoriesAuthorizationResult> {
        if (!isRecord(input)) throw new GitHubAppRepositoriesAuthError('invalid_state');
        let state: unknown;
        let code: unknown;
        let browserBinding: unknown;
        let expectedGithubUserId: unknown;
        try {
          state = ownDataProperty(input, 'state');
          code = ownDataProperty(input, 'code');
          browserBinding = ownDataProperty(input, 'browserBinding');
          expectedGithubUserId = ownDataProperty(input, 'expectedGithubUserId');
        } catch {
          throw new GitHubAppRepositoriesAuthError('invalid_state');
        }
        if (typeof state !== 'string' || !STATE_PATTERN.test(state)) throw new GitHubAppRepositoriesAuthError('invalid_state');
        if (typeof browserBinding !== 'string' || !BINDING_PATTERN.test(browserBinding)) {
          throw new GitHubAppRepositoriesAuthError('invalid_request');
        }
        if (typeof expectedGithubUserId !== 'string' || !USER_ID_PATTERN.test(expectedGithubUserId)) {
          throw new GitHubAppRepositoriesAuthError('invalid_request');
        }
        let now: number;
        try {
          now = clock();
        } catch {
          throw new GitHubAppRepositoriesAuthError('internal_failure');
        }
        if (!validTimestamp(now)) throw new GitHubAppRepositoriesAuthError('internal_failure');

        let consumed: unknown;
        try {
          consumed = await consumeState.call(stateStore, state, digestBinding(browserBinding), now);
        } catch {
          throw new GitHubAppRepositoriesAuthError('state_store_failure');
        }
        if (!isRecord(consumed)) throw new GitHubAppRepositoriesAuthError('invalid_state');
        let storedGithubUserId: unknown;
        let codeVerifier: unknown;
        try {
          storedGithubUserId = ownDataProperty(consumed, 'githubUserId');
          codeVerifier = ownDataProperty(consumed, 'codeVerifier');
        } catch {
          throw new GitHubAppRepositoriesAuthError('state_store_failure');
        }
        if (
          typeof storedGithubUserId !== 'string' ||
          !USER_ID_PATTERN.test(storedGithubUserId) ||
          typeof codeVerifier !== 'string' ||
          !CODE_VERIFIER_PATTERN.test(codeVerifier)
        ) {
          throw new GitHubAppRepositoriesAuthError('state_store_failure');
        }
        // A state started by a different Office session is one-use and cannot be replayed by a new account.
        if (storedGithubUserId !== expectedGithubUserId) throw new GitHubAppRepositoriesAuthError('invalid_state');
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new GitHubAppRepositoriesAuthError('invalid_request');

        let accessToken: unknown;
        try {
          accessToken = await exchangeCode.call(adapter, { code, codeVerifier, clientId, redirectUri: callbackUrl });
        } catch {
          throw new GitHubAppRepositoriesAuthError('adapter_failure');
        }
        if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken)) {
          throw new GitHubAppRepositoriesAuthError('adapter_failure');
        }

        let identity: unknown;
        try {
          identity = await getIdentity.call(adapter, accessToken);
        } catch {
          throw new GitHubAppRepositoriesAuthError('adapter_failure');
        }
        const githubUserId = readIdentity(identity);
        if (!githubUserId) throw new GitHubAppRepositoriesAuthError('adapter_failure');
        if (githubUserId !== storedGithubUserId) throw new GitHubAppRepositoriesAuthError('identity_mismatch');

        let rawRepositories: unknown;
        try {
          rawRepositories = await listRepositories.call(adapter, accessToken);
        } catch {
          throw new GitHubAppRepositoriesAuthError('adapter_failure');
        }
        const repositoryResult = readRepositories(rawRepositories);
        if (!repositoryResult) throw new GitHubAppRepositoriesAuthError('adapter_failure');
        return Object.freeze({
          githubUserId,
          installationCount: repositoryResult.installationCount,
          repositories: repositoryResult.repositories,
        });
      },
    };
  } catch {
    throw new GitHubAppRepositoriesAuthError('configuration');
  }
}
