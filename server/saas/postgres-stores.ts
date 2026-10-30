import { timingSafeEqual } from 'node:crypto';
import type { GitHubAppAuthStateStore } from './github-auth';
import type { SaasSessionStore } from './sessions';

const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const SESSION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/** Small dependency-free subset of a PostgreSQL query result, pool, and checked-out client. */
export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

export interface PostgresClient extends PostgresQueryExecutor {
  /** Matches node-postgres PoolClient.release(err?): an error destroys the client instead of pooling it. */
  release(error?: Error | boolean): void;
}

/**
 * Inject a pool configured to use the primary database for ordinary queries. `connect` must return
 * a single connection whose transaction statements stay on that connection. No driver or connection
 * configuration is owned by this module.
 */
export interface PostgresPool extends PostgresQueryExecutor {
  connect(): Promise<PostgresClient>;
}

export interface PostgresSaasStores {
  readonly githubAuthStateStore: GitHubAppAuthStateStore;
  readonly sessionStore: SaasSessionStore;
}

export interface PostgresSaasStoreOptions {
  /** Clock read after the OAuth state row lock is acquired. Defaults to Date.now. */
  readonly clock?: () => number;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return isSafeTimestamp(value) ? value : undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return isSafeTimestamp(parsed) ? parsed : undefined;
}

function validOAuthStateInput(
  state: string,
  bindingDigest: string,
  codeVerifier: string,
  expiresAt: number,
  now: number,
): boolean {
  return (
    OAUTH_STATE_PATTERN.test(state) &&
    BINDING_DIGEST_PATTERN.test(bindingDigest) &&
    PKCE_VERIFIER_PATTERN.test(codeVerifier) &&
    isSafeTimestamp(now) &&
    isSafeTimestamp(expiresAt) &&
    expiresAt > now &&
    expiresAt - now <= 10 * 60_000
  );
}

function validSessionInput(digest: string, githubUserId: string, expiresAt: number, now: number): boolean {
  return (
    SESSION_DIGEST_PATTERN.test(digest) &&
    GITHUB_USER_ID_PATTERN.test(githubUserId) &&
    isSafeTimestamp(now) &&
    isSafeTimestamp(expiresAt) &&
    expiresAt > now &&
    expiresAt - now <= 30 * 24 * 60 * 60_000
  );
}

function safeRow(result: PostgresQueryResult): Record<string, unknown> | undefined {
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('Invalid database row');
  return row;
}

/**
 * Creates PostgreSQL-backed stores for the OAuth and session contracts. All statements are
 * parameterized and intentionally unnamed, which is compatible with transaction-pooling proxies.
 * OAuth verifiers and session digests are kept in the private schema; raw session tokens never
 * cross this storage boundary.
 */
