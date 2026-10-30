import type { GitHubRepositorySummary } from './github-app-repositories';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGE_COUNT = 100;
const MAX_INSTALLATIONS = 100;
const MAX_REPOSITORIES = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const SAFE_ERROR_MESSAGE = 'GitHub repository listing failed';

/** Does not contain an upstream response, URL, token, or network error. */
export class GitHubAppRepositoriesAdapterError extends Error {
  constructor() {
    super(SAFE_ERROR_MESSAGE);
    this.name = 'GitHubAppRepositoriesAdapterError';
  }
}

export interface GitHubAppRepositoriesAdapterOptions {
  readonly appSlug: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Installation {
  readonly id: string;
}

function fail(): never {
  throw new GitHubAppRepositoriesAdapterError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  return undefined;
}

function contentTypeIsJson(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'));
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    fail();
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
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
      // The stream may already have been aborted; no stream details cross this boundary.
    }
  }
  if (totalBytes === 0) fail();
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function makeUrl(path: string, page: number): string {
  const url = new URL(path, GITHUB_API_ORIGIN);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));
  return url.href;
}

function collection(value: unknown, key: string): { readonly totalCount: number; readonly items: readonly unknown[] } {
  if (!isRecord(value)) return fail();
  const totalCount = value.total_count;
  const items = value[key];
  if (
    typeof totalCount !== 'number' ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    !Array.isArray(items) ||
    items.length > PER_PAGE
  ) {
    return fail();
  }
  return { totalCount, items };
}

function pages(totalCount: number): number {
  const count = Math.ceil(totalCount / PER_PAGE);
  if (count > MAX_PAGE_COUNT) return fail();
  return count;
}

function parseInstallation(value: unknown): { readonly installation?: Installation; readonly appSlug?: string } {
  if (!isRecord(value)) return fail();
  const appSlug = value.app_slug;
  const installationId = id(value.id);
  if (typeof appSlug !== 'string' || !installationId) return fail();
  return { installation: { id: installationId }, appSlug };
}

function parseRepository(value: unknown, installationId: string): GitHubRepositorySummary {
  if (!isRecord(value)) return fail();
  const repositoryId = id(value.id);
  const fullName = value.full_name;
  const isPrivate = value.private;
  const defaultBranch = value.default_branch;
  if (
    !repositoryId ||
    typeof fullName !== 'string' ||
    !FULL_NAME_PATTERN.test(fullName) ||
    typeof isPrivate !== 'boolean' ||
    (defaultBranch !== null &&
      (typeof defaultBranch !== 'string' || defaultBranch.length > 255 || /[\x00-\x1f\x7f]/.test(defaultBranch)))
  ) {
    return fail();
  }
  return Object.freeze({
    repositoryId,
    installationId,
    fullName,
    isPrivate,
    defaultBranch,
    htmlUrl: `https://github.com/${fullName}`,
  });
}

/**
 * Lists repositories accessible through this user's authorized installations of the configured
 * GitHub App. It never accepts an installation ID supplied by a client or callback parameter.
 */
export function createGitHubAppRepositoriesAdapter(options: GitHubAppRepositoriesAdapterOptions): {
  listRepositories(accessToken: string): Promise<{
    readonly installationCount: number;
    readonly repositories: readonly GitHubRepositorySummary[];
  }>;
} {
  try {
    if (!isRecord(options)) fail();
    const appSlug = options.appSlug;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof appSlug !== 'string' ||
      !APP_SLUG_PATTERN.test(appSlug) ||
      typeof fetchImplementation !== 'function' ||
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      fail();
    }

    async function requestJson(url: string, accessToken: string): Promise<unknown> {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new GitHubAppRepositoriesAdapterError());
        }, timeoutMs);
      });
      try {
        const operation = (async (): Promise<unknown> => {
          const response = await fetchImplementation(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${accessToken}`,
              'x-github-api-version': '2022-11-28',
            },
          });
          if (response.status !== 200 || response.redirected || !contentTypeIsJson(response.headers.get('content-type'))) {
            return fail();
          }
          const bytes = await readBoundedBody(response);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return JSON.parse(text) as unknown;
        })();
        return await Promise.race([operation, timeoutFailure]);
      } catch {
        return fail();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }

    return Object.freeze({
      async listRepositories(accessToken: string) {
        if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken)) return fail();
        const installationsById = new Map<string, Installation>();
        const initialInstallations = collection(
          await requestJson(makeUrl('/user/installations', 1), accessToken),
          'installations',
        );
        if (initialInstallations.totalCount > MAX_INSTALLATIONS * 100) return fail();
        const installationPages = pages(initialInstallations.totalCount);
        for (let page = 1; page <= installationPages; page += 1) {
          const current = page === 1
            ? initialInstallations
            : collection(await requestJson(makeUrl('/user/installations', page), accessToken), 'installations');
          if (current.totalCount !== initialInstallations.totalCount) return fail();
          const expectedOnPage = Math.min(PER_PAGE, initialInstallations.totalCount - (page - 1) * PER_PAGE);
          if (current.items.length !== expectedOnPage) return fail();
          for (const rawInstallation of current.items) {
            const parsed = parseInstallation(rawInstallation);
            if (parsed.appSlug !== appSlug || !parsed.installation) continue;
            if (installationsById.has(parsed.installation.id)) return fail();
            installationsById.set(parsed.installation.id, parsed.installation);
            if (installationsById.size > MAX_INSTALLATIONS) return fail();
          }
        }

        const repositories: GitHubRepositorySummary[] = [];
        const seenRepositoryIds = new Set<string>();
        for (const installation of installationsById.values()) {
          const path = `/user/installations/${installation.id}/repositories`;
          const firstPage = collection(await requestJson(makeUrl(path, 1), accessToken), 'repositories');
          const installationRepositoryPages = pages(firstPage.totalCount);
          if (firstPage.totalCount > MAX_REPOSITORIES - repositories.length) return fail();
          for (let page = 1; page <= installationRepositoryPages; page += 1) {
            const current = page === 1
              ? firstPage
              : collection(await requestJson(makeUrl(path, page), accessToken), 'repositories');
            if (current.totalCount !== firstPage.totalCount) return fail();
            const expectedOnPage = Math.min(PER_PAGE, firstPage.totalCount - (page - 1) * PER_PAGE);
            if (current.items.length !== expectedOnPage) return fail();
            for (const rawRepository of current.items) {
              const repository = parseRepository(rawRepository, installation.id);
              if (seenRepositoryIds.has(repository.repositoryId)) return fail();
              seenRepositoryIds.add(repository.repositoryId);
              repositories.push(repository);
            }
          }
        }
        repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
        return Object.freeze({ installationCount: installationsById.size, repositories: Object.freeze(repositories) });
      },
    });
  } catch {
    throw new GitHubAppRepositoriesAdapterError();
  }
}
