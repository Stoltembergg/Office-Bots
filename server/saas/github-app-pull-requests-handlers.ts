import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitHubAppPullRequestsResult } from './github-app-pull-requests.js';

const SESSION_COOKIE = '__Host-office_bots_session';
const SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export interface GitHubAppPullRequestsLoader {
  load(sessionCredential: unknown): Promise<GitHubAppPullRequestsResult>;
}

export interface GitHubAppPullRequestsRuntime {
  readonly loader: GitHubAppPullRequestsLoader;
}

export interface GitHubAppPullRequestsHandlers {
  list(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readSessionCredential(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8_192) return undefined;
  let credential: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    if (credential !== undefined) return undefined;
    const value = part.slice(separator + 1).trim();
    if (!SESSION_CREDENTIAL_PATTERN.test(value)) return undefined;
    credential = value;
  }
  return credential;
}

function methodNotAllowed(res: ServerResponse): void {
  res.setHeader('Allow', 'GET');
  respondJson(res, 405, { error: 'Method not allowed' });
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function createGitHubAppPullRequestsHandlers(runtime: GitHubAppPullRequestsRuntime): GitHubAppPullRequestsHandlers {
  return Object.freeze({
    async list(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const sessionCredential = readSessionCredential(req);
      if (!sessionCredential) return respondJson(res, 401, { error: 'Authentication required' });
      try {
        const result = await runtime.loader.load(sessionCredential);
        return respondJson(res, 200, result);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'unauthenticated') return respondJson(res, 401, { error: 'Authentication required' });
        if (code === 'repository_required') return respondJson(res, 409, { error: 'Select a repository first' });
        if (code === 'configuration') return respondJson(res, 503, { error: 'Pull request access is unavailable' });
        return respondJson(res, 502, { error: 'Pull requests could not be loaded' });
      }
    },
  });
}
