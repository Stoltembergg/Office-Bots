import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OFFICE_SESSION_TTL_MS, type GitHubWebAuthRuntime } from './github-web-auth-runtime';

const SESSION_COOKIE = '__Host-office_bots_session';
const BINDING_COOKIE = '__Host-office_bots_oauth_binding';
const OAUTH_COOKIE_MAX_AGE = 5 * 60;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export interface GitHubWebAuthHandlers {
  start(req: IncomingMessage, res: ServerResponse): Promise<void>;
  callback(req: IncomingMessage, res: ServerResponse): Promise<void>;
  session(req: IncomingMessage, res: ServerResponse): Promise<void>;
  logout(req: IncomingMessage, res: ServerResponse): Promise<void>;
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
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8_192) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return cookie(name, '', 0);
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end();
}

function sameOrigin(req: IncomingMessage, expectedOrigin: string): boolean {
  const value = req.headers.origin;
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function methodNotAllowed(res: ServerResponse, method: string): void {
  res.setHeader('Allow', method);
  respondJson(res, 405, { error: 'Method not allowed' });
}

export function createGitHubWebAuthHandlers(runtime: GitHubWebAuthRuntime): GitHubWebAuthHandlers {
  return Object.freeze({
    async start(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const binding = randomBytes(32).toString('base64url');
      const authorization = await runtime.flow.beginAuthorization(binding);
      res.writeHead(302, {
        Location: authorization.authorizationUrl,
        'Set-Cookie': cookie(BINDING_COOKIE, binding, OAUTH_COOKIE_MAX_AGE),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end();
    },

    async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const url = requestUrl(req);
      if (!url) return redirect(res, `${runtime.appOrigin}/?login=failed`, [clearCookie(BINDING_COOKIE)]);

      const providerError = url.searchParams.get('error');
      if (providerError) {
        return redirect(res, `${runtime.appOrigin}/?login=cancelled`, [clearCookie(BINDING_COOKIE)]);
      }

      const binding = readCookie(req, BINDING_COOKIE);
      if (!binding) return redirect(res, `${runtime.appOrigin}/?login=failed`, [clearCookie(BINDING_COOKIE)]);
      try {
        const identity = await runtime.flow.completeAuthorization({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          browserBinding: binding,
        });
        const session = await runtime.sessions.create(identity.githubUserId);
        return redirect(res, `${runtime.appOrigin}/?login=success`, [
          cookie(SESSION_COOKIE, session.token, Math.floor(OFFICE_SESSION_TTL_MS / 1000)),
          clearCookie(BINDING_COOKIE),
        ]);
      } catch {
        return redirect(res, `${runtime.appOrigin}/?login=failed`, [clearCookie(BINDING_COOKIE)]);
      }
    },

    async session(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const token = readCookie(req, SESSION_COOKIE);
      if (!token) return respondJson(res, 200, { authenticated: false });
      const session = await runtime.sessions.get(token);
      if (!session) return respondJson(res, 200, { authenticated: false });
      return respondJson(res, 200, { authenticated: true, githubUserId: session.githubUserId });
    },

    async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!sameOrigin(req, runtime.appOrigin)) return respondJson(res, 403, { error: 'Request rejected' });
      const token = readCookie(req, SESSION_COOKIE);
      if (token) await runtime.sessions.revoke(token);
      res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
      return respondJson(res, 200, { authenticated: false });
    },
  });
}
