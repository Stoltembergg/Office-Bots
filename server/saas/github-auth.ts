import { createHash, randomBytes } from 'node:crypto';

/**
 * Isolated GitHub App authorization primitives. This module exposes no HTTP endpoint and keeps
 * neither OAuth tokens nor user records. Network exchange and identity lookup are exclusively
 * delegated to the injected adapter. Callers must generate a fresh, independent, unpredictable
 * browser binding for each attempt, keep it in a protected HttpOnly/Secure/SameSite cookie, and
 * pass it to both start and callback handling. This module does not create cookies or endpoints.
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_STATE_TTL_MS = 5 * 60_000;
const MAX_STATE_TTL_MS = 10 * 60_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BROWSER_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export type GitHubAppAuthErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'invalid_state'
  | 'state_store_failure'
  | 'adapter_failure'
  | 'invalid_identity'
  | 'internal_failure';

/** Errors deliberately contain no adapter, input, state, code, or token details. */
export class GitHubAppAuthError extends Error {
  readonly code: GitHubAppAuthErrorCode;

  constructor(code: GitHubAppAuthErrorCode) {
    super('GitHub authorization could not be completed');
    this.name = 'GitHubAppAuthError';
    this.code = code;
  }
}

/**
 * A production implementation MUST be shared by all service instances and make consume atomic:
 * exactly one concurrent consumer may claim an unexpired state, and only when the supplied
 * SHA-256 browser-binding digest matches the digest stored by issue. Compare the fixed-length
 * digests in constant time as part of the atomic operation; a process-local map or separate read
 * and delete is not sufficient. Store the digest, not the raw browser binding. Store the PKCE
 * verifier with the state, and return it only from a successful atomic consume. Production storage
 * must protect the verifier and share it across service instances; no production store is provided.
 */
export interface GitHubAppAuthStateStore {
  issue(state: string, bindingDigest: string, codeVerifier: string, expiresAt: number, now: number): Promise<void>;
  /** Atomically consume only if unexpired and bound to this digest; otherwise return undefined. */
  consume(state: string, bindingDigest: string, now: number): Promise<string | undefined>;
}

/** The adapter owns all network behavior. It returns only the access token from exchange. */
export interface GitHubAppOAuthAdapter {
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly redirectUri: string;
  }): Promise<unknown>;
  getIdentity(accessToken: string): Promise<unknown>;
}

export interface GitHubAppAuthConfig {
  readonly clientId: string;
  /** Fixed server configuration; callers cannot override this per authorization or callback. */
  readonly callbackUrl: string;
  readonly stateTtlMs?: number;
}

export interface GitHubAppAuthDeps {
  readonly config: GitHubAppAuthConfig;
  readonly stateStore: GitHubAppAuthStateStore;
  readonly adapter: GitHubAppOAuthAdapter;
  /** Optional clock for deterministic tests. */
  readonly now?: () => number;
}

export interface GitHubAppAuthorizationStart {
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}

export interface GitHubAppIdentity {
  /** Stable numeric GitHub user ID, normalized to a decimal string. */
  readonly githubUserId: string;
}

export interface GitHubAppAuthorizationFlow {
  /** Binding must be a fresh, independent 32-byte random value encoded as base64url. */
  beginAuthorization(browserBinding: string): Promise<GitHubAppAuthorizationStart>;
  /** `input` is untrusted callback data, typically containing `code` and `state`. */
  completeAuthorization(input: unknown): Promise<GitHubAppIdentity>;
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

function validNow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBrowserBinding(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_BINDING_PATTERN.test(value);
}

function digestBrowserBinding(binding: string): string {
  return createHash('sha256').update(binding, 'utf8').digest('hex');
}

function configuredCallbackUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function readIdentityId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const id = ownDataProperty(value, 'id');
    if (typeof id === 'string' && GITHUB_USER_ID_PATTERN.test(id)) return id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  } catch {
    // Treat unusual adapter objects (including throwing proxies) as invalid, without exposing them.
  }
  return undefined;
}

/**
 * Creates the authorization flow. This module does not register a route, persist credentials, or
 * make network requests. The configured callback URL is reused verbatim (after URL canonicalization)
 * both in the GitHub redirect and in the injected code-exchange adapter. The PKCE verifier remains
 * in the injected state store until a successful callback consumes it.
 */
