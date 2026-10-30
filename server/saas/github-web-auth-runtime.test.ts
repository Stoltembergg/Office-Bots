import { describe, expect, it } from 'vitest';
import { createGitHubWebAuthRuntime, GitHubWebAuthConfigurationError, OFFICE_SESSION_TTL_MS } from './github-web-auth-runtime';
import type { PostgresPool } from './postgres-stores';
import { officeBotsPostgresPool, OfficeBotsPostgresConfigurationError } from './vercel-postgres-pool';

function env(): NodeJS.ProcessEnv {
  return {
    OFFICE_BOT_APP_ORIGIN: 'https://office-bots.example',
    GITHUB_OAUTH_CLIENT_ID: 'github-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'github-client-secret',
    GITHUB_OAUTH_CALLBACK_URL: 'https://office-bots.example/api/auth/github/callback',
  };
}

describe('GitHub web auth runtime', () => {
  it('wires GitHub PKCE and seven-day sessions to the shared PostgreSQL stores', async () => {
    const statements: string[] = [];
    const pool: PostgresPool = {
      async query(sql) {
        statements.push(sql);
        return { rows: [] };
      },
      async connect() {
        throw new Error('transaction client not expected in this case');
      },
    };
    const now = () => 10_000;

    const runtime = createGitHubWebAuthRuntime(env(), { pool, now });
    const authorization = await runtime.flow.beginAuthorization('b'.repeat(43));
    const credentials = await runtime.sessions.create('12345');

    const url = new URL(authorization.authorizationUrl);
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://office-bots.example/api/auth/github/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(credentials.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentials.expiresAt).toBe(now() + OFFICE_SESSION_TTL_MS);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('office_bots_private.oauth_states');
    expect(statements[1]).toContain('office_bots_private.sessions');
  });

  it('rejects a callback URL outside the configured Office origin', () => {
    const invalid = env();
    invalid.GITHUB_OAUTH_CALLBACK_URL = 'https://attacker.example/api/auth/github/callback';

    expect(() => createGitHubWebAuthRuntime(invalid, { pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error(); } } }))
      .toThrow(GitHubWebAuthConfigurationError);
  });

  it('requires TLS and rejects malformed database URLs without exposing them', () => {
    for (const url of [
      'https://db.example.invalid',
      'postgres://runtime:secret@db.example.invalid/postgres?sslmode=disable',
      'postgres://runtime:secret@db.example.invalid/postgres',
    ]) {
      try {
        officeBotsPostgresPool(url);
        throw new Error('expected invalid URL to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(OfficeBotsPostgresConfigurationError);
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
});
