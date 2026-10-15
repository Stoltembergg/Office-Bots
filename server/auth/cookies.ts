const SESSION_COOKIE = 'habblaud_session';

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionSetCookie(token: string, opts: { secure: boolean; maxAge: number }): string {
  return cookie(`${SESSION_COOKIE}=${token}`, opts.secure, opts.maxAge);
}

export function sessionClearCookie(opts: { secure: boolean }): string {
  return cookie(`${SESSION_COOKIE}=`, opts.secure, 0);
}

function cookie(value: string, secure: boolean, maxAge: number): string {
  return `${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
