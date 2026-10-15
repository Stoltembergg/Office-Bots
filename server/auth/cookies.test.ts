import { describe, expect, it } from 'vitest';
import { parseCookie, sessionClearCookie, sessionSetCookie } from './cookies';

describe('cookie helpers', () => {
  it('parses a named cookie from a header with multiple cookies', () => {
    expect(parseCookie('theme=dark; habblaud_session=abc123; locale=pt-BR', 'habblaud_session')).toBe('abc123');
    expect(parseCookie(undefined, 'habblaud_session')).toBeUndefined();
  });

  it('creates the session cookie with strict security attributes', () => {
    expect(sessionSetCookie('a'.repeat(64), { secure: false, maxAge: 604_800 })).toBe(
      `habblaud_session=${'a'.repeat(64)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
    );
    expect(sessionSetCookie('a'.repeat(64), { secure: true, maxAge: 604_800 })).toContain('; Secure');
  });

  it('clears the session cookie immediately', () => {
    expect(sessionClearCookie({ secure: false })).toContain('Max-Age=0');
    expect(sessionClearCookie({ secure: true })).toContain('; Secure');
  });
});
