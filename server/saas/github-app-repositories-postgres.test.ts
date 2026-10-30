import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPostgresSaasStores,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
} from './postgres-stores';

const USER_ID = '12345';
const STATE = 'S'.repeat(43);
const BINDING_DIGEST = createHash('sha256').update('synthetic browser binding').digest('hex');
const OTHER_DIGEST = createHash('sha256').update('different synthetic binding').digest('hex');
const VERIFIER = 'V'.repeat(43);
const REPOSITORY = {
  repositoryId: '9001',
  installationId: '7001',
  fullName: 'octo/example',
  isPrivate: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octo/example',
};

interface Query {
  readonly sql: string;
  readonly values?: unknown[];
}

function fakePool(options: {
  readonly poolQuery?: (sql: string, values?: unknown[]) => Promise<PostgresQueryResult>;
  readonly clientQuery?: (sql: string, values?: unknown[]) => Promise<PostgresQueryResult>;
} = {}) {
  const poolQueries: Query[] = [];
  const clientQueries: Query[] = [];
  const pool: PostgresPool = {
    async query(sql, values) {
      poolQueries.push({ sql, values });
      return (await options.poolQuery?.(sql, values)) ?? { rows: [] };
    },
    async connect() {
      return {
        async query(sql, values) {
          clientQueries.push({ sql, values });
          return (await options.clientQuery?.(sql, values)) ?? { rows: [] };
        },
        release() {},
      } satisfies PostgresClient;
    },
  };
  return { pool, poolQueries, clientQueries };
}

function sql(query: Query | undefined): string {
  return query?.sql.replace(/\s+/g, ' ').trim() ?? '';
}

describe('GitHub App repository Postgres stores', () => {
  it('persists only a state digest and verifier bound to an Office user', async () => {
    const fake = fakePool();
    const stores = createPostgresSaasStores(fake.pool);

    await stores.githubAppAuthorizationStateStore.issue(STATE, USER_ID, BINDING_DIGEST, VERIFIER, 70_000, 10_000);

    expect(sql(fake.poolQueries[0])).toContain('INSERT INTO office_bots_private.github_app_oauth_states');
    expect(fake.poolQueries[0]?.values).toEqual([STATE, USER_ID, BINDING_DIGEST, VERIFIER, 10_000, 70_000]);
    expect(sql(fake.poolQueries[0])).not.toContain(VERIFIER);
  });

  it('atomically consumes installation authorization state only after matching its binding', async () => {
    const fake = fakePool({
      clientQuery: async (statement) => {
        if (statement.includes('SELECT github_user_id')) {
          return {
            rows: [{
              github_user_id: USER_ID,
              binding_digest: BINDING_DIGEST,
              code_verifier: VERIFIER,
              expires_at_ms: '90000',
            }],
          };
        }
        if (statement.includes('DELETE FROM office_bots_private.github_app_oauth_states')) {
          return { rows: [{ state: STATE }] };
        }
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAppAuthorizationStateStore.consume(STATE, BINDING_DIGEST, 20_000)).resolves.toEqual({
      githubUserId: USER_ID,
      codeVerifier: VERIFIER,
    });
    expect(fake.clientQueries.map(sql)).toEqual([
      'BEGIN',
      'SELECT github_user_id, binding_digest, code_verifier, expires_at_ms FROM office_bots_private.github_app_oauth_states WHERE state = $1 FOR UPDATE',
      'DELETE FROM office_bots_private.github_app_oauth_states WHERE state = $1 RETURNING state',
      'COMMIT',
    ]);
  });

  it('does not consume state when the browser binding does not match', async () => {
    const fake = fakePool({
      clientQuery: async (statement) =>
        statement.includes('SELECT github_user_id')
          ? { rows: [{ github_user_id: USER_ID, binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '90000' }] }
          : { rows: [] },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAppAuthorizationStateStore.consume(STATE, OTHER_DIGEST, 20_000)).resolves.toBeUndefined();
    expect(fake.clientQueries.some((query) => query.sql.includes('DELETE'))).toBe(false);
    expect(fake.clientQueries.at(-1)?.sql).toBe('COMMIT');
  });

  it('synchronizes only one user’s GitHub repository metadata in a transaction', async () => {
    const fake = fakePool();
    const stores = createPostgresSaasStores(fake.pool);

    await stores.githubRepositoriesStore.replaceForUser(USER_ID, [REPOSITORY], 20_000);

    expect(fake.clientQueries.map(sql)).toEqual([
      'BEGIN',
      'DELETE FROM office_bots_private.github_app_repositories WHERE github_user_id = $1 AND NOT (repository_id = ANY($2::bigint[]))',
      'INSERT INTO office_bots_private.github_app_repositories (github_user_id, repository_id, installation_id, full_name, is_private, default_branch, html_url, last_synced_at_ms) SELECT $1, incoming.repository_id, incoming.installation_id, incoming.full_name, incoming.is_private, incoming.default_branch, incoming.html_url, $3 FROM jsonb_to_recordset($2::jsonb) AS incoming (repository_id bigint, installation_id bigint, full_name text, is_private boolean, default_branch text, html_url text) ON CONFLICT (github_user_id, repository_id) DO UPDATE SET installation_id = EXCLUDED.installation_id, full_name = EXCLUDED.full_name, is_private = EXCLUDED.is_private, default_branch = EXCLUDED.default_branch, html_url = EXCLUDED.html_url, last_synced_at_ms = EXCLUDED.last_synced_at_ms',
      'COMMIT',
    ]);
    expect(fake.clientQueries[1]?.values).toEqual([USER_ID, ['9001']]);
    expect(fake.clientQueries[2]?.values).toEqual([USER_ID, JSON.stringify([REPOSITORY]), 20_000]);
  });

  it('lists repositories and the current user’s selected repository with a user-scoped query', async () => {
    const fake = fakePool({
      poolQuery: async (statement) => statement.includes('FROM office_bots_private.github_app_repositories')
        ? { rows: [{
          repository_id: '9001',
          installation_id: '7001',
          full_name: REPOSITORY.fullName,
          is_private: true,
          default_branch: 'main',
          html_url: REPOSITORY.htmlUrl,
          is_selected: true,
        }] }
        : { rows: [] },
    });
    const stores = createPostgresSaasStores(fake.pool);

    await expect(stores.githubRepositoriesStore.listForUser(USER_ID)).resolves.toEqual([{
      ...REPOSITORY,
      isSelected: true,
    }]);
    expect(sql(fake.poolQueries[0])).toContain('WHERE r.github_user_id = $1');
    expect(fake.poolQueries[0]?.values).toEqual([USER_ID]);
  });

  it('selects only repositories owned by the current Office user', async () => {
    const fake = fakePool({ poolQuery: async () => ({ rows: [] }) });
    const stores = createPostgresSaasStores(fake.pool);

    await expect(stores.githubRepositoriesStore.setSelectedForUser(USER_ID, '9001', 20_000)).resolves.toBe(false);
    expect(sql(fake.poolQueries[0])).toContain('FROM office_bots_private.github_app_repositories AS r');
    expect(sql(fake.poolQueries[0])).toContain('WHERE r.github_user_id = $1 AND r.repository_id = $2::bigint');
    expect(fake.poolQueries[0]?.values).toEqual([USER_ID, '9001', 20_000]);
  });
});
