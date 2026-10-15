import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class SessionStore {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): string {
    const token = randomBytes(32).toString('hex');
    this.expiresAt.set(token, this.now() + SESSION_TTL_MS);
    return token;
  }

  has(token: string): boolean {
    const expiry = this.expiresAt.get(token);
    if (expiry === undefined) return false;
    if (this.now() < expiry) return true;
    this.expiresAt.delete(token);
    return false;
  }

  revoke(token: string): void {
    this.expiresAt.delete(token);
  }
}
