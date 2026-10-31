import { createGitHubAppRepositoriesAuthorizationFlow, type GitHubAppRepositoriesAdapter } from './github-app-repositories';
import { createGitHubAppRepositoriesAdapter } from './github-app-repositories-adapter';
import { createGitHubAppOAuthAdapter } from './github-oauth-adapter';
import {
  createPostgresSaasStores,
  officeBotsDatabaseSchemaForEnvironment,
  type PostgresPool,
} from './postgres-stores';
import { createSaasSessionManager, type SaasSessionManager } from './sessions';
import { officeBotsPostgresPool } from './vercel-postgres-pool';

export const OFFICE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class GitHubAppRepositoriesConfigurationError extends Error {
  constructor() {
    super('GitHub App repository integration is not configured');
    this.name = 'GitHubAppRepositoriesConfigurationError';
  }
}

export interface GitHubAppRepositoriesRuntime {
  readonly appOrigin: string;
  readonly appSlug: string;
  readonly flow: ReturnType<typeof createGitHubAppRepositoriesAuthorizationFlow>;
  readonly sessions: SaasSessionManager;
  readonly repositoriesStore: ReturnType<typeof createPostgresSaasStores>['githubRepositoriesStore'];
  readonly now: () => number;
}

export interface GitHubAppRepositoriesRuntimeOptions {
  readonly pool?: PostgresPool;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) throw new GitHubAppRepositoriesConfigurationError();
  return value;
}

function configuredOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new GitHubAppRepositoriesConfigurationError();
  }
}

/** Creates the server-only installation, repository, session, and Postgres wiring. */
export function createGitHubAppRepositoriesRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: GitHubAppRepositoriesRuntimeOptions = {},
): GitHubAppRepositoriesRuntime {
  try {
    const appOrigin = configuredOrigin(required(env, 'OFFICE_BOT_APP_ORIGIN'));
    const appSlug = required(env, 'GITHUB_APP_SLUG');
    const clientId = required(env, 'GITHUB_APP_CLIENT_ID');
    const clientSecret = required(env, 'GITHUB_APP_CLIENT_SECRET');
    const callbackUrl = required(env, 'GITHUB_APP_CALLBACK_URL');
    const callback = new URL(callbackUrl);
    if (
      callback.origin !== appOrigin ||
      callback.pathname !== '/api/github/app/callback' ||
      callback.search ||
      callback.hash ||
      callback.href !== callbackUrl
    ) {
      throw new GitHubAppRepositoriesConfigurationError();
    }

    const pool = options.pool ?? officeBotsPostgresPool(required(env, 'OFFICE_BOTS_DATABASE_URL'));
    const now = options.now ?? Date.now;
    const stores = createPostgresSaasStores(pool, {
      clock: now,
      schema: officeBotsDatabaseSchemaForEnvironment(env),
    });
    const oauth = createGitHubAppOAuthAdapter({ clientSecret, fetch: options.fetch });
    const githubApi = createGitHubAppRepositoriesAdapter({ appSlug, fetch: options.fetch });
    const adapter: GitHubAppRepositoriesAdapter = Object.freeze({
      exchangeCode: (input: Parameters<typeof oauth.exchangeCode>[0]) => oauth.exchangeCode(input),
      getIdentity: (token: string) => oauth.getIdentity(token),
      listRepositories: (token: string) => githubApi.listRepositories(token),
    });
    const flow = createGitHubAppRepositoriesAuthorizationFlow({
      config: { clientId, callbackUrl },
      stateStore: stores.githubAppAuthorizationStateStore,
      adapter,
      now,
    });
    const sessions = createSaasSessionManager({
      store: stores.sessionStore,
      ttlMs: OFFICE_SESSION_TTL_MS,
      now,
    });

    return Object.freeze({
      appOrigin,
      appSlug,
      flow,
      sessions,
      repositoriesStore: stores.githubRepositoriesStore,
      now,
    });
  } catch {
    throw new GitHubAppRepositoriesConfigurationError();
  }
}
