import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPostgresSaasStores, type PostgresClient, type PostgresPool, type PostgresQueryResult } from './postgres-stores';

const STATE = 'S'.repeat(43);
const BINDING_DIGEST = createHash('sha256').update('synthetic browser binding').digest('hex');
const OTHER_BINDING_DIGEST = createHash('sha256').update('different synthetic binding').digest('hex');
const VERIFIER = 'V'.repeat(43);
const SESSION_DIGEST = 'a'.repeat(64);

interface RecordedQuery {
  readonly sql: string;
  readonly values?: unknown[];
}

/**
 * Fake SQL boundary for unit tests only. These tests check statements and control flow, but do not
 * execute PostgreSQL and therefore do not prove real row-lock or transaction atomicity.
 */
function createFakePool(options: {
  readonly poolQuery?: (sql: string, values?: unknown[]) => Promise<PostgresQueryResult>;
  readonly clientQuery?: (sql: string, values?: unknown[]) => Promise<PostgresQueryResult>;
} = {}) {
  const poolQueries: RecordedQuery[] = [];
  const clientQueries: RecordedQuery[] = [];
  const releaseErrors: (Error | boolean | undefined)[] = [];
  let releaseCount = 0;

  const pool: PostgresPool = {
    async query(sql, values): Promise<PostgresQueryResult> {
      poolQueries.push({ sql, values });
      return (await options.poolQuery?.(sql, values)) ?? { rows: [] };
    },
    async connect(): Promise<PostgresClient> {
      return {
        async query(sql, values): Promise<PostgresQueryResult> {
          clientQueries.push({ sql, values });
          return (await options.clientQuery?.(sql, values)) ?? { rows: [] };
        },
        release(error?: Error | boolean): void {
          releaseCount += 1;
          releaseErrors.push(error);
        },
      };
    },
  };

  return {
    pool,
    poolQueries,
    clientQueries,
    releaseErrors,
    get releaseCount() {
      return releaseCount;
    },
  };
}

function normalizedSql(query: RecordedQuery | undefined): string {
  return query?.sql.replace(/\s+/g, ' ').trim() ?? '';
}