export function createPostgresSaasStores(
  pool: PostgresPool,
  options: PostgresSaasStoreOptions = {},
): PostgresSaasStores {
  if (
    typeof pool !== 'object' ||
    pool === null ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function' ||
    typeof options !== 'object' ||
    options === null
  ) {
    throw new TypeError('Invalid PostgreSQL pool');
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('Invalid PostgreSQL store clock');

  const githubAuthStateStore: GitHubAppAuthStateStore = {
    async issue(state, bindingDigest, codeVerifier, expiresAt, now): Promise<void> {
      if (!validOAuthStateInput(state, bindingDigest, codeVerifier, expiresAt, now)) {
        throw new TypeError('Invalid OAuth state record');
      }
      await pool.query(
        `INSERT INTO office_bots_private.oauth_states
          (state, binding_digest, code_verifier, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [state, bindingDigest, codeVerifier, now, expiresAt],
      );
    },

    async consume(state, bindingDigest, now): Promise<string | undefined> {
      if (
        !OAUTH_STATE_PATTERN.test(state) ||
        !BINDING_DIGEST_PATTERN.test(bindingDigest) ||
        !isSafeTimestamp(now)
      ) {
        return undefined;
      }

      const client = await pool.connect();
      let rollbackNeeded = true;
      let releaseError: Error | undefined;
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT binding_digest, code_verifier, expires_at_ms
             FROM office_bots_private.oauth_states
            WHERE state = $1
            FOR UPDATE`,
          [state],
        );
        const row = safeRow(selected);
        if (!row) {
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        const storedDigest = row.binding_digest;
        const verifier = row.code_verifier;
        const expiresAt = parseTimestamp(row.expires_at_ms);
        if (
          typeof storedDigest !== 'string' ||
          !BINDING_DIGEST_PATTERN.test(storedDigest) ||
          typeof verifier !== 'string' ||
          !PKCE_VERIFIER_PATTERN.test(verifier) ||
          expiresAt === undefined
        ) {
          throw new Error('Invalid OAuth state row');
        }

        const bindingMatches = timingSafeEqual(Buffer.from(storedDigest, 'hex'), Buffer.from(bindingDigest, 'hex'));
        if (!bindingMatches) {
          // A wrong browser binding must leave the legitimate attempt usable.
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        // `now` was supplied before connect/lock waits. Re-read time only after FOR UPDATE returns,
        // and reject a clock error or backwards movement rather than accepting stale validity.
        const currentNow = clock();
        if (!isSafeTimestamp(currentNow) || currentNow < now) {
          throw new Error('Invalid OAuth state clock');
        }
        const checkedNow = Math.max(now, currentNow);
        if (expiresAt <= checkedNow) {
          await client.query(
            `DELETE FROM office_bots_private.oauth_states
              WHERE state = $1
              RETURNING state`,
            [state],
          );
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        const deleted = await client.query(
          `DELETE FROM office_bots_private.oauth_states
            WHERE state = $1
            RETURNING state`,
          [state],
        );
        if (deleted.rows.length !== 1) throw new Error('OAuth state was not deleted');

        // Do not release the verifier to the caller until its one-time deletion is committed.
        await client.query('COMMIT');
        rollbackNeeded = false;
        return verifier;
      } catch (error) {
        if (rollbackNeeded) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            // A failed rollback leaves transaction state uncertain; tell pg to destroy this client.
            releaseError =
              rollbackError instanceof Error ? rollbackError : new Error('PostgreSQL rollback failed');
          }
        }
        throw error;
      } finally {
        if (releaseError) client.release(releaseError);
        else client.release();
      }
    },
  };

  const sessionStore: SaasSessionStore = {
    async create(digest, githubUserId, expiresAt, now): Promise<void> {
      if (!validSessionInput(digest, githubUserId, expiresAt, now)) {
        throw new TypeError('Invalid session record');
      }
      await pool.query(
        `INSERT INTO office_bots_private.sessions
          (token_digest, github_user_id, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4)`,
        [digest, githubUserId, now, expiresAt],
      );
    },

    async findActive(digest, now): Promise<unknown | undefined> {
      if (!SESSION_DIGEST_PATTERN.test(digest) || !isSafeTimestamp(now)) return undefined;
      const result = await pool.query(
        `SELECT github_user_id, expires_at_ms
           FROM office_bots_private.sessions
          WHERE token_digest = $1
            AND revoked_at_ms IS NULL
            AND expires_at_ms > $2
          LIMIT 1`,
        [digest, now],
      );
      const row = safeRow(result);
      if (!row) return undefined;
      const githubUserId = row.github_user_id;
      const expiresAt = parseTimestamp(row.expires_at_ms);
      if (
        typeof githubUserId !== 'string' ||
        !GITHUB_USER_ID_PATTERN.test(githubUserId) ||
        expiresAt === undefined ||
        expiresAt <= now
      ) {
        return undefined;
      }
      return { githubUserId, expiresAt };
    },

    async revoke(digest, now): Promise<boolean> {
      if (!SESSION_DIGEST_PATTERN.test(digest) || !isSafeTimestamp(now)) return false;
      const result = await pool.query(
        `UPDATE office_bots_private.sessions
            SET revoked_at_ms = $2
          WHERE token_digest = $1
            AND revoked_at_ms IS NULL
            AND expires_at_ms > $2
          RETURNING token_digest`,
        [digest, now],
      );
      return result.rows.length === 1;
    },
  };

  return Object.freeze({ githubAuthStateStore, sessionStore });
}
