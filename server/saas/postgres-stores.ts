import { timingSafeEqual } from 'node:crypto';
import type { GitHubAppAuthStateStore } from './github-auth.js';
import type {
  GitHubAppAuthorizationStateStore,
  GitHubRepositorySummary,
} from './github-app-repositories.js';
import type { SaasSessionStore } from './sessions.js';

const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const SESSION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOSITORIES = 10_000;

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
  readonly githubAppAuthorizationStateStore: GitHubAppAuthorizationStateStore;
  readonly githubRepositoriesStore: GitHubRepositoriesStore;
  readonly sessionStore: SaasSessionStore;
}

export interface GitHubRepositoryRecord extends GitHubRepositorySummary {
  readonly isSelected: boolean;
}

export interface GitHubRepositoriesStore {
  replaceForUser(githubUserId: string, repositories: readonly GitHubRepositorySummary[], now: number): Promise<void>;
  listForUser(githubUserId: string): Promise<readonly GitHubRepositoryRecord[]>;
  /** Returns false when a non-null repository does not belong to this user. */
  setSelectedForUser(githubUserId: string, repositoryId: string | null, now: number): Promise<boolean>;
}

export interface PostgresSaasStoreOptions {
  /** Clock read after the OAuth state row lock is acquired. Defaults to Date.now. */
  readonly clock?: () => number;
  /** Selects one of the pre-created, environment-isolated schemas. */
  readonly schema?: OfficeBotsDatabaseSchema;
}

export type OfficeBotsDatabaseSchema = 'office_bots_private' | 'office_bots_preview_private';

export interface OfficeBotsDatabaseEnvironment {
  readonly OFFICE_BOTS_DATABASE_SCHEMA?: string;
  readonly VERCEL_ENV?: string;
}

const DATABASE_SCHEMAS: readonly OfficeBotsDatabaseSchema[] = [
  'office_bots_private',
  'office_bots_preview_private',
];

/**
 * Resolve Vercel's environment to a fixed schema allowlist. Preview fails closed until it has
 * an explicit isolated schema; Production remains on its existing schema by default.
 */
