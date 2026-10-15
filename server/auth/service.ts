import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLoopbackAddress, isLoopbackHost } from '../http/guard';
import { parseCookie, sessionClearCookie, sessionSetCookie } from './cookies';
import { passwordsEqual } from './password';
import { LoginRateLimit } from './rate-limit';
import { SessionStore } from './sessions';

const SESSION_COOKIE = 'habblaud_session';
const SESSION_MAX_AGE = 604_800;

export interface AuthService {
  readonly required: true;
  isAuthenticated(req: IncomingMessage): boolean;
  isPrivileged(req: IncomingMessage): boolean;
  login(req: IncomingMessage, res: ServerResponse, password: string): { status: 200 } | { status: 401 | 429; error: string };
  logout(req: IncomingMessage, res: ServerResponse): void;
  session(req: IncomingMessage): { required: true; authenticated: boolean };
  cookieSecure(req: IncomingMessage): boolean;
}

export function createAuthService(opts: { password: string; now?: () => number }): AuthService {
  const sessions = new SessionStore(opts.now);
  const rateLimit = new LoginRateLimit(opts.now);

  function tokenOf(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    return parseCookie(typeof header === 'string' ? header : undefined, SESSION_COOKIE);
  }

  function ipOf(req: IncomingMessage): string {
    return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  }

  const service: AuthService = {
    required: true,

    isAuthenticated(req) {
      const token = tokenOf(req);
      return token !== undefined && sessions.has(token);
    },

    isPrivileged(req) {
      // Host sozinho é forjável por cliente remoto: exige também endereço de origem loopback.
      return service.isAuthenticated(req) || (isLoopbackHost(req.headers.host) && isLoopbackAddress(req.socket.remoteAddress));
    },

    login(req, res, password) {
      const ip = ipOf(req);
      if (rateLimit.tooMany(ip)) return { status: 429, error: 'Too many login attempts.' };
      if (!passwordsEqual(password, opts.password)) {
        rateLimit.fail(ip);
        return { status: 401, error: 'Invalid password.' };
      }

      rateLimit.success(ip);
      const token = sessions.create();
      res.setHeader('Set-Cookie', sessionSetCookie(token, { secure: service.cookieSecure(req), maxAge: SESSION_MAX_AGE }));
      return { status: 200 };
    },

    logout(req, res) {
      const token = tokenOf(req);
      if (token !== undefined) sessions.revoke(token);
      res.setHeader('Set-Cookie', sessionClearCookie({ secure: service.cookieSecure(req) }));
    },

    session(req) {
      return { required: true, authenticated: service.isAuthenticated(req) };
    },

    cookieSecure(req) {
      const socket = req.socket as IncomingMessage['socket'] & { encrypted?: boolean };
      const forwarded = req.headers['x-forwarded-proto'];
      return socket.encrypted === true || (typeof forwarded === 'string' && forwarded.toLowerCase() === 'https');
    },
  };

  return service;
}
