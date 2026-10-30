import { describe, expect, it } from 'vitest';
import { createPostgresSaasStores, officeBotsDatabaseSchemaForEnvironment, type PostgresPool } from './postgres-stores';

const STATE = 'S'.repeat(43);
const BINDING_DIGEST = 'a'.repeat(64);
const VERIFIER = 'V'.repeat(43);
const SESSION_DIGEST = 'b'.repeat(64);

describe('Office Bots database schema isolation', () => {
  it('uses the production schema by default and requires explicit preview isolation', () => {
    expect(officeBotsDatabaseSchemaForEnvironment({})).toBe('office_bots_private');
    expect(officeBotsDatabaseSchemaForEnvironment({ VERCEL_ENV: 'production' })).toBe('office_bots_private');
    expect(() => officeBotsDatabaseSchemaForEnvironment({ VERCEL_ENV: 'preview' })).toThrow();
    expect(officeBotsDatabaseSchemaForEnvironment({
      VERCEL_ENV: 'preview',
      OFFICE_BOTS_DATABASE_SCHEMA: 'office_bots_preview_private',
    })).toBe('office_bots_preview_private');
  });

  it('rejects cross-environment schemas and arbitrary schema names', () => {
    expect(() => officeBotsDatabaseSchemaForEnvironment({
      VERCEL_ENV: 'production',
      OFFICE_BOTS_DATABASE_SCHEMA: 'office_bots_preview_private',
    })).toThrow();
    expect(() => officeBotsDatabaseSchemaForEnvironment({
      VERCEL_ENV: 'preview',
      OFFICE_BOTS_DATABASE_SCHEMA: 'office_bots_private',
    })).toThrow();
    expect(() => officeBotsDatabaseSchemaForEnvironment({
      OFFICE_BOTS_DATABASE_SCHEMA: 'public; DROP SCHEMA office_bots_private',
    })).toThrow();
  });

  it('routes store SQL to only the selected schema', async () => {
    const statements: string[] = [];
    const pool: PostgresPool = {
      async query(sql) {
        statements.push(sql);
        if (sql.includes('SELECT r.repository_id')) return { rows: [] };
        if (sql.includes('SELECT github_user_id, expires_at_ms')) {
          return { rows: [{ github_user_id: '12345', expires_at_ms: '90000' }] };
        }
        if (sql.includes('RETURNING repository_id')) return { rows: [{ repository_id: '42' }] };
        if (sql.includes('RETURNING token_digest')) return { rows: [{ token_digest: SESSION_DIGEST }] };
        return { rows: [] };
      },
      async connect() {
        throw new Error('transaction client not expected in this case');
      },
    };
    const stores = createPostgresSaasStores(pool, { schema: 'office_bots_preview_private' });

    await stores.githubAuthStateStore.issue(STATE, BINDING_DIGEST, VERIFIER, 70_000, 10_000);
    await stores.githubAppAuthorizationStateStore.issue(STATE, '12345', BINDING_DIGEST, VERIFIER, 70_000, 10_000);
    await stores.githubRepositoriesStore.listForUser('12345');
    await stores.githubRepositoriesStore.setSelectedForUser('12345', '42', 10_000);
    await stores.githubRepositoriesStore.setSelectedForUser('12345', null, 10_000);
    await stores.sessionStore.create(SESSION_DIGEST, '12345', 90_000, 10_000);
    await stores.sessionStore.findActive(SESSION_DIGEST, 10_000);
    await stores.sessionStore.revoke(SESSION_DIGEST, 10_000);

    expect(statements.length).toBeGreaterThan(1);
    expect(statements.every((sql) => sql.includes('office_bots_preview_private.'))).toBe(true);
    expect(statements.some((sql) => sql.includes('office_bots_private.'))).toBe(false);
  });
});
