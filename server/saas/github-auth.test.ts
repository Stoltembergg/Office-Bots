import { createHash, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppAuthorizationFlow,
  GitHubAppAuthError,
  type GitHubAppAuthStateStore,
  type GitHubAppOAuthAdapter,
} from './github-auth';

const CLIENT_ID = 'Iv1.synthetic-client-id';
const CALLBACK_URL = 'https://office.example.test/auth/github/callback';
const BROWSER_BINDING = 'B'.repeat(43);
const TEST_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TEST_BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TEST_PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const TEST_MAX_STATE_TTL_MS = 10 * 60_000;

/** Bounded, expiring process-local state storage used exclusively by these tests. */
function createInMemoryGitHubAppAuthStateStore(maxEntries = 1_024): GitHubAppAuthStateStore {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw new TypeError('Invalid test state-store capacity');
  }
  const states = new Map<string, { readonly bindingDigest: string; readonly codeVerifier: string; readonly expiresAt: number }>();
  const pruneExpired = (now: number): void => {
    for (const [state, entry] of states) {
      if (entry.expiresAt <= now) states.delete(state);
    }
  };

  return {
    async issue(state, bindingDigest, codeVerifier, expiresAt, now): Promise<void> {
      if (
        !TEST_STATE_PATTERN.test(state) ||
        !TEST_BINDING_DIGEST_PATTERN.test(bindingDigest) ||
        !TEST_PKCE_VERIFIER_PATTERN.test(codeVerifier) ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt < 0 ||
        expiresAt <= now ||
        expiresAt - now > TEST_MAX_STATE_TTL_MS
      ) {
        throw new TypeError('Invalid test state-store entry');
      }
      pruneExpired(now);
      if (states.has(state) || states.size >= maxEntries) throw new Error('Test state store is full');
      states.set(state, { bindingDigest, codeVerifier, expiresAt });
    },

    async consume(state, bindingDigest, now): Promise<string | undefined> {
      if (
        !TEST_STATE_PATTERN.test(state) ||
        !TEST_BINDING_DIGEST_PATTERN.test(bindingDigest) ||
        !Number.isSafeInteger(now) ||
        now < 0
      ) {
        return undefined;
      }
      pruneExpired(now);
      const entry = states.get(state);
      if (entry === undefined) return undefined;
      const matches = timingSafeEqual(Buffer.from(entry.bindingDigest, 'hex'), Buffer.from(bindingDigest, 'hex'));
      if (!matches) return undefined;
      states.delete(state);
      return entry.codeVerifier;
    },
  };
}

function createFlow(options: {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly stateStore?: GitHubAppAuthStateStore;
  readonly adapter?: GitHubAppOAuthAdapter;
} = {}) {
  const adapter = options.adapter ?? {
    exchangeCode: vi.fn(async () => 'synthetic-access-token'),
    getIdentity: vi.fn(async () => ({ id: 42 })),
  };
  const flow = createGitHubAppAuthorizationFlow({
    config: { clientId: CLIENT_ID, callbackUrl: CALLBACK_URL, stateTtlMs: options.ttlMs },
    stateStore: options.stateStore ?? createInMemoryGitHubAppAuthStateStore(),
    adapter,
    now: options.now,
  });
  return { flow, adapter };
}

async function startState(flow: ReturnType<typeof createFlow>['flow']): Promise<string> {
  const started = await flow.beginAuthorization(BROWSER_BINDING);
  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.has('code_verifier')).toBe(false);
  expect(url.searchParams.has('browserBinding')).toBe(false);
  expect(started.expiresAt).toBeGreaterThan(0);
  return url.searchParams.get('state') ?? '';
}

