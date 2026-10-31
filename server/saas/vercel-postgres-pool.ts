import { Pool } from 'pg';
import type { PostgresClient, PostgresPool, PostgresQueryExecutor, PostgresQueryResult } from './postgres-stores.js';

const MAX_CONNECTION_STRING_LENGTH = 4_096;

export type DatabaseConfigurationIssue = 'format' | 'protocol' | 'host' | 'username' | 'password' | 'sslmode' | 'changed';

export class OfficeBotsPostgresConfigurationError extends Error {
  constructor(readonly issue: DatabaseConfigurationIssue = 'format') {
    super('Office Bots database is not configured');
    this.name = 'OfficeBotsPostgresConfigurationError';
  }
}

function connectionStringIssue(value: unknown): DatabaseConfigurationIssue | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONNECTION_STRING_LENGTH ||
    value !== value.trim()
  ) return 'format';
  try {
    const url = new URL(value);
    const sslMode = url.searchParams.get('sslmode');
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'protocol';
    if (!url.hostname) return 'host';
    if (!url.username) return 'username';
    if (!url.password) return 'password';
    if (!sslMode || !['require', 'verify-ca', 'verify-full'].includes(sslMode)) return 'sslmode';
    return undefined;
  } catch {
    return 'format';
  }
}

function execute(executor: PostgresQueryExecutor, sql: string, values?: unknown[]): Promise<PostgresQueryResult> {
  return executor.query(sql, values).then((result) => ({
    rows: result.rows as readonly Record<string, unknown>[],
  }));
}

function asPostgresPool(pool: Pool): PostgresPool {
  return Object.freeze({
    query: (sql: string, values?: unknown[]) => execute(pool, sql, values),
    async connect(): Promise<PostgresClient> {
      const client = await pool.connect();
      return Object.freeze({
        query: (sql: string, values?: unknown[]) => execute(client, sql, values),
        release: (error?: Error | boolean) => client.release(error),
      });
    },
  });
}

let sharedPool: Pool | undefined;
let sharedConnectionString: string | undefined;

/** Reuses one small pool across warm Vercel invocations; the database role is limited to auth tables. */
export function officeBotsPostgresPool(connectionString: string): PostgresPool {
  const issue = connectionStringIssue(connectionString);
  if (issue) throw new OfficeBotsPostgresConfigurationError(issue);
  if (sharedPool && sharedConnectionString !== connectionString) {
    throw new OfficeBotsPostgresConfigurationError('changed');
  }
  if (!sharedPool) {
    sharedConnectionString = connectionString;
    sharedPool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      application_name: 'office-bots-web-auth',
    });
    // Pool errors can include connection details; do not let them become unhandled process events or logs.
    sharedPool.on('error', () => undefined);
  }
  return asPostgresPool(sharedPool);
}
