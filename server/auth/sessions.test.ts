import { describe, expect, it } from 'vitest';
import { SessionStore } from './sessions';

describe('SessionStore', () => {
  it('creates a 32-byte hexadecimal token', () => {
    const store = new SessionStore();
    const token = store.create();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.has(token)).toBe(true);
  });

  it('revokes a session', () => {
    const store = new SessionStore();
    const token = store.create();

    store.revoke(token);

    expect(store.has(token)).toBe(false);
  });

  it('expires a session after seven days', () => {
    let now = 1_000;
    const store = new SessionStore(() => now);
    const token = store.create();

    now += 7 * 24 * 60 * 60 * 1_000;

    expect(store.has(token)).toBe(false);
  });
});