describe('fundação isolada de autorização GitHub App', () => {
  it('inicia com callback fixo e conclui retornando apenas o ID estável', async () => {
    const adapter: GitHubAppOAuthAdapter = {
      exchangeCode: vi.fn(async () => 'synthetic-access-token'),
      getIdentity: vi.fn(async () => ({ id: 123_456, login: 'synthetic-user' })),
    };
    const { flow } = createFlow({ adapter });
    const started = await flow.beginAuthorization(BROWSER_BINDING);
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get('state');

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
    const identity = await flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING });
    expect(identity).toEqual({ githubUserId: '123456' });
    const exchangeInput = vi.mocked(adapter.exchangeCode).mock.calls[0]![0];
    expect(exchangeInput.codeVerifier).toMatch(TEST_PKCE_VERIFIER_PATTERN);
    expect(exchangeInput.codeVerifier).not.toBe(state);
    expect(exchangeInput.codeVerifier).not.toBe(BROWSER_BINDING);
    expect(
      createHash('sha256').update(exchangeInput.codeVerifier, 'ascii').digest('base64url'),
    ).toBe(url.searchParams.get('code_challenge'));
    expect(adapter.exchangeCode).toHaveBeenCalledWith({
      code: 'synthetic-code',
      codeVerifier: exchangeInput.codeVerifier,
      clientId: CLIENT_ID,
      redirectUri: CALLBACK_URL,
    });
    expect(adapter.getIdentity).toHaveBeenCalledWith('synthetic-access-token');
    expect(JSON.stringify(identity)).not.toContain('synthetic-access-token');
  });

  it('recusa state ausente ou inválido sem chamar adaptadores', async () => {
    const { flow, adapter } = createFlow();
    await expect(flow.completeAuthorization({ code: 'synthetic-code', browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state: 'invalid-state', browserBinding: BROWSER_BINDING }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('exige binding no início e no callback', async () => {
    const { flow, adapter } = createFlow();
    await expect(flow.beginAuthorization('')).rejects.toMatchObject({ code: 'invalid_request' });
    const state = await startState(flow);
    await expect(flow.completeAuthorization({ code: 'synthetic-code', state })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: 'not-a-random-binding' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('não autoriza com binding de outro navegador e preserva a tentativa legítima', async () => {
    const { flow, adapter } = createFlow();
    const state = await startState(flow);

    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: 'C'.repeat(43) }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING }),
    ).resolves.toEqual({ githubUserId: '42' });
    expect(adapter.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('recusa state expirado', async () => {
    let now = 10_000;
    const { flow, adapter } = createFlow({ now: () => now, ttlMs: 1_000 });
    const state = await startState(flow);
    now += 1_000;

    await expect(flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('limita o armazenamento de teste e libera entradas expiradas', async () => {
    let now = 10_000;
    const stateStore = createInMemoryGitHubAppAuthStateStore(1);
    const { flow } = createFlow({ now: () => now, ttlMs: 1_000, stateStore });

    await startState(flow);
    await expect(flow.beginAuthorization(BROWSER_BINDING)).rejects.toMatchObject({ code: 'state_store_failure' });
    now += 1_000;
    await expect(flow.beginAuthorization(BROWSER_BINDING)).resolves.toMatchObject({ expiresAt: 12_000 });
  });

  it('consome state uma única vez e recusa reutilização', async () => {
    const { flow, adapter } = createFlow();
    const state = await startState(flow);
    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING }),
    ).resolves.toEqual({ githubUserId: '42' });
    await expect(
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING }),
    ).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(adapter.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('permite somente um consumo concorrente de state', async () => {
    const { flow, adapter } = createFlow();
    const state = await startState(flow);
    const attempts = await Promise.allSettled([
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING }),
      flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING }),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(adapter.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('consome state antes de validar ou trocar código', async () => {
    const { flow, adapter } = createFlow();
    const state = await startState(flow);

    await expect(flow.completeAuthorization({ code: 'bad code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('falha fechado se o store devolver verifier inválido, sem passá-lo ao adaptador', async () => {
    const backingStore = createInMemoryGitHubAppAuthStateStore();
    const stateStore: GitHubAppAuthStateStore = {
      issue: backingStore.issue.bind(backingStore),
      async consume(state, bindingDigest, now): Promise<string | undefined> {
        await backingStore.consume(state, bindingDigest, now);
        return 'invalid verifier from store';
      },
    };
    const { flow, adapter } = createFlow({ stateStore });
    const state = await startState(flow);
    const failure = await flow
      .completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubAppAuthError);
    expect(failure).toMatchObject({ code: 'state_store_failure' });
    expect((failure as Error).message).not.toContain('invalid verifier from store');
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it('falha sem expor erro do adaptador e não recupera state após falha de troca', async () => {
    const adapter: GitHubAppOAuthAdapter = {
      exchangeCode: vi.fn(async ({ codeVerifier }: { readonly codeVerifier: string }) => {
        throw new Error(`private synthetic PKCE verifier: ${codeVerifier}`);
      }),
      getIdentity: vi.fn(async () => ({ id: 42 })),
    };
    const { flow } = createFlow({ adapter });
    const state = await startState(flow);

    const failure = await flow
      .completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubAppAuthError);
    expect(failure).toMatchObject({ code: 'adapter_failure' });
    expect((failure as Error).message).not.toContain('private synthetic PKCE verifier');
    const verifier = vi.mocked(adapter.exchangeCode).mock.calls[0]![0].codeVerifier;
    expect((failure as Error).message).not.toContain(verifier);
    await expect(flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(adapter.exchangeCode).toHaveBeenCalledTimes(1);
    expect(adapter.getIdentity).not.toHaveBeenCalled();
  });

  it('trata falha de consulta de identidade sem devolver token', async () => {
    const adapter: GitHubAppOAuthAdapter = {
      exchangeCode: vi.fn(async () => 'synthetic-access-token'),
      getIdentity: vi.fn(async () => {
        throw new Error('private identity response');
      }),
    };
    const { flow } = createFlow({ adapter });
    const state = await startState(flow);

    await expect(flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'adapter_failure',
    });
  });

  it('recusa identidade sem ID GitHub positivo e estável', async () => {
    const adapter: GitHubAppOAuthAdapter = {
      exchangeCode: vi.fn(async () => 'synthetic-access-token'),
      getIdentity: vi.fn(async () => ({ id: '00042' })),
    };
    const { flow } = createFlow({ adapter });
    const state = await startState(flow);

    await expect(flow.completeAuthorization({ code: 'synthetic-code', state, browserBinding: BROWSER_BINDING })).rejects.toMatchObject({
      code: 'invalid_identity',
    });
  });

  it('recusa callback configurado fora de HTTPS fixo', () => {
    expect(() =>
      createGitHubAppAuthorizationFlow({
        config: { clientId: CLIENT_ID, callbackUrl: 'http://office.example.test/callback' },
        stateStore: createInMemoryGitHubAppAuthStateStore(),
        adapter: { exchangeCode: async () => 'token', getIdentity: async () => ({ id: 1 }) },
      }),
    ).toThrowError(GitHubAppAuthError);
  });
});
