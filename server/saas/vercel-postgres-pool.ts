import { Pool, type PoolClient } from 'pg';
import type { PostgresClient, PostgresPool, PostgresQueryExecutor, PostgresQueryResult } from './postgres-stores.js';

const MAX_CONNECTION_STRING_LENGTH = 4_096;

export type DatabaseConfigurationIssue = 'format' | 'protocol' | 'host' | 'username' | 'password' | 'sslmode' | 'changed';

export class OfficeBotsPostgresConfigurationError extends Error {
  constructor(readonly issue: DatabaseConfigurationIssue = 'format') {
    super('Office Bots database is not configured');
    this.name = 'OfficeBotsPostgresConfigurationError';
  }
}

/** Report fixed categories only: driver errors may contain credentials, SQL or parameters. */
function reportDatabaseFailure(error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : '';
  let category = 'unknown';
  if (message.includes('Tenant or user not found')) category = 'pooler-tenant-or-user';
  else if (code === '28P01' || code === '28000') category = 'authentication';
  else if (code === '42501') category = 'permission';
  else if (code === '42P01' || code === '3F000') category = 'missing-schema-or-table';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') category = 'dns';
  else if (code === 'ETIMEDOUT' || message === 'Connection terminated due to connection timeout') category = 'timeout';
  else if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') category = 'network';
  else if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'CERT_HAS_EXPIRED' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') category = 'tls';
  console.error('[office-bots] database failure', category);
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
  })).catch((error: unknown) => {
    reportDatabaseFailure(error);
    throw error;
  });
}

function asPostgresPool(pool: Pool): PostgresPool {
  return Object.freeze({
    query: (sql: string, values?: unknown[]) => execute(pool, sql, values),
    async connect(): Promise<PostgresClient> {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        reportDatabaseFailure(error);
        throw error;
      }
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
