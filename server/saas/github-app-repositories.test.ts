import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppRepositoriesAuthorizationFlow,
  GitHubAppRepositoriesAuthError,
  type GitHubAppAuthorizationStateStore,
  type GitHubAppRepositoriesAdapter,
} from './github-app-repositories';

const USER_ID = '12345';
const OTHER_USER_ID = '67890';
const BINDING = 'b'.repeat(43);
const OTHER_BINDING = 'c'.repeat(43);
const TOKEN = 'ghu_synthetic_ephemeral_token';
const REPOSITORY = {
  repositoryId: '9001',
  installationId: '7001',
  fullName: 'octo/example',
  isPrivate: true,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octo/example',
};

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function memoryStateStore(): GitHubAppAuthorizationStateStore & {
  readonly rows: Map<string, { githubUserId: string; bindingDigest: string; codeVerifier: string; expiresAt: number }>;
} {
  const rows = new Map<string, { githubUserId: string; bindingDigest: string; codeVerifier: string; expiresAt: number }>();
  return {
    rows,
    async issue(state, githubUserId, bindingDigest, codeVerifier, expiresAt) {
      rows.set(state, { githubUserId, bindingDigest, codeVerifier, expiresAt });
    },
    async consume(state, bindingDigest, now) {
      const row = rows.get(state);
      if (!row || row.bindingDigest !== bindingDigest || row.expiresAt <= now) return undefined;
      rows.delete(state);
      return { githubUserId: row.githubUserId, codeVerifier: row.codeVerifier };
    },
  };
}

function setup(identity: unknown = { id: USER_ID }, repositories: unknown = {
  installationCount: 1,
  repositories: [REPOSITORY],
}) {
  const stateStore = memoryStateStore();
  const adapter: GitHubAppRepositoriesAdapter = {
    exchangeCode: vi.fn(async () => TOKEN),
    getIdentity: vi.fn(async () => identity),
    listRepositories: vi.fn(async () => repositories),
  };
  const now = vi.fn(() => 10_000);
  return {
    flow: createGitHubAppRepositoriesAuthorizationFlow({
      config: {
        clientId: 'github-app-client-id',
        callbackUrl: 'https://office-bots.example/api/github/app/callback',
      },
      stateStore,
      adapter,
      now,
    }),
    stateStore,
    adapter,
    now,
  };
}

describe('GitHub App repository authorization flow', () => {
  it('binds a one-time PKCE authorization to the Office user and browser', async () => {
    const { flow, stateStore } = setup();

    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const url = new URL(start.authorizationUrl);
    const state = url.searchParams.get('state')!;
    const stored = stateStore.rows.get(state)!;

    expect(start.expiresAt).toBe(310_000);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('github-app-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://office-bots.example/api/github/app/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has('code_verifier')).toBe(false);
    expect(stored).toMatchObject({ githubUserId: USER_ID, bindingDigest: digest(BINDING), expiresAt: 310_000 });
    expect(stored.codeVerifier).not.toBe(state);
    expect(stored.codeVerifier).not.toBe(BINDING);
  });

  it('uses the short-lived token to verify the same GitHub identity and returns only repository metadata', async () => {
    const { flow, adapter, stateStore } = setup();
    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    const result = await flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: BINDING,
      expectedGithubUserId: USER_ID,
    });

    expect(adapter.exchangeCode).toHaveBeenCalledOnce();
    expect(adapter.getIdentity).toHaveBeenCalledWith(TOKEN);
    expect(adapter.listRepositories).toHaveBeenCalledWith(TOKEN);
    expect(result).toEqual({ githubUserId: USER_ID, installationCount: 1, repositories: [REPOSITORY] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(stateStore.rows.has(state)).toBe(false);
  });

  it('rejects a callback after the Office session changes and consumes its state', async () => {
    const { flow, adapter } = setup();
    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    await expect(flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: BINDING,
      expectedGithubUserId: OTHER_USER_ID,
    })).rejects.toMatchObject({ code: 'invalid_state' });

    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('rejects a GitHub identity that does not match the Office user before listing repositories', async () => {
    const { flow, adapter } = setup({ id: OTHER_USER_ID });
    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    await expect(flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: BINDING,
      expectedGithubUserId: USER_ID,
    })).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(adapter.listRepositories).not.toHaveBeenCalled();
  });

  it('leaves the authorization usable after a callback with the wrong browser binding', async () => {
    const { flow, adapter } = setup();
    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    await expect(flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: OTHER_BINDING,
      expectedGithubUserId: USER_ID,
    })).rejects.toBeInstanceOf(GitHubAppRepositoriesAuthError);
    expect(adapter.exchangeCode).not.toHaveBeenCalled();

    await expect(flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: BINDING,
      expectedGithubUserId: USER_ID,
    })).resolves.toMatchObject({ githubUserId: USER_ID });
  });

  it('rejects malformed repository metadata and does not return an access token', async () => {
    const { flow } = setup({ id: USER_ID }, {
      installationCount: 1,
      repositories: [{ ...REPOSITORY, htmlUrl: 'javascript:alert(1)' }],
    });
    const start = await flow.beginAuthorization(USER_ID, BINDING);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;

    await expect(flow.completeAuthorization({
      code: 'synthetic-code',
      state,
      browserBinding: BINDING,
      expectedGithubUserId: USER_ID,
    })).rejects.toMatchObject({ code: 'adapter_failure' });
  });
});
