import { Pool } from 'pg';
import type { PostgresClient, PostgresPool, PostgresQueryExecutor, PostgresQueryResult } from './postgres-stores';

const MAX_CONNECTION_STRING_LENGTH = 4_096;

export class OfficeBotsPostgresConfigurationError extends Error {
  constructor() {
    super('Office Bots database is not configured');
    this.name = 'OfficeBotsPostgresConfigurationError';
  }
}

function validConnectionString(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONNECTION_STRING_LENGTH ||
    value !== value.trim()
  ) return false;
  try {
    const url = new URL(value);
    const sslMode = url.searchParams.get('sslmode');
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      !!url.hostname &&
      !!url.username &&
      !!url.password &&
      !!sslMode &&
      ['require', 'verify-ca', 'verify-full'].includes(sslMode)
    );
  } catch {
    return false;
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
  if (!validConnectionString(connectionString)) throw new OfficeBotsPostgresConfigurationError();
  if (sharedPool && sharedConnectionString !== connectionString) {
    throw new OfficeBotsPostgresConfigurationError();
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
