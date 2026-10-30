import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGitHubAppPullRequestsRuntime,
  GitHubAppPullRequestsConfigurationError,
} from './github-app-pull-requests-runtime';
import type { PostgresPool } from './postgres-stores';

function env(privateKey: string): NodeJS.ProcessEnv {
  return {
    OFFICE_BOT_APP_ORIGIN: 'https://office-bots.example',
    GITHUB_APP_SLUG: 'office-bots',
    GITHUB_APP_CLIENT_ID: 'github-app-client-id',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-github-app-secret',
    GITHUB_APP_CALLBACK_URL: 'https://office-bots.example/api/github/app/callback',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
}

function privateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const emptyPool: PostgresPool = {
  async query() { return { rows: [] }; },
  async connect() { throw new Error('not expected'); },
};

describe('GitHub App pull request runtime', () => {
  it('wires the live Office session, user-scoped repository store, and read-only GitHub adapter', async () => {
    const runtime = createGitHubAppPullRequestsRuntime(env(privateKey()), { pool: emptyPool, now: () => 10_000 });

    expect(runtime.appSlug).toBe('office-bots');
    await expect(runtime.loader.load('s'.repeat(43))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(runtime.reviewInputLoader.load({ sessionCredential: 's'.repeat(43), pullNumber: 17 }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('requires a numeric App ID and valid server-only private key without echoing secrets', () => {
    const key = privateKey();
    const invalidId = env(key);
    invalidId.GITHUB_APP_ID = '123/attacker';
    expect(() => createGitHubAppPullRequestsRuntime(invalidId, { pool: emptyPool }))
      .toThrow(GitHubAppPullRequestsConfigurationError);

    const invalidKey = env('synthetic private secret');
    try {
      createGitHubAppPullRequestsRuntime(invalidKey, { pool: emptyPool });
      throw new Error('expected configuration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubAppPullRequestsConfigurationError);
      expect((error as Error).message).not.toContain('synthetic private secret');
    }
  });

  it('does not require the App private key for the existing repository-list runtime', async () => {
    const { createGitHubAppRepositoriesRuntime } = await import('./github-app-repositories-runtime');
    const existingEnv = env(privateKey());
    delete existingEnv.GITHUB_APP_PRIVATE_KEY;
    delete existingEnv.GITHUB_APP_ID;
    expect(() => createGitHubAppRepositoriesRuntime(existingEnv, { pool: emptyPool })).not.toThrow();
  });
});
