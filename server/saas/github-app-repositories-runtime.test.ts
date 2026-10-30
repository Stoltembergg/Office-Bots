import { describe, expect, it } from 'vitest';
import {
  createGitHubAppRepositoriesRuntime,
  GitHubAppRepositoriesConfigurationError,
} from './github-app-repositories-runtime';
import type { PostgresPool } from './postgres-stores';

function env(): NodeJS.ProcessEnv {
  return {
    OFFICE_BOT_APP_ORIGIN: 'https://office-bots.example',
    GITHUB_APP_SLUG: 'office-bots',
    GITHUB_APP_CLIENT_ID: 'github-app-client-id',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-github-app-secret',
    GITHUB_APP_CALLBACK_URL: 'https://office-bots.example/api/github/app/callback',
  };
}

describe('GitHub App repository runtime', () => {
  it('wires the App OAuth flow, sessions, and repository stores to server-side Postgres', async () => {
    const statements: string[] = [];
    const pool: PostgresPool = {
      async query(statement) {
        statements.push(statement);
        return { rows: [] };
      },
      async connect() {
        throw new Error('transactions are not expected during authorization start');
      },
    };
    const runtime = createGitHubAppRepositoriesRuntime(env(), { pool, now: () => 10_000 });

    const authorization = await runtime.flow.beginAuthorization('12345', 'b'.repeat(43));
    const session = await runtime.sessions.create('12345');
    const url = new URL(authorization.authorizationUrl);

    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('client_id')).toBe('github-app-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://office-bots.example/api/github/app/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statements[0]).toContain('office_bots_private.github_app_oauth_states');
    expect(statements[1]).toContain('office_bots_private.sessions');
  });

  it('rejects callbacks outside the configured Office origin and callback path', () => {
    for (const callbackUrl of [
      'https://attacker.example/api/github/app/callback',
      'https://office-bots.example/api/auth/github/callback',
      'https://office-bots.example/api/github/app/callback?next=https://attacker.example',
    ]) {
      const invalid = env();
      invalid.GITHUB_APP_CALLBACK_URL = callbackUrl;
      expect(() => createGitHubAppRepositoriesRuntime(invalid, {
        pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error(); } },
      })).toThrow(GitHubAppRepositoriesConfigurationError);
    }
  });

  it('does not expose configured secrets in configuration failures', () => {
    const invalid = env();
    invalid.GITHUB_APP_SLUG = 'https://attacker.example';
    try {
      createGitHubAppRepositoriesRuntime(invalid, {
        pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error(); } },
      });
      throw new Error('expected configuration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubAppRepositoriesConfigurationError);
      expect((error as Error).message).not.toContain('synthetic-github-app-secret');
    }
  });
});