describe('stores SaaS Postgres sem driver', () => {
  it('persiste state apenas por parâmetros com digest, verifier e validade', async () => {
    const fake = createFakePool();
    const stores = createPostgresSaasStores(fake.pool);

    await stores.githubAuthStateStore.issue(STATE, BINDING_DIGEST, VERIFIER, 70_000, 10_000);

    expect(fake.poolQueries).toHaveLength(1);
    expect(normalizedSql(fake.poolQueries[0])).toContain('INSERT INTO office_bots_private.oauth_states');
    expect(fake.poolQueries[0]?.values).toEqual([STATE, BINDING_DIGEST, VERIFIER, 10_000, 70_000]);
    expect(normalizedSql(fake.poolQueries[0])).not.toContain(VERIFIER);
    expect(fake.clientQueries).toHaveLength(0);
  });

  it('consome state com lock, delete e commit antes de devolver verifier', async () => {
    const fake = createFakePool({
      clientQuery: async (sql) => {
        if (sql.includes('SELECT binding_digest')) {
          return {
            rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '90000' }],
          };
        }
        if (sql.includes('DELETE FROM office_bots_private.oauth_states')) return { rows: [{ state: STATE }] };
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 20_000)).resolves.toBe(VERIFIER);

    expect(fake.clientQueries.map(normalizedSql)).toEqual([
      'BEGIN',
      'SELECT binding_digest, code_verifier, expires_at_ms FROM office_bots_private.oauth_states WHERE state = $1 FOR UPDATE',
      'DELETE FROM office_bots_private.oauth_states WHERE state = $1 RETURNING state',
      'COMMIT',
    ]);
    expect(fake.clientQueries[1]?.values).toEqual([STATE]);
    expect(fake.clientQueries[2]?.values).toEqual([STATE]);
    expect(fake.releaseCount).toBe(1);
    expect(fake.poolQueries).toHaveLength(0);
  });

  it('binding incorreto não deleta nem consome o state', async () => {
    const fake = createFakePool({
      clientQuery: async (sql) =>
        sql.includes('SELECT binding_digest')
          ? { rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '90000' }] }
          : { rows: [] },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAuthStateStore.consume(STATE, OTHER_BINDING_DIGEST, 20_000)).resolves.toBeUndefined();

    expect(fake.clientQueries.map(normalizedSql)).toEqual([
      'BEGIN',
      'SELECT binding_digest, code_verifier, expires_at_ms FROM office_bots_private.oauth_states WHERE state = $1 FOR UPDATE',
      'COMMIT',
    ]);
    expect(fake.clientQueries.some((query) => query.sql.includes('DELETE'))).toBe(false);
    expect(fake.releaseCount).toBe(1);
  });

  it('state expirado só é removido após binding correto e nunca retorna verifier', async () => {
    const fake = createFakePool({
      clientQuery: async (sql) => {
        if (sql.includes('SELECT binding_digest')) {
          return {
            rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '20000' }],
          };
        }
        if (sql.includes('DELETE')) return { rows: [{ state: STATE }] };
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 20_000)).resolves.toBeUndefined();
    expect(fake.clientQueries.map(normalizedSql)).toEqual([
      'BEGIN',
      'SELECT binding_digest, code_verifier, expires_at_ms FROM office_bots_private.oauth_states WHERE state = $1 FOR UPDATE',
      'DELETE FROM office_bots_private.oauth_states WHERE state = $1 RETURNING state',
      'COMMIT',
    ]);
    expect(fake.releaseCount).toBe(1);
  });

  it('rollback e release ocorrem quando query, delete ou commit falha', async () => {
    for (const failedStatement of ['SELECT binding_digest', 'DELETE FROM', 'COMMIT']) {
      const fake = createFakePool({
        clientQuery: async (sql) => {
          if (sql.includes(failedStatement)) throw new Error('synthetic database failure');
          if (sql.includes('SELECT binding_digest')) {
            return {
              rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '90000' }],
            };
          }
          if (sql.includes('DELETE')) return { rows: [{ state: STATE }] };
          return { rows: [] };
        },
      });
      const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

      await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 20_000)).rejects.toThrow(
        'synthetic database failure',
      );
      expect(fake.clientQueries.at(-1)?.sql).toBe('ROLLBACK');
      expect(fake.releaseCount).toBe(1);
    }
  });

  it('não abre transação para digest de binding malformado', async () => {
    const fake = createFakePool();
    const stores = createPostgresSaasStores(fake.pool);

    await expect(stores.githubAuthStateStore.consume(STATE, 'not-a-digest', 20_000)).resolves.toBeUndefined();
    expect(fake.clientQueries).toHaveLength(0);
    expect(fake.releaseCount).toBe(0);
  });

  it('revalida o prazo com o relógio após esperar pelo lock', async () => {
    let currentTime = 10_000;
    const fake = createFakePool({
      clientQuery: async (sql) => {
        if (sql.includes('SELECT binding_digest')) {
          // Simula que a aquisição do lock só terminou depois de o state expirar.
          currentTime = 20_000;
          return {
            rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '20000' }],
          };
        }
        if (sql.includes('DELETE')) return { rows: [{ state: STATE }] };
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => currentTime });

    await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 10_000)).resolves.toBeUndefined();
    expect(fake.clientQueries.map(normalizedSql)).toEqual([
      'BEGIN',
      'SELECT binding_digest, code_verifier, expires_at_ms FROM office_bots_private.oauth_states WHERE state = $1 FOR UPDATE',
      'DELETE FROM office_bots_private.oauth_states WHERE state = $1 RETURNING state',
      'COMMIT',
    ]);
    expect(fake.releaseCount).toBe(1);
  });

  it('falha fechado e faz rollback se o relógio falhar ou regredir', async () => {
    for (const clock of [
      () => {
        throw new Error('synthetic clock failure');
      },
      () => 19_999,
    ]) {
      const fake = createFakePool({
        clientQuery: async (sql) =>
          sql.includes('SELECT binding_digest')
            ? { rows: [{ binding_digest: BINDING_DIGEST, code_verifier: VERIFIER, expires_at_ms: '90000' }] }
            : { rows: [] },
      });
      const stores = createPostgresSaasStores(fake.pool, { clock });

      await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 20_000)).rejects.toThrow();
      expect(fake.clientQueries.at(-1)?.sql).toBe('ROLLBACK');
      expect(fake.releaseCount).toBe(1);
      expect(fake.releaseErrors).toEqual([undefined]);
    }
  });

  it('descarta a conexão do pool se ROLLBACK falhar', async () => {
    const queryFailure = new Error('synthetic query failure');
    const rollbackFailure = new Error('synthetic rollback failure');
    const fake = createFakePool({
      clientQuery: async (sql) => {
        if (sql.includes('SELECT binding_digest')) throw queryFailure;
        if (sql === 'ROLLBACK') throw rollbackFailure;
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool, { clock: () => 20_000 });

    await expect(stores.githubAuthStateStore.consume(STATE, BINDING_DIGEST, 20_000)).rejects.toBe(queryFailure);
    expect(fake.clientQueries.at(-1)?.sql).toBe('ROLLBACK');
    expect(fake.releaseCount).toBe(1);
    expect(fake.releaseErrors).toEqual([rollbackFailure]);
  });

  it('cria sessões com digest, e faz lookup parametrizado no pool primário com expiração estrita', async () => {
    const fake = createFakePool({
      poolQuery: async (sql) =>
        sql.includes('SELECT github_user_id')
          ? { rows: [{ github_user_id: '42', expires_at_ms: '60000' }] }
          : { rows: [] },
    });
    const stores = createPostgresSaasStores(fake.pool);

    await stores.sessionStore.create(SESSION_DIGEST, '42', 60_000, 10_000);
    await expect(stores.sessionStore.findActive(SESSION_DIGEST, 20_000)).resolves.toEqual({
      githubUserId: '42',
      expiresAt: 60_000,
    });

    expect(fake.poolQueries).toHaveLength(2);
    expect(normalizedSql(fake.poolQueries[0])).toContain('INSERT INTO office_bots_private.sessions');
    expect(fake.poolQueries[0]?.values).toEqual([SESSION_DIGEST, '42', 10_000, 60_000]);
    expect(normalizedSql(fake.poolQueries[1])).toContain('revoked_at_ms IS NULL');
    expect(normalizedSql(fake.poolQueries[1])).toContain('expires_at_ms > $2');
    expect(fake.poolQueries[1]?.values).toEqual([SESSION_DIGEST, 20_000]);
    expect(fake.clientQueries).toHaveLength(0);
  });

  it('ignora resposta expirada do banco e revoga atomicamente apenas sessões ativas', async () => {
    const fake = createFakePool({
      poolQuery: async (sql) => {
        if (sql.includes('SELECT github_user_id')) {
          return { rows: [{ github_user_id: '42', expires_at_ms: '20000' }] };
        }
        if (sql.includes('UPDATE office_bots_private.sessions')) return { rows: [{ token_digest: SESSION_DIGEST }] };
        return { rows: [] };
      },
    });
    const stores = createPostgresSaasStores(fake.pool);

    await expect(stores.sessionStore.findActive(SESSION_DIGEST, 20_000)).resolves.toBeUndefined();
    await expect(stores.sessionStore.revoke(SESSION_DIGEST, 19_999)).resolves.toBe(true);
    expect(normalizedSql(fake.poolQueries[1])).toContain('UPDATE office_bots_private.sessions');
    expect(normalizedSql(fake.poolQueries[1])).toContain('revoked_at_ms IS NULL');
    expect(normalizedSql(fake.poolQueries[1])).toContain('expires_at_ms > $2');
    expect(fake.poolQueries[1]?.values).toEqual([SESSION_DIGEST, 19_999]);
  });

  it('recusa parâmetros inválidos sem enviar tokens brutos ao pool', async () => {
    const fake = createFakePool();
    const stores = createPostgresSaasStores(fake.pool);

    await expect(stores.sessionStore.create('raw-token', '42', 60_000, 10_000)).rejects.toThrow('Invalid session record');
    await expect(stores.sessionStore.findActive('raw-token', 10_000)).resolves.toBeUndefined();
    await expect(stores.sessionStore.revoke('raw-token', 10_000)).resolves.toBe(false);
    expect(fake.poolQueries).toHaveLength(0);
  });

  it('usa SQL sem placeholders interpolados ou prepared statements nomeados', async () => {
    const fake = createFakePool();
    const stores = createPostgresSaasStores(fake.pool);
    await stores.sessionStore.create(SESSION_DIGEST, '42', 60_000, 10_000);

    expect(fake.poolQueries[0]?.sql).toContain('$1');
    expect(fake.poolQueries[0]?.sql).not.toContain(SESSION_DIGEST);
    expect(fake.poolQueries[0]?.values).toEqual([SESSION_DIGEST, '42', 10_000, 60_000]);
  });
});