export function officeBotsDatabaseSchemaForEnvironment(
  env: OfficeBotsDatabaseEnvironment,
): OfficeBotsDatabaseSchema {
  const configured = env.OFFICE_BOTS_DATABASE_SCHEMA;
  if (configured !== undefined && !DATABASE_SCHEMAS.includes(configured as OfficeBotsDatabaseSchema)) {
    throw new TypeError('Invalid Office Bots database schema');
  }
  if (env.VERCEL_ENV === 'preview' && configured !== 'office_bots_preview_private') {
    throw new TypeError('Preview requires its isolated Office Bots database schema');
  }
  if (env.VERCEL_ENV === 'production' && configured !== undefined && configured !== 'office_bots_private') {
    throw new TypeError('Production cannot use the Preview Office Bots database schema');
  }
  return configured === 'office_bots_preview_private' ? configured : 'office_bots_private';
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

function validGitHubAppStateInput(
  state: string,
  githubUserId: string,
  bindingDigest: string,
  codeVerifier: string,
  expiresAt: number,
  now: number,
): boolean {
  return (
    OAUTH_STATE_PATTERN.test(state) &&
    GITHUB_USER_ID_PATTERN.test(githubUserId) &&
    BINDING_DIGEST_PATTERN.test(bindingDigest) &&
    PKCE_VERIFIER_PATTERN.test(codeVerifier) &&
    isSafeTimestamp(now) &&
    isSafeTimestamp(expiresAt) &&
    expiresAt > now &&
    expiresAt - now <= 10 * 60_000
  );
}

function validRepositorySummary(value: unknown): value is GitHubRepositorySummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const repository = value as Record<string, unknown>;
  return (
    typeof repository.repositoryId === 'string' &&
    REPOSITORY_ID_PATTERN.test(repository.repositoryId) &&
    typeof repository.installationId === 'string' &&
    REPOSITORY_ID_PATTERN.test(repository.installationId) &&
    typeof repository.fullName === 'string' &&
    REPOSITORY_NAME_PATTERN.test(repository.fullName) &&
    typeof repository.isPrivate === 'boolean' &&
    (repository.defaultBranch === null || (
      typeof repository.defaultBranch === 'string' &&
      repository.defaultBranch.length <= 255 &&
      !/[\x00-\x1f\x7f]/.test(repository.defaultBranch)
    )) &&
    typeof repository.htmlUrl === 'string' &&
    repository.htmlUrl === `https://github.com/${repository.fullName}`
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
  const schema = options.schema ?? 'office_bots_private';
  if (!DATABASE_SCHEMAS.includes(schema)) throw new TypeError('Invalid Office Bots database schema');

  const githubAuthStateStore: GitHubAppAuthStateStore = {
    async issue(state, bindingDigest, codeVerifier, expiresAt, now): Promise<void> {
      if (!validOAuthStateInput(state, bindingDigest, codeVerifier, expiresAt, now)) {
        throw new TypeError('Invalid OAuth state record');
      }
      await pool.query(
        `INSERT INTO ${schema}.oauth_states
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
             FROM ${schema}.oauth_states
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
            `DELETE FROM ${schema}.oauth_states
              WHERE state = $1
              RETURNING state`,
            [state],
          );
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        const deleted = await client.query(
          `DELETE FROM ${schema}.oauth_states
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

  const githubAppAuthorizationStateStore: GitHubAppAuthorizationStateStore = {
    async issue(state, githubUserId, bindingDigest, codeVerifier, expiresAt, now): Promise<void> {
      if (!validGitHubAppStateInput(state, githubUserId, bindingDigest, codeVerifier, expiresAt, now)) {
        throw new TypeError('Invalid GitHub App authorization state');
      }
      await pool.query(
        `INSERT INTO ${schema}.github_app_oauth_states
          (state, github_user_id, binding_digest, code_verifier, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [state, githubUserId, bindingDigest, codeVerifier, now, expiresAt],
      );
    },

    async consume(state, bindingDigest, now): Promise<{ githubUserId: string; codeVerifier: string } | undefined> {
      if (!OAUTH_STATE_PATTERN.test(state) || !BINDING_DIGEST_PATTERN.test(bindingDigest) || !isSafeTimestamp(now)) {
        return undefined;
      }

      const client = await pool.connect();
      let rollbackNeeded = true;
      let releaseError: Error | undefined;
      try {
        await client.query('BEGIN');
        const selected = await client.query(
          `SELECT github_user_id, binding_digest, code_verifier, expires_at_ms
             FROM ${schema}.github_app_oauth_states
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

        const githubUserId = row.github_user_id;
        const storedDigest = row.binding_digest;
        const codeVerifier = row.code_verifier;
        const expiresAt = parseTimestamp(row.expires_at_ms);
        if (
          typeof githubUserId !== 'string' ||
          !GITHUB_USER_ID_PATTERN.test(githubUserId) ||
          typeof storedDigest !== 'string' ||
          !BINDING_DIGEST_PATTERN.test(storedDigest) ||
          typeof codeVerifier !== 'string' ||
          !PKCE_VERIFIER_PATTERN.test(codeVerifier) ||
          expiresAt === undefined
        ) {
          throw new Error('Invalid GitHub App authorization state row');
        }

        const bindingMatches = timingSafeEqual(Buffer.from(storedDigest, 'hex'), Buffer.from(bindingDigest, 'hex'));
        if (!bindingMatches) {
          // Keep the valid attempt available to its browser when a callback has a wrong cookie.
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        const currentNow = clock();
        if (!isSafeTimestamp(currentNow) || currentNow < now) throw new Error('Invalid GitHub App authorization clock');
        if (expiresAt <= Math.max(now, currentNow)) {
          await client.query(
            `DELETE FROM ${schema}.github_app_oauth_states
              WHERE state = $1
              RETURNING state`,
            [state],
          );
          await client.query('COMMIT');
          rollbackNeeded = false;
          return undefined;
        }

        const deleted = await client.query(
          `DELETE FROM ${schema}.github_app_oauth_states
            WHERE state = $1
            RETURNING state`,
          [state],
        );
        if (deleted.rows.length !== 1) throw new Error('GitHub App authorization state was not deleted');
        await client.query('COMMIT');
        rollbackNeeded = false;
        return { githubUserId, codeVerifier };
      } catch (error) {
        if (rollbackNeeded) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error('PostgreSQL rollback failed');
          }
        }
        throw error;
      } finally {
        if (releaseError) client.release(releaseError);
        else client.release();
      }
    },
  };

  const githubRepositoriesStore: GitHubRepositoriesStore = {
    async replaceForUser(githubUserId, repositories, now): Promise<void> {
      if (
        !GITHUB_USER_ID_PATTERN.test(githubUserId) ||
        !isSafeTimestamp(now) ||
        !Array.isArray(repositories) ||
        repositories.length > MAX_REPOSITORIES ||
        !repositories.every(validRepositorySummary)
      ) {
        throw new TypeError('Invalid GitHub repository synchronization');
      }
      const repositoryIds = repositories.map((repository) => repository.repositoryId);
      if (new Set(repositoryIds).size !== repositoryIds.length) throw new TypeError('Duplicate GitHub repository');
      const client = await pool.connect();
      let rollbackNeeded = true;
      let releaseError: Error | undefined;
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM ${schema}.github_app_repositories
            WHERE github_user_id = $1
              AND NOT (repository_id = ANY($2::bigint[]))`,
          [githubUserId, repositoryIds],
        );
        await client.query(
          `INSERT INTO ${schema}.github_app_repositories
            (github_user_id, repository_id, installation_id, full_name, is_private, default_branch, html_url, last_synced_at_ms)
           SELECT $1, incoming.repository_id, incoming.installation_id, incoming.full_name,
                  incoming.is_private, incoming.default_branch, incoming.html_url, $3
             FROM jsonb_to_recordset($2::jsonb) AS incoming
               (repository_id bigint, installation_id bigint, full_name text, is_private boolean,
                default_branch text, html_url text)
           ON CONFLICT (github_user_id, repository_id) DO UPDATE SET
             installation_id = EXCLUDED.installation_id,
             full_name = EXCLUDED.full_name,
             is_private = EXCLUDED.is_private,
             default_branch = EXCLUDED.default_branch,
             html_url = EXCLUDED.html_url,
             last_synced_at_ms = EXCLUDED.last_synced_at_ms`,
          [githubUserId, JSON.stringify(repositories), now],
        );
        await client.query('COMMIT');
        rollbackNeeded = false;
      } catch (error) {
        if (rollbackNeeded) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error('PostgreSQL rollback failed');
          }
        }
        throw error;
      } finally {
        if (releaseError) client.release(releaseError);
        else client.release();
      }
    },

    async listForUser(githubUserId): Promise<readonly GitHubRepositoryRecord[]> {
      if (!GITHUB_USER_ID_PATTERN.test(githubUserId)) return [];
      const result = await pool.query(
        `SELECT r.repository_id::text AS repository_id,
                r.installation_id::text AS installation_id,
                r.full_name,
                r.is_private,
                r.default_branch,
                r.html_url,
                (s.repository_id IS NOT NULL) AS is_selected
           FROM ${schema}.github_app_repositories AS r
           LEFT JOIN ${schema}.github_app_selected_repositories AS s
             ON s.github_user_id = r.github_user_id
            AND s.repository_id = r.repository_id
          WHERE r.github_user_id = $1
          ORDER BY lower(r.full_name), r.repository_id`,
        [githubUserId],
      );
      const repositories: GitHubRepositoryRecord[] = [];
      for (const rawRow of result.rows) {
        if (typeof rawRow !== 'object' || rawRow === null || Array.isArray(rawRow)) throw new Error('Invalid GitHub repository row');
        const row = rawRow as Record<string, unknown>;
        const repository: GitHubRepositorySummary = {
          repositoryId: String(row.repository_id ?? ''),
          installationId: String(row.installation_id ?? ''),
          fullName: row.full_name as string,
          isPrivate: row.is_private as boolean,
          defaultBranch: row.default_branch as string | null,
          htmlUrl: row.html_url as string,
        };
        if (!validRepositorySummary(repository) || typeof row.is_selected !== 'boolean') {
          throw new Error('Invalid GitHub repository row');
        }
        repositories.push(Object.freeze({ ...repository, isSelected: row.is_selected }));
      }
      return Object.freeze(repositories);
    },

    async setSelectedForUser(githubUserId, repositoryId, now): Promise<boolean> {
      if (!GITHUB_USER_ID_PATTERN.test(githubUserId) || !isSafeTimestamp(now)) return false;
      if (repositoryId === null) {
        await pool.query(
          `DELETE FROM ${schema}.github_app_selected_repositories
            WHERE github_user_id = $1`,
          [githubUserId],
        );
        return true;
      }
      if (!REPOSITORY_ID_PATTERN.test(repositoryId)) return false;
      const result = await pool.query(
        `INSERT INTO ${schema}.github_app_selected_repositories
          (github_user_id, repository_id, selected_at_ms)
         SELECT $1, r.repository_id, $3
           FROM ${schema}.github_app_repositories AS r
          WHERE r.github_user_id = $1
            AND r.repository_id = $2::bigint
         ON CONFLICT (github_user_id) DO UPDATE SET
           repository_id = EXCLUDED.repository_id,
           selected_at_ms = EXCLUDED.selected_at_ms
         RETURNING repository_id`,
        [githubUserId, repositoryId, now],
      );
      return result.rows.length === 1;
    },
  };

  const sessionStore: SaasSessionStore = {
    async create(digest, githubUserId, expiresAt, now): Promise<void> {
      if (!validSessionInput(digest, githubUserId, expiresAt, now)) {
        throw new TypeError('Invalid session record');
      }
      await pool.query(
        `INSERT INTO ${schema}.sessions
          (token_digest, github_user_id, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4)`,
        [digest, githubUserId, now, expiresAt],
      );
    },

    async findActive(digest, now): Promise<unknown | undefined> {
      if (!SESSION_DIGEST_PATTERN.test(digest) || !isSafeTimestamp(now)) return undefined;
      const result = await pool.query(
        `SELECT github_user_id, expires_at_ms
           FROM ${schema}.sessions
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
        `UPDATE ${schema}.sessions
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

  return Object.freeze({ githubAuthStateStore, githubAppAuthorizationStateStore, githubRepositoriesStore, sessionStore });
}