export function createGitHubAppAuthorizationFlow(deps: GitHubAppAuthDeps): GitHubAppAuthorizationFlow {
  try {
    if (!isRecord(deps)) throw new Error();
    const config = deps.config;
    const stateStore = deps.stateStore;
    const adapter = deps.adapter;
    const clock = deps.now ?? Date.now;
    if (!isRecord(config) || !isRecord(stateStore) || !isRecord(adapter) || typeof clock !== 'function') {
      throw new Error();
    }

    const clientId = config.clientId;
    const callbackUrl = configuredCallbackUrl(config.callbackUrl);
    const ttlMs = config.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    const issueState = stateStore.issue;
    const consumeState = stateStore.consume;
    const exchangeCode = adapter.exchangeCode;
    const getIdentity = adapter.getIdentity;

    if (
      typeof clientId !== 'string' ||
      !CLIENT_ID_PATTERN.test(clientId) ||
      !callbackUrl ||
      typeof ttlMs !== 'number' ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > MAX_STATE_TTL_MS ||
      typeof issueState !== 'function' ||
      typeof consumeState !== 'function' ||
      typeof exchangeCode !== 'function' ||
      typeof getIdentity !== 'function'
    ) {
      throw new Error();
    }

    return {
      async beginAuthorization(browserBinding: string): Promise<GitHubAppAuthorizationStart> {
        if (!isBrowserBinding(browserBinding)) throw new GitHubAppAuthError('invalid_request');
        let now: number;
        try {
          now = clock();
        } catch {
          throw new GitHubAppAuthError('internal_failure');
        }
        if (!validNow(now) || !Number.isSafeInteger(now + ttlMs)) {
          throw new GitHubAppAuthError('internal_failure');
        }

        let state: string;
        let codeVerifier: string;
        try {
          state = randomBytes(32).toString('base64url');
          // Generate the PKCE verifier independently from state and the browser binding.
          codeVerifier = randomBytes(32).toString('base64url');
        } catch {
          throw new GitHubAppAuthError('internal_failure');
        }
        if (!STATE_PATTERN.test(state) || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
          throw new GitHubAppAuthError('internal_failure');
        }
        // Keep both independent secrets out of the authorization URL and reject accidental reuse.
        if (state === browserBinding || codeVerifier === state || codeVerifier === browserBinding) {
          throw new GitHubAppAuthError('internal_failure');
        }

        const expiresAt = now + ttlMs;
        const bindingDigest = digestBrowserBinding(browserBinding);
        const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
        const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL);
        authorizationUrl.searchParams.set('client_id', clientId);
        authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizationUrl.searchParams.set('state', state);
        authorizationUrl.searchParams.set('code_challenge', codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');

        try {
          const issued = await issueState.call(stateStore, state, bindingDigest, codeVerifier, expiresAt, now);
          if (issued !== undefined) throw new Error();
        } catch {
          throw new GitHubAppAuthError('state_store_failure');
        }

        return Object.freeze({ authorizationUrl: authorizationUrl.href, expiresAt });
      },

      async completeAuthorization(input: unknown): Promise<GitHubAppIdentity> {
        if (!isRecord(input)) throw new GitHubAppAuthError('invalid_state');

        let state: unknown;
        try {
          state = ownDataProperty(input, 'state');
        } catch {
          throw new GitHubAppAuthError('invalid_state');
        }
        if (typeof state !== 'string' || !STATE_PATTERN.test(state)) {
          throw new GitHubAppAuthError('invalid_state');
        }

        let browserBinding: unknown;
        try {
          browserBinding = ownDataProperty(input, 'browserBinding');
        } catch {
          throw new GitHubAppAuthError('invalid_request');
        }
        if (!isBrowserBinding(browserBinding)) throw new GitHubAppAuthError('invalid_request');

        let now: number;
        try {
          now = clock();
        } catch {
          throw new GitHubAppAuthError('internal_failure');
        }
        if (!validNow(now)) throw new GitHubAppAuthError('internal_failure');

        let consumed: unknown;
        try {
          consumed = await consumeState.call(stateStore, state, digestBrowserBinding(browserBinding), now);
        } catch {
          throw new GitHubAppAuthError('state_store_failure');
        }
        if (consumed === undefined) throw new GitHubAppAuthError('invalid_state');
        if (typeof consumed !== 'string' || !PKCE_VERIFIER_PATTERN.test(consumed)) {
          throw new GitHubAppAuthError('state_store_failure');
        }

        // Claim state before validating or exchanging the code. Every accepted state is one-shot,
        // including when the callback is malformed or an adapter subsequently fails.
        let code: unknown;
        try {
          code = ownDataProperty(input, 'code');
        } catch {
          throw new GitHubAppAuthError('invalid_request');
        }
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
          throw new GitHubAppAuthError('invalid_request');
        }

        let accessToken: unknown;
        try {
          accessToken = await exchangeCode.call(adapter, {
            code,
            codeVerifier: consumed,
            clientId,
            redirectUri: callbackUrl,
          });
        } catch {
          throw new GitHubAppAuthError('adapter_failure');
        }
        if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken)) {
          throw new GitHubAppAuthError('adapter_failure');
        }

        let remoteIdentity: unknown;
        try {
          remoteIdentity = await getIdentity.call(adapter, accessToken);
        } catch {
          throw new GitHubAppAuthError('adapter_failure');
        }

        const githubUserId = readIdentityId(remoteIdentity);
        if (!githubUserId) throw new GitHubAppAuthError('invalid_identity');
        return Object.freeze({ githubUserId });
      },
    };
  } catch {
    throw new GitHubAppAuthError('configuration');
  }
}
