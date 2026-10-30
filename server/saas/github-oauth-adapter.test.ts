import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppOAuthAdapter,
  GitHubAppOAuthAdapterError,
} from './github-oauth-adapter';

const CLIENT_ID = 'Iv1.synthetic-client-id';
const CLIENT_SECRET = 'synthetic-private-client-secret';
const REDIRECT_URI = 'https://office.example.test/auth/github/callback';
const SYNTHETIC_CODE = 'synthetic-oauth-code';
const SYNTHETIC_CODE_VERIFIER = 'V'.repeat(43);
const SYNTHETIC_TOKEN = 'synthetic-access-token';

type MockedFetch = typeof fetch & {
  readonly mock: {
    readonly calls: readonly (readonly [RequestInfo | URL, RequestInit?])[];
  };
};

function jsonResponse(value: unknown, options: { readonly status?: number; readonly contentType?: string } = {}): Response {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'application/json; charset=utf-8' },
  });
}

function mockFetch(...responses: Response[]): MockedFetch {
  let nextResponse = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const response = responses[nextResponse++];
    if (!response) throw new Error('Unexpected synthetic request');
    return response;
  }) as MockedFetch;
}

function createAdapter(fetchImplementation: typeof fetch, options: { readonly timeoutMs?: number } = {}) {
  return createGitHubAppOAuthAdapter({ clientSecret: CLIENT_SECRET, fetch: fetchImplementation, ...options });
}

describe('adaptador OAuth real do GitHub', () => {
  it('troca o código em endpoint fixo e consulta identidade com Bearer, retornando somente o ID', async () => {
    const fetchImplementation = mockFetch(
      jsonResponse({ access_token: SYNTHETIC_TOKEN, token_type: 'bearer', scope: 'read:user' }),
      jsonResponse({ id: 123_456, login: 'synthetic-user', email: 'private@example.test' }),
    );
    const adapter = createAdapter(fetchImplementation);

    await expect(
      adapter.exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).resolves.toBe(SYNTHETIC_TOKEN);
    const identity = await adapter.getIdentity(SYNTHETIC_TOKEN);
    expect(identity).toEqual({ id: 123_456 });

    const [tokenUrl, tokenInit] = fetchImplementation.mock.calls[0]!;
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(tokenInit?.method).toBe('POST');
    expect(tokenInit?.redirect).toBe('error');
    expect(tokenInit?.credentials).toBe('omit');
    expect(tokenInit?.cache).toBe('no-store');
    expect(tokenInit?.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    });
    const form = new URLSearchParams(String(tokenInit?.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: SYNTHETIC_CODE,
      code_verifier: SYNTHETIC_CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
    });

    const [identityUrl, identityInit] = fetchImplementation.mock.calls[1]!;
    expect(identityUrl).toBe('https://api.github.com/user');
    expect(identityInit?.method).toBe('GET');
    expect(identityInit?.redirect).toBe('error');
    expect(identityInit?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${SYNTHETIC_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    });
    expect(JSON.stringify(identity)).not.toContain(SYNTHETIC_TOKEN);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('recusa dados de entrada inválidos sem fazer chamadas', async () => {
    const fetchImplementation = mockFetch();
    const adapter = createAdapter(fetchImplementation);

    await expect(
      adapter.exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: 'http://office.example.test/callback',
      }),
    ).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
    await expect(
      adapter.exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: 'invalid verifier',
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
    await expect(adapter.getIdentity('token with spaces')).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('falha com erro sanitizado em status inválido e tipo de conteúdo inesperado', async () => {
    const statusFetch = mockFetch(
      jsonResponse({ error: 'invalid_client', error_description: CLIENT_SECRET }, { status: 401 }),
    );
    const statusError = await createAdapter(statusFetch)
      .exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      })
      .catch((error: unknown) => error);
    expect(statusError).toBeInstanceOf(GitHubAppOAuthAdapterError);
    expect((statusError as Error).message).not.toContain(CLIENT_SECRET);

    const contentTypeFetch = mockFetch(jsonResponse({ access_token: SYNTHETIC_TOKEN, token_type: 'bearer' }, { contentType: 'text/plain' }));
    await expect(
      createAdapter(contentTypeFetch).exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toMatchObject({ message: 'GitHub OAuth request failed' });
  });

  it('recusa redirects e exige configuração de redirect:error em todas as chamadas', async () => {
    const redirectFetch = mockFetch(jsonResponse({ access_token: SYNTHETIC_TOKEN, token_type: 'bearer' }, { status: 302 }));
    const adapter = createAdapter(redirectFetch);

    await expect(
      adapter.exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
    expect(redirectFetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('valida o schema da resposta do token e não devolve respostas OAuth de erro', async () => {
    for (const payload of [
      { access_token: SYNTHETIC_TOKEN },
      { access_token: 'token with spaces', token_type: 'bearer' },
      { error: 'invalid_grant', error_description: SYNTHETIC_CODE },
    ]) {
      const adapter = createAdapter(mockFetch(jsonResponse(payload)));
      const failure = await adapter
        .exchangeCode({
          code: SYNTHETIC_CODE,
          codeVerifier: SYNTHETIC_CODE_VERIFIER,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubAppOAuthAdapterError);
      expect((failure as Error).message).not.toContain(SYNTHETIC_CODE);
    }
  });

  it('valida o tipo e o valor do ID GitHub antes de devolver a identidade', async () => {
    for (const payload of [null, [], { id: 0 }, { id: '00042' }, { id: 'https://attacker.example.test' }]) {
      const adapter = createAdapter(mockFetch(jsonResponse(payload)));
      await expect(adapter.getIdentity(SYNTHETIC_TOKEN)).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
    }

    await expect(createAdapter(mockFetch(jsonResponse({ id: '12345678901234567890' }))).getIdentity(SYNTHETIC_TOKEN)).resolves.toEqual({
      id: '12345678901234567890',
    });
  });

  it('limita o tamanho das respostas sem materializar payloads arbitrários', async () => {
    const oversized = JSON.stringify({ access_token: SYNTHETIC_TOKEN, token_type: 'bearer', extra: 'x'.repeat(20 * 1024) });
    const response = new Response(oversized, { headers: { 'content-type': 'application/json' } });
    const adapter = createAdapter(mockFetch(response));

    await expect(
      adapter.exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toBeInstanceOf(GitHubAppOAuthAdapterError);
  });

  it('aborta requisições que excedem o limite de tempo e não revela erros do transporte', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const adapter = createAdapter(fetchImplementation, { timeoutMs: 15 });
    const failure = await adapter
      .exchangeCode({
        code: SYNTHETIC_CODE,
        codeVerifier: SYNTHETIC_CODE_VERIFIER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubAppOAuthAdapterError);
    expect((failure as Error).message).toBe('GitHub OAuth request failed');
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('recusa configuração incompleta sem incluir o segredo na mensagem', () => {
    expect(() => createGitHubAppOAuthAdapter({ clientSecret: '' })).toThrowError(GitHubAppOAuthAdapterError);
    const failure = (() => {
      try {
        createGitHubAppOAuthAdapter({ clientSecret: CLIENT_SECRET, timeoutMs: 0 });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(GitHubAppOAuthAdapterError);
    expect((failure as Error).message).not.toContain(CLIENT_SECRET);
  });
});
