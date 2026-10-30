import { createPrivateKey, sign } from 'node:crypto';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const APP_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const INSTALLATION_TOKEN_PATTERN = /^ghs_[A-Za-z0-9_]{20,256}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export class GitHubAppPullRequestsAdapterError extends Error {
  constructor() {
    super('GitHub pull requests could not be loaded');
    this.name = 'GitHubAppPullRequestsAdapterError';
  }
}

export interface GitHubAppPullRequestsAdapterOptions {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface GitHubAppPullRequestsRequest {
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly updatedAt: string;
  readonly headSha: string;
  readonly htmlUrl: string;
}

export interface GitHubPullRequestsPage {
  readonly pullRequests: readonly GitHubPullRequestSummary[];
  readonly hasMore: boolean;
}

export interface GitHubPullRequestFilesRequest {
  readonly pullNumber: number;
  readonly page: number;
  readonly perPage: number;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface GitHubAppRepositoryReadSession {
  getRepositoryIdentity(): Promise<{ readonly repositoryId: string; readonly repositoryFullName: string }>;
  getPullRequest(pullNumber: number): Promise<unknown>;
  listPullRequestFiles(input: GitHubPullRequestFilesRequest): Promise<unknown>;
  listOpenPullRequests(): Promise<GitHubPullRequestsPage>;
}

export interface GitHubAppPullRequestsAdapter {
  createRepositoryReadSession(input: GitHubAppPullRequestsRequest): Promise<GitHubAppRepositoryReadSession>;
  listOpenPullRequests(input: GitHubAppPullRequestsRequest): Promise<GitHubPullRequestsPage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function validRepositoryFullName(value: string): boolean {
  if (!REPOSITORY_NAME_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function makeJwt(appId: string, privateKey: ReturnType<typeof createPrivateKey>, now: number): string {
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: appId, iat: issuedAt, exp: issuedAt + 570 })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function responseIsJson(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return typeof contentType === 'string' && /^application\/(?:vnd\.github\+)?json(?:\s*;|$)/i.test(contentType);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_RESPONSE_BYTES - totalBytes) {
        await reader.cancel();
        throw new GitHubAppPullRequestsAdapterError();
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } catch {
    throw new GitHubAppPullRequestsAdapterError();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function normalizedGitHubId(value: unknown): string | undefined {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  return typeof normalized === 'string' && GITHUB_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function readRepositoryIdentity(value: unknown): { readonly repositoryId: string; readonly repositoryFullName: string } | undefined {
  if (!isRecord(value)) return undefined;
  const id = ownDataProperty(value, 'id');
  const fullName = ownDataProperty(value, 'full_name');
  const repositoryId = normalizedGitHubId(id);
  if (!repositoryId || typeof fullName !== 'string' || !validRepositoryFullName(fullName)) return undefined;
  return Object.freeze({ repositoryId, repositoryFullName: fullName });
}

function normalizePullRequest(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const base = ownDataProperty(value, 'base');
  const head = ownDataProperty(value, 'head');
  if (!isRecord(base) || !isRecord(head)) return value;
  const repository = ownDataProperty(base, 'repo');
  const repositoryId = isRecord(repository) ? normalizedGitHubId(ownDataProperty(repository, 'id')) : undefined;
  return Object.freeze({
    repositoryId,
    number: ownDataProperty(value, 'number'),
    base: Object.freeze({ sha: ownDataProperty(base, 'sha') }),
    head: Object.freeze({ sha: ownDataProperty(head, 'sha') }),
  });
}

function normalizeFiles(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((rawFile) => {
    if (!isRecord(rawFile)) return rawFile;
    const filename = ownDataProperty(rawFile, 'filename');
    const patch = ownDataProperty(rawFile, 'patch');
    if (typeof patch !== 'string') return Object.freeze({ filename });
    return Object.freeze({ filename, patch });
  });
}

function parseTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function parsePullRequests(value: unknown, expected: GitHubAppPullRequestsRequest): readonly GitHubPullRequestSummary[] {
  if (!Array.isArray(value) || value.length > 100) throw new GitHubAppPullRequestsAdapterError();
  const seen = new Set<number>();
  const pullRequests: GitHubPullRequestSummary[] = [];
  for (const rawPullRequest of value) {
    if (!isRecord(rawPullRequest)) throw new GitHubAppPullRequestsAdapterError();
    const number = ownDataProperty(rawPullRequest, 'number');
    const title = ownDataProperty(rawPullRequest, 'title');
    const draft = ownDataProperty(rawPullRequest, 'draft');
    const updatedAt = parseTimestamp(ownDataProperty(rawPullRequest, 'updated_at'));
    const htmlUrl = ownDataProperty(rawPullRequest, 'html_url');
    const head = ownDataProperty(rawPullRequest, 'head');
    const base = ownDataProperty(rawPullRequest, 'base');
    if (!isRecord(head) || !isRecord(base)) throw new GitHubAppPullRequestsAdapterError();
    const sha = ownDataProperty(head, 'sha');
    const baseRepository = ownDataProperty(base, 'repo');
    if (!isRecord(baseRepository)) throw new GitHubAppPullRequestsAdapterError();
    const baseId = ownDataProperty(baseRepository, 'id');
    const normalizedBaseId = typeof baseId === 'number' && Number.isSafeInteger(baseId) && baseId > 0
      ? String(baseId)
      : baseId;
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      seen.has(number) ||
      typeof title !== 'string' ||
      title.length === 0 ||
      title.length > 512 ||
      /[\x00-\x1f\x7f]/.test(title) ||
      typeof draft !== 'boolean' ||
      !updatedAt ||
      typeof sha !== 'string' ||
      !COMMIT_SHA_PATTERN.test(sha) ||
      normalizedBaseId !== expected.repositoryId ||
      htmlUrl !== `https://github.com/${expected.repositoryFullName}/pull/${number}`
    ) {
      throw new GitHubAppPullRequestsAdapterError();
    }
    seen.add(number);
    pullRequests.push(Object.freeze({
      number,
      title,
      draft,
      updatedAt,
      headSha: sha.toLowerCase(),
      htmlUrl: htmlUrl as string,
    }));
  }
  return Object.freeze(pullRequests);
}

function hasNextPage(value: string | null): boolean {
  if (!value) return false;
  return value.split(',').some((part) => /;\s*rel\s*=\s*"?next"?/i.test(part));
}

/**
 * Creates short-lived app and repository-scoped installation tokens for read-only PR metadata.
 * The token never leaves this adapter and is never persisted.
 */
export function createGitHubAppPullRequestsAdapter(options: GitHubAppPullRequestsAdapterOptions): GitHubAppPullRequestsAdapter {
  try {
    if (!isRecord(options)) throw new Error();
    const appId = options.appId;
    const privateKeyPem = options.privateKey;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const clock = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof appId !== 'string' ||
      !APP_ID_PATTERN.test(appId) ||
      typeof privateKeyPem !== 'string' ||
      privateKeyPem.length < 100 ||
      privateKeyPem.length > 20_000 ||
      typeof fetchImplementation !== 'function' ||
      typeof clock !== 'function' ||
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error();
    }
    const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error();

    async function requestJson(
      url: string,
      method: 'GET' | 'POST',
      authorization: string,
      expectedStatus: number,
      body?: string,
    ): Promise<{ readonly value: unknown; readonly response: Response }> {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new GitHubAppPullRequestsAdapterError());
        }, timeoutMs);
      });
      try {
        const operation = (async (): Promise<{ readonly value: unknown; readonly response: Response }> => {
          const response = await fetchImplementation(url, {
            method,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${authorization}`,
              'x-github-api-version': GITHUB_API_VERSION,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body } : {}),
          });
          if (response.status !== expectedStatus || response.redirected || !responseIsJson(response)) {
            throw new GitHubAppPullRequestsAdapterError();
          }
          const bytes = await readBoundedBody(response);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          try {
            return { value: JSON.parse(text) as unknown, response };
          } catch {
            throw new GitHubAppPullRequestsAdapterError();
          }
        })();
        return await Promise.race([operation, timeoutFailure]);
      } catch {
        throw new GitHubAppPullRequestsAdapterError();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }

    async function createRepositoryReadSession(
      untrustedInput: GitHubAppPullRequestsRequest,
    ): Promise<GitHubAppRepositoryReadSession> {
        if (!isRecord(untrustedInput)) throw new GitHubAppPullRequestsAdapterError();
        const installationId = ownDataProperty(untrustedInput, 'installationId');
        const repositoryId = ownDataProperty(untrustedInput, 'repositoryId');
        const repositoryFullName = ownDataProperty(untrustedInput, 'repositoryFullName');
        if (
          typeof installationId !== 'string' ||
          !GITHUB_ID_PATTERN.test(installationId) ||
          typeof repositoryId !== 'string' ||
          !GITHUB_ID_PATTERN.test(repositoryId) ||
          typeof repositoryFullName !== 'string' ||
          !validRepositoryFullName(repositoryFullName)
        ) {
          throw new GitHubAppPullRequestsAdapterError();
        }
        const input = Object.freeze({ installationId, repositoryId, repositoryFullName });
        let now: number;
        try {
          now = clock();
        } catch {
          throw new GitHubAppPullRequestsAdapterError();
        }
        if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
          throw new GitHubAppPullRequestsAdapterError();
        }
        const appJwt = makeJwt(appId, privateKey, now);
        const tokenResponse = await requestJson(
          `${GITHUB_API_ORIGIN}/app/installations/${installationId}/access_tokens`,
          'POST',
          appJwt,
          201,
          JSON.stringify({ repositories: [repositoryFullName], permissions: { pull_requests: 'read' } }),
        );
        if (!isRecord(tokenResponse.value)) throw new GitHubAppPullRequestsAdapterError();
        const installationToken = ownDataProperty(tokenResponse.value, 'token');
        const expiresAt = ownDataProperty(tokenResponse.value, 'expires_at');
        const permissions = ownDataProperty(tokenResponse.value, 'permissions');
        if (
          typeof installationToken !== 'string' ||
          !INSTALLATION_TOKEN_PATTERN.test(installationToken) ||
          typeof expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= now ||
          !isRecord(permissions) ||
          ownDataProperty(permissions, 'pull_requests') !== 'read'
        ) {
          throw new GitHubAppPullRequestsAdapterError();
        }
        const accessToken = installationToken as string;

        const [owner, repository] = repositoryFullName.split('/');
        const repositoryPath = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}`;
        const repositoryUrl = `${GITHUB_API_ORIGIN}${repositoryPath}`;

        async function getPullRequest(pullNumber: number): Promise<unknown> {
          if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new GitHubAppPullRequestsAdapterError();
          const response = await requestJson(`${GITHUB_API_ORIGIN}${repositoryPath}/pulls/${pullNumber}`, 'GET', accessToken, 200);
          return normalizePullRequest(response.value);
        }

        async function listPullRequestFiles(untrustedFilesRequest: GitHubPullRequestFilesRequest): Promise<unknown> {
          if (!isRecord(untrustedFilesRequest)) throw new GitHubAppPullRequestsAdapterError();
          const pullNumber = ownDataProperty(untrustedFilesRequest, 'pullNumber');
          const page = ownDataProperty(untrustedFilesRequest, 'page');
          const perPage = ownDataProperty(untrustedFilesRequest, 'perPage');
          const baseSha = ownDataProperty(untrustedFilesRequest, 'baseSha');
          const headSha = ownDataProperty(untrustedFilesRequest, 'headSha');
          if (
            typeof pullNumber !== 'number' || !Number.isSafeInteger(pullNumber) || pullNumber < 1 ||
            typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 10 ||
            typeof perPage !== 'number' || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 ||
            typeof baseSha !== 'string' || !COMMIT_SHA_PATTERN.test(baseSha) ||
            typeof headSha !== 'string' || !COMMIT_SHA_PATTERN.test(headSha)
          ) {
            throw new GitHubAppPullRequestsAdapterError();
          }
          const url = new URL(`${GITHUB_API_ORIGIN}${repositoryPath}/pulls/${pullNumber}/files`);
          url.searchParams.set('per_page', String(perPage));
          url.searchParams.set('page', String(page));
          const response = await requestJson(url.href, 'GET', accessToken, 200);
          return Object.freeze({
            repositoryId,
            pullNumber,
            page,
            baseSha: baseSha.toLowerCase(),
            headSha: headSha.toLowerCase(),
            files: normalizeFiles(response.value),
            hasNextPage: hasNextPage(response.response.headers.get('link')),
          });
        }

        return Object.freeze({
          async getRepositoryIdentity() {
            const response = await requestJson(repositoryUrl, 'GET', accessToken, 200);
            const identity = readRepositoryIdentity(response.value);
            if (!identity) throw new GitHubAppPullRequestsAdapterError();
            return identity;
          },
          getPullRequest,
          listPullRequestFiles,
          async listOpenPullRequests(): Promise<GitHubPullRequestsPage> {
            const url = new URL(`${GITHUB_API_ORIGIN}${repositoryPath}/pulls`);
            url.searchParams.set('state', 'open');
            url.searchParams.set('sort', 'updated');
            url.searchParams.set('direction', 'desc');
            url.searchParams.set('per_page', '100');
            url.searchParams.set('page', '1');
            const response = await requestJson(url.href, 'GET', accessToken, 200);
            return Object.freeze({
              pullRequests: parsePullRequests(response.value, input),
              hasMore: hasNextPage(response.response.headers.get('link')),
            });
          },
        });
    }

    return Object.freeze({
      createRepositoryReadSession,
      async listOpenPullRequests(untrustedInput: GitHubAppPullRequestsRequest): Promise<GitHubPullRequestsPage> {
        if (!isRecord(untrustedInput)) throw new GitHubAppPullRequestsAdapterError();
        const installationId = ownDataProperty(untrustedInput, 'installationId');
        const repositoryId = ownDataProperty(untrustedInput, 'repositoryId');
        const repositoryFullName = ownDataProperty(untrustedInput, 'repositoryFullName');
        if (
          typeof installationId !== 'string' || !GITHUB_ID_PATTERN.test(installationId) ||
          typeof repositoryId !== 'string' || !GITHUB_ID_PATTERN.test(repositoryId) ||
          typeof repositoryFullName !== 'string' || !validRepositoryFullName(repositoryFullName)
        ) throw new GitHubAppPullRequestsAdapterError();
        const expected = Object.freeze({ installationId, repositoryId, repositoryFullName });
        const session = await createRepositoryReadSession(expected);
        const [identity, pullRequests] = await Promise.all([
          session.getRepositoryIdentity(),
          session.listOpenPullRequests(),
        ]);
        if (
          identity.repositoryId !== expected.repositoryId ||
          identity.repositoryFullName !== expected.repositoryFullName
        ) {
          throw new GitHubAppPullRequestsAdapterError();
        }
        return pullRequests;
      },
    });
  } catch {
    throw new GitHubAppPullRequestsAdapterError();
  }
}
