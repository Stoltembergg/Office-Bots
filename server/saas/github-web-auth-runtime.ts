import { createGitHubAppAuthorizationFlow } from './github-auth.js';
import { createGitHubAppOAuthAdapter } from './github-oauth-adapter.js';
import {
  createPostgresSaasStores,
  officeBotsDatabaseSchemaForEnvironment,
  type PostgresPool,
} from './postgres-stores.js';
import { createSaasSessionManager, type SaasSessionManager } from './sessions.js';
import { officeBotsPostgresPool } from './vercel-postgres-pool.js';

export const OFFICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class GitHubWebAuthConfigurationError extends Error {
  constructor() {
    super('GitHub web authentication is not configured');
    this.name = 'GitHubWebAuthConfigurationError';
  }
}

export interface GitHubWebAuthRuntime {
  readonly appOrigin: string;
  readonly flow: ReturnType<typeof createGitHubAppAuthorizationFlow>;
  readonly sessions: SaasSessionManager;
}

export interface GitHubWebAuthRuntimeOptions {
  /** Test seam; production uses the shared Vercel PostgreSQL pool. */
  readonly pool?: PostgresPool;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new GitHubWebAuthConfigurationError();
  }
  return value;
}

function configuredOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.href !== `${url.origin}/`) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new GitHubWebAuthConfigurationError();
  }
}

/** Builds a server-only runtime; no credentials are read by the browser bundle. */
export function createGitHubWebAuthRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: GitHubWebAuthRuntimeOptions = {},
): GitHubWebAuthRuntime {
  try {
    const appOrigin = configuredOrigin(required(env, 'OFFICE_BOT_APP_ORIGIN'));
    const callbackUrl = required(env, 'GITHUB_OAUTH_CALLBACK_URL');
    const callback = new URL(callbackUrl);
    if (
      callback.origin !== appOrigin ||
      callback.pathname !== '/api/auth/github/callback' ||
      callback.search ||
      callback.hash
    ) {
      throw new GitHubWebAuthConfigurationError();
    }

    const pool = options.pool ?? officeBotsPostgresPool(required(env, 'OFFICE_BOTS_DATABASE_URL'));
    const stores = createPostgresSaasStores(pool, {
      clock: options.now,
      schema: officeBotsDatabaseSchemaForEnvironment(env),
    });
    const flow = createGitHubAppAuthorizationFlow({
      config: {
        clientId: required(env, 'GITHUB_OAUTH_CLIENT_ID'),
        callbackUrl,
      },
      stateStore: stores.githubAuthStateStore,
      now: options.now,
      adapter: createGitHubAppOAuthAdapter({
        clientSecret: required(env, 'GITHUB_OAUTH_CLIENT_SECRET'),
        fetch: options.fetch,
      }),
    });
    const sessions = createSaasSessionManager({
      store: stores.sessionStore,
      ttlMs: OFFICE_SESSION_TTL_MS,
      now: options.now,
    });

    return Object.freeze({
      appOrigin,
      flow,
      sessions,
    });
  } catch {
    throw new GitHubWebAuthConfigurationError();
  }
}
