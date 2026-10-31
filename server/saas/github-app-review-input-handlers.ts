import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PreparedReviewInput } from './review-input.js';

const SESSION_COOKIE = '__Host-office_bots_session';
const SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export interface GitHubAppReviewInputLoader {
  load(request: { readonly sessionCredential: unknown; readonly pullNumber: unknown }): Promise<PreparedReviewInput>;
}

export interface GitHubAppReviewInputRuntime {
  readonly loader: GitHubAppReviewInputLoader;
}

export interface GitHubAppReviewInputHandlers {
  prepare(req: IncomingMessage, res: ServerResponse): Promise<void>;
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

function pullNumber(req: IncomingMessage): number | undefined {
  if (typeof req.url !== 'string' || req.url.length > 8_192) return undefined;
  try {
    const url = new URL(req.url, 'https://office-bots.invalid');
    if (
      url.origin !== 'https://office-bots.invalid' ||
      url.pathname !== '/api/github/pull-requests/input' ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== 'number') ||
      url.searchParams.getAll('number').length !== 1
    ) return undefined;
    const rawNumber = url.searchParams.get('number');
    if (!rawNumber || !/^[1-9][0-9]{0,15}$/.test(rawNumber)) return undefined;
    const value = Number(rawNumber);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createGitHubAppReviewInputHandlers(runtime: GitHubAppReviewInputRuntime): GitHubAppReviewInputHandlers {
  return Object.freeze({
    async prepare(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res);
      const sessionCredential = readSessionCredential(req);
      if (!sessionCredential) return respondJson(res, 401, { error: 'Authentication required' });
      const number = pullNumber(req);
      if (number === undefined) return respondJson(res, 400, { error: 'A single valid pull request number is required' });

      try {
        const result = await runtime.loader.load({ sessionCredential, pullNumber: number });
        return respondJson(res, 200, {
          pullRequest: {
            number: result.pullRequest.number,
            baseSha: result.pullRequest.baseSha,
            headSha: result.pullRequest.headSha,
          },
          files: result.files.map((file) => ({ filename: file.filename })),
          completeness: 'unverified',
        });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'unauthenticated') return respondJson(res, 401, { error: 'Authentication required' });
        if (code === 'repository_required') return respondJson(res, 409, { error: 'Select a repository first' });
        if (code === 'invalid_request') return respondJson(res, 400, { error: 'A valid pull request number is required' });
        if (code === 'forbidden') return respondJson(res, 403, { error: 'Repository access is unavailable' });
        if (code === 'configuration') return respondJson(res, 503, { error: 'Pull request input is unavailable' });
        return respondJson(res, 502, { error: 'Pull request input could not be prepared' });
      }
    },
  });
}
