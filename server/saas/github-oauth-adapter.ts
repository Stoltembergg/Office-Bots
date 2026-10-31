import type { GitHubAppOAuthAdapter } from './github-auth.js';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const SAFE_ERROR_MESSAGE = 'GitHub OAuth request failed';

/** Deliberately contains no request, response, credential, or upstream error details. */
export class GitHubAppOAuthAdapterError extends Error {
  constructor() {
    super(SAFE_ERROR_MESSAGE);
    this.name = 'GitHubAppOAuthAdapterError';
  }
}

export interface GitHubAppOAuthAdapterOptions {
  /** Server-side GitHub OAuth App secret. It is never returned or logged. */
  readonly clientSecret: string;
  /** Injectable transport for tests; production defaults to the Node global fetch. */
  readonly fetch?: typeof fetch;
  /** Overall time limit for each request, including reading its response. */
  readonly timeoutMs?: number;
}

function fail(): never {
  throw new GitHubAppOAuthAdapterError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('?') || value.includes('#')) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch {
    return false;
  }
}

function contentTypeIsJson(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'));
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_RESPONSE_BYTES) {
      fail();
    }
  }

  const body = response.body;
  if (!body) fail();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_RESPONSE_BYTES - totalBytes) {
        void reader.cancel().catch(() => undefined);
        fail();
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out or cancelled stream is already unusable; never expose stream errors.
    }
  }

  if (totalBytes === 0) fail();
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new GitHubAppOAuthAdapterError());
    }, timeoutMs);
  });

  try {
    const operation = (async (): Promise<unknown> => {
      const response = await fetchImplementation(url, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected || !contentTypeIsJson(response.headers.get('content-type'))) fail();
      const bytes = await readBoundedBody(response);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return JSON.parse(text) as unknown;
    })();
    return await Promise.race([operation, timeoutFailure]);
  } catch {
    // Fetch, abort, decoding, and upstream errors may contain credentials or response data.
    throw new GitHubAppOAuthAdapterError();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function readAccessToken(value: unknown): string {
  if (!isRecord(value)) return fail();
  const token = value.access_token;
  const tokenType = value.token_type;
  if (
    typeof token !== 'string' ||
    !ACCESS_TOKEN_PATTERN.test(token) ||
    typeof tokenType !== 'string' ||
    tokenType.toLowerCase() !== 'bearer'
  ) {
    return fail();
  }
  return token;
}

function readGitHubUserId(value: unknown): string | number {
  if (!isRecord(value)) return fail();
  const id = value.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
  if (typeof id === 'string' && GITHUB_USER_ID_PATTERN.test(id)) return id;
  return fail();
}

/**
 * Creates the server-only transport for GitHub App OAuth login. Endpoint URLs are constants; callers
 * provide only the flow's validated client ID and fixed callback URI, never an upstream endpoint.
 */
export function createGitHubAppOAuthAdapter(options: GitHubAppOAuthAdapterOptions): GitHubAppOAuthAdapter {
  try {
    if (!isRecord(options)) fail();
    const clientSecret = options.clientSecret;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof clientSecret !== 'string' ||
      !CLIENT_SECRET_PATTERN.test(clientSecret) ||
      typeof fetchImplementation !== 'function' ||
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      fail();
    }

    const adapter: GitHubAppOAuthAdapter = {
      async exchangeCode(input): Promise<unknown> {
        try {
          if (
            !isRecord(input) ||
            typeof input.code !== 'string' ||
            !CODE_PATTERN.test(input.code) ||
            typeof input.codeVerifier !== 'string' ||
            !PKCE_VERIFIER_PATTERN.test(input.codeVerifier) ||
            typeof input.clientId !== 'string' ||
            !CLIENT_ID_PATTERN.test(input.clientId) ||
            !isValidRedirectUri(input.redirectUri)
          ) {
            return fail();
          }

          const body = new URLSearchParams({
            client_id: input.clientId,
            client_secret: clientSecret,
            code: input.code,
            code_verifier: input.codeVerifier,
            redirect_uri: input.redirectUri,
          });
          const payload = await requestJson(
            fetchImplementation,
            GITHUB_TOKEN_URL,
            {
              method: 'POST',
              headers: {
                accept: 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
              },
              body,
            },
            timeoutMs,
          );
          return readAccessToken(payload);
        } catch {
          return fail();
        }
      },

      async getIdentity(accessToken): Promise<unknown> {
        try {
          if (typeof accessToken !== 'string' || !ACCESS_TOKEN_PATTERN.test(accessToken)) return fail();
          const payload = await requestJson(
            fetchImplementation,
            GITHUB_USER_URL,
            {
              method: 'GET',
              headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${accessToken}`,
                'x-github-api-version': '2022-11-28',
              },
            },
            timeoutMs,
          );
          // Keep identity output minimal: profile fields and the credential are not needed by the flow.
          return Object.freeze({ id: readGitHubUserId(payload) });
        } catch {
          return fail();
        }
      },
    };

    return Object.freeze(adapter);
  } catch {
    throw new GitHubAppOAuthAdapterError();
  }
}
