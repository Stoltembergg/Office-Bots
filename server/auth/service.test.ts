import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from './service';

function request(opts: {
  host?: string;
  cookie?: string;
  ip?: string;
  encrypted?: boolean;
  forwardedProto?: string;
} = {}): IncomingMessage {
  return {
    headers: {
      host: opts.host,
      cookie: opts.cookie,
      'x-forwarded-proto': opts.forwardedProto,
    },
    socket: {
      remoteAddress: opts.ip ?? '10.0.0.1',
      encrypted: opts.encrypted,
    },
  } as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; setHeader: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  return { res: { setHeader } as unknown as ServerResponse, setHeader };
}

function sessionToken(setHeader: ReturnType<typeof vi.fn>): string {
  const cookie = setHeader.mock.calls[0]?.[1] as string;
  return /^habblaud_session=([0-9a-f]{64});/.exec(cookie)?.[1] ?? '';
}

describe('AuthService', () => {
  it('requires authentication', () => {
    expect(createAuthService({ password: 'secret' }).required).toBe(true);
  });

  it('treats a localhost Host from a loopback address as privileged without a cookie', () => {
    const auth = createAuthService({ password: 'secret' });

    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: '127.0.0.1' }))).toBe(true);
    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: '::1' }))).toBe(true);
    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: '::ffff:127.0.0.1' }))).toBe(true);
  });

  it('does not trust a forged localhost Host from a non-loopback address', () => {
    const auth = createAuthService({ password: 'secret' });

    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: '192.168.0.10' }))).toBe(false);
    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: '::ffff:192.168.0.10' }))).toBe(false);
    expect(auth.isPrivileged(request({ host: 'localhost:3000', ip: undefined as unknown as string }))).toBe(false);
  });

  it('treats a valid session as privileged with a remote Host and IP', () => {
    const auth = createAuthService({ password: 'secret' });
    const { res, setHeader } = response();
    auth.login(request({ host: '10.0.0.1', ip: '192.168.0.10' }), res, 'secret');
    const cookie = `habblaud_session=${sessionToken(setHeader)}`;

    expect(auth.isPrivileged(request({ host: '10.0.0.1', ip: '192.168.0.10', cookie }))).toBe(true);
  });

  it('does not treat a remote Host as privileged without a cookie', () => {
    const auth = createAuthService({ password: 'secret' });

    expect(auth.isPrivileged(request({ host: '10.0.0.1' }))).toBe(false);
  });

  it('authenticates a request after a correct login', () => {
    const auth = createAuthService({ password: 'secret' });
    const loginReq = request({ host: '10.0.0.1' });
    const { res, setHeader } = response();

    expect(auth.login(loginReq, res, 'secret')).toEqual({ status: 200 });
    const authenticatedReq = request({ host: '10.0.0.1', cookie: `habblaud_session=${sessionToken(setHeader)}` });

    expect(auth.isAuthenticated(authenticatedReq)).toBe(true);
    expect(auth.session(authenticatedReq)).toEqual({ required: true, authenticated: true });
  });

  it('rejects an incorrect password', () => {
    const auth = createAuthService({ password: 'secret' });

    expect(auth.login(request(), response().res, 'wrong').status).toBe(401);
  });

  it('rate limits an IP after five incorrect passwords', () => {
    const auth = createAuthService({ password: 'secret' });
    const req = request({ ip: '::ffff:10.0.0.1' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(auth.login(req, response().res, 'wrong').status).toBe(401);
    }

    expect(auth.login(req, response().res, 'wrong').status).toBe(429);
  });

  it('revokes the current session on logout', () => {
    const auth = createAuthService({ password: 'secret' });
    const { res, setHeader } = response();
    auth.login(request(), res, 'secret');
    const req = request({ cookie: `habblaud_session=${sessionToken(setHeader)}` });
    const logoutResponse = response();

    auth.logout(req, logoutResponse.res);

    expect(auth.isAuthenticated(req)).toBe(false);
    expect(logoutResponse.setHeader.mock.calls[0]?.[1]).toContain('Max-Age=0');
  });

  it('detects secure requests from the socket or proxy header', () => {
    const auth = createAuthService({ password: 'secret' });

    expect(auth.cookieSecure(request({ encrypted: true }))).toBe(true);
    expect(auth.cookieSecure(request({ forwardedProto: 'https' }))).toBe(true);
    expect(auth.cookieSecure(request())).toBe(false);
  });
});
