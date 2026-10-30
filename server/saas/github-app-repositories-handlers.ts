import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SaasSessionManager } from './sessions';
import type { GitHubAppRepositoriesAuthorizationFlow } from './github-app-repositories';
import type { GitHubRepositoriesStore } from './postgres-stores';

const SESSION_COOKIE = '__Host-office_bots_session';
const BINDING_COOKIE = '__Host-office_bots_app_binding';
const BINDING_MAX_AGE = 5 * 60;
const MAX_REQUEST_BYTES = 1_024;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export interface GitHubAppRepositoriesRuntime {
  readonly appOrigin: string;
  readonly appSlug: string;
  readonly flow: GitHubAppRepositoriesAuthorizationFlow;
  readonly sessions: SaasSessionManager;
  readonly repositoriesStore: GitHubRepositoriesStore;
  readonly now: () => number;
}

export interface GitHubAppRepositoriesHandlers {
  authorize(req: IncomingMessage, res: ServerResponse): Promise<void>;
  callback(req: IncomingMessage, res: ServerResponse): Promise<void>;
  install(req: IncomingMessage, res: ServerResponse): Promise<void>;
  repositories(req: IncomingMessage, res: ServerResponse): Promise<void>;
  selectRepository(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) return undefined;
    const url = new URL(req.url, 'https://office-bots.invalid');
    return url.origin === 'https://office-bots.invalid' ? url : undefined;
  } catch {
    return undefined;
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8_192) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearBindingCookie(): string {
  return cookie(BINDING_COOKIE, '', 0);
}

function redirect(res: ServerResponse, location: string, status = 303, cookies: string[] = []): void {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end();
}

function sameOrigin(req: IncomingMessage, expectedOrigin: string): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.setHeader('Allow', allowed);
  respondJson(res, 405, { error: 'Method not allowed' });
}

function contentTypeIsJson(req: IncomingMessage): boolean {
  const header = req.headers['content-type'];
  if (typeof header !== 'string') return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentLength = req.headers['content-length'];
  if (
    contentLength !== undefined &&
    (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    return undefined;
  }
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    if (typeof parsed === 'string') {
      if (Buffer.byteLength(parsed) > MAX_REQUEST_BYTES) return undefined;
      try {
        return JSON.parse(parsed) as unknown;
      } catch {
        return undefined;
      }
    }
    if (parsed instanceof Uint8Array) {
      if (parsed.byteLength > MAX_REQUEST_BYTES) return undefined;
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parsed)) as unknown;
      } catch {
        return undefined;
      }
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      try {
        if (Object.keys(parsed).length !== 1) return undefined;
      } catch {
        return undefined;
      }
    }
    return parsed;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REQUEST_BYTES - totalBytes) return undefined;
      totalBytes += bytes.byteLength;
      chunks.push(bytes);
    }
  } catch {
    return undefined;
  }
  if (totalBytes === 0) return undefined;
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

function repositoryIdFromBody(value: unknown): string | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'repositoryId');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    const repositoryId = descriptor.value;
    if (repositoryId === null) return null;
    return typeof repositoryId === 'string' && /^[1-9][0-9]{0,19}$/.test(repositoryId) ? repositoryId : undefined;
  } catch {
    return undefined;
  }
}

async function officeSession(req: IncomingMessage, runtime: GitHubAppRepositoriesRuntime) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  return runtime.sessions.get(token);
}

function callbackRedirect(runtime: GitHubAppRepositoriesRuntime, result: string): string {
  return `${runtime.appOrigin}/?github=${result}`;
}

export function createGitHubAppRepositoriesHandlers(
  runtime: GitHubAppRepositoriesRuntime,
): GitHubAppRepositoriesHandlers {
  return Object.freeze({
    async authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const session = await officeSession(req, runtime);
      if (!session) return respondJson(res, 401, { error: 'Authentication required' });
      const binding = randomBytes(32).toString('base64url');
      const authorization = await runtime.flow.beginAuthorization(session.githubUserId, binding);
      res.writeHead(302, {
        Location: authorization.authorizationUrl,
        'Set-Cookie': cookie(BINDING_COOKIE, binding, BINDING_MAX_AGE),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end();
    },

    async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const url = requestUrl(req);
      if (!url) return redirect(res, callbackRedirect(runtime, 'failed'), 303, [clearBindingCookie()]);
      if (url.searchParams.has('error')) {
        return redirect(res, callbackRedirect(runtime, 'cancelled'), 303, [clearBindingCookie()]);
      }
      const binding = readCookie(req, BINDING_COOKIE);
      const session = await officeSession(req, runtime);
      if (!binding || !session) {
        const result = session ? 'failed' : 'login-required';
        return redirect(res, callbackRedirect(runtime, result), 303, [clearBindingCookie()]);
      }
      try {
        const authorization = await runtime.flow.completeAuthorization({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          browserBinding: binding,
          expectedGithubUserId: session.githubUserId,
        });
        await runtime.repositoriesStore.replaceForUser(
          authorization.githubUserId,
          authorization.repositories,
          runtime.now(),
        );
        const result = authorization.installationCount > 0 ? 'connected' : 'install-required';
        return redirect(res, callbackRedirect(runtime, result), 303, [clearBindingCookie()]);
      } catch {
        return redirect(res, callbackRedirect(runtime, 'failed'), 303, [clearBindingCookie()]);
      }
    },

    async install(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const session = await officeSession(req, runtime);
      if (!session) return respondJson(res, 401, { error: 'Authentication required' });
      const location = new URL(`/apps/${runtime.appSlug}/installations/new`, 'https://github.com');
      return redirect(res, location.href, 302);
    },

    async repositories(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const session = await officeSession(req, runtime);
      if (!session) return respondJson(res, 401, { error: 'Authentication required' });
      const repositories = await runtime.repositoriesStore.listForUser(session.githubUserId);
      return respondJson(res, 200, {
        repositories: repositories.map((repository) => ({
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          isPrivate: repository.isPrivate,
          defaultBranch: repository.defaultBranch,
          htmlUrl: repository.htmlUrl,
          isSelected: repository.isSelected,
        })),
      });
    },

    async selectRepository(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'PUT') return methodNotAllowed(res, 'PUT');
      if (!sameOrigin(req, runtime.appOrigin)) return respondJson(res, 403, { error: 'Request rejected' });
      if (!contentTypeIsJson(req)) return respondJson(res, 415, { error: 'Unsupported media type' });
      const session = await officeSession(req, runtime);
      if (!session) return respondJson(res, 401, { error: 'Authentication required' });
      const repositoryId = repositoryIdFromBody(await readJsonBody(req));
      if (repositoryId === undefined) return respondJson(res, 400, { error: 'Invalid repository selection' });
      const selected = await runtime.repositoriesStore.setSelectedForUser(
        session.githubUserId,
        repositoryId,
        runtime.now(),
      );
      if (!selected) return respondJson(res, 404, { error: 'Repository is not available to this account' });
      const repositories = await runtime.repositoriesStore.listForUser(session.githubUserId);
      return respondJson(res, 200, {
        repositories: repositories.map((repository) => ({
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          isPrivate: repository.isPrivate,
          defaultBranch: repository.defaultBranch,
          htmlUrl: repository.htmlUrl,
          isSelected: repository.isSelected,
        })),
      });
    },
  });
}
