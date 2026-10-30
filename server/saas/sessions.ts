import { createHash, randomBytes } from 'node:crypto';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export type SaasSessionErrorCode =
  | 'configuration'
  | 'invalid_identity'
  | 'store_failure'
  | 'internal_failure';

/** Errors never include tokens, identities, store errors, or other request data. */
export class SaasSessionError extends Error {
  readonly code: SaasSessionErrorCode;

  constructor(code: SaasSessionErrorCode) {
    super('SaaS session operation failed');
    this.name = 'SaasSessionError';
    this.code = code;
  }
}

export interface SaasSessionIdentity {
  readonly githubUserId: string;
  readonly expiresAt: number;
}

export interface SaasSessionCredentials {
  /** Opaque bearer credential; callers must not log or persist it outside protected client storage. */
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Persistence contract only; no production implementation is provided here. A production store
 * MUST be durable and shared by every service instance. It stores only the supplied SHA-256 digest,
 * never the raw token. `create` must atomically reject digest collisions. `findActive` must be a
 * strongly consistent/linearizable read that returns a record only when it is unrevoked and its
 * absolute `expiresAt` is strictly greater than `now`. `revoke` must atomically revoke only an
 * unexpired session and ensure subsequent `findActive` calls cannot return it. Process-local maps,
 * stale replicas, and separate read-then-write revocation are not sufficient for production.
 */
export interface SaasSessionStore {
  create(digest: string, githubUserId: string, expiresAt: number, now: number): Promise<void>;
  findActive(digest: string, now: number): Promise<unknown | undefined>;
  revoke(digest: string, now: number): Promise<boolean>;
}

export interface SaasSessionManager {
  create(githubUserId: unknown): Promise<SaasSessionCredentials>;
  /** Invalid, expired, and revoked tokens all return undefined. */
  get(token: unknown): Promise<SaasSessionIdentity | undefined>;
  /** Returns false for invalid, missing, expired, or already revoked tokens. */
  revoke(token: unknown): Promise<boolean>;
}

export interface SaasSessionManagerDeps {
  readonly store: SaasSessionStore;
  readonly ttlMs?: number;
  /** Optional clock for deterministic tests. */
  readonly now?: () => number;
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

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeGitHubUserId(value: unknown): string | undefined {
  if (typeof value === 'string') return GITHUB_USER_ID_PATTERN.test(value) ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function readStoredIdentity(value: unknown, now: number): SaasSessionIdentity | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const githubUserId = ownDataProperty(value, 'githubUserId');
    const expiresAt = ownDataProperty(value, 'expiresAt');
    if (
      typeof githubUserId !== 'string' ||
      normalizeGitHubUserId(githubUserId) !== githubUserId ||
      !validTimestamp(expiresAt) ||
      expiresAt <= now
    ) {
      return undefined;
    }
    return Object.freeze({ githubUserId, expiresAt });
  } catch {
    return undefined;
  }
}

function readClock(clock: () => number): number {
  let now: unknown;
  try {
    now = clock();
  } catch {
    throw new SaasSessionError('internal_failure');
  }
  if (!validTimestamp(now)) throw new SaasSessionError('internal_failure');
  return now;
}

/**
 * Creates isolated session primitives. This module does not register routes or provide persistence.
 * Tokens are generated with 256 bits of cryptographic randomness; only their SHA-256 digests cross
 * the injected storage boundary. Session expiry is absolute and is never extended by lookup.
 */
export function createSaasSessionManager(deps: SaasSessionManagerDeps): SaasSessionManager {
  try {
    if (!isRecord(deps)) throw new Error();
    const store = deps.store;
    const ttlMs = deps.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const clock = deps.now ?? Date.now;
    if (
      !isRecord(store) ||
      typeof store.create !== 'function' ||
      typeof store.findActive !== 'function' ||
      typeof store.revoke !== 'function' ||
      typeof clock !== 'function' ||
      typeof ttlMs !== 'number' ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > MAX_SESSION_TTL_MS
    ) {
      throw new Error();
    }

    const createInStore = store.create;
    const findActiveInStore = store.findActive;
    const revokeInStore = store.revoke;

    return {
      async create(githubUserId: unknown): Promise<SaasSessionCredentials> {
        const normalizedId = normalizeGitHubUserId(githubUserId);
        if (!normalizedId) throw new SaasSessionError('invalid_identity');

        const now = readClock(clock);
        const expiresAt = now + ttlMs;
        if (!Number.isSafeInteger(expiresAt)) throw new SaasSessionError('internal_failure');

        let token: string;
        try {
          token = randomBytes(32).toString('base64url');
        } catch {
          throw new SaasSessionError('internal_failure');
        }
        if (!SESSION_TOKEN_PATTERN.test(token)) throw new SaasSessionError('internal_failure');

        const digest = digestToken(token);
        if (!SESSION_DIGEST_PATTERN.test(digest)) throw new SaasSessionError('internal_failure');
        try {
          const result = await createInStore.call(store, digest, normalizedId, expiresAt, now);
          if (result !== undefined) throw new Error();
        } catch {
          throw new SaasSessionError('store_failure');
        }

        return Object.freeze({ token, expiresAt });
      },

      async get(token: unknown): Promise<SaasSessionIdentity | undefined> {
        if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return undefined;

        const digest = digestToken(token);
        const now = readClock(clock);
        let stored: unknown;
        try {
          stored = await findActiveInStore.call(store, digest, now);
        } catch {
          throw new SaasSessionError('store_failure');
        }
        if (stored === undefined) return undefined;

        const identity = readStoredIdentity(stored, now);
        if (!identity) throw new SaasSessionError('store_failure');
        // Recheck the absolute expiry after async storage I/O; a slow read must not extend a session.
        const checkedAt = readClock(clock);
        if (identity.expiresAt <= checkedAt) return undefined;
        return identity;
      },

      async revoke(token: unknown): Promise<boolean> {
        if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return false;

        const digest = digestToken(token);
        const now = readClock(clock);
        try {
          const result = await revokeInStore.call(store, digest, now);
          if (typeof result !== 'boolean') throw new Error();
          return result;
        } catch {
          throw new SaasSessionError('store_failure');
        }
      },
    };
  } catch {
    throw new SaasSessionError('configuration');
  }
}
