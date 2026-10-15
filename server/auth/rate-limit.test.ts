import { describe, expect, it } from 'vitest';
import { LoginRateLimit } from './rate-limit';

describe('LoginRateLimit', () => {
  it('blocks an IP after five failures', () => {
    const limit = new LoginRateLimit();

    for (let attempt = 0; attempt < 5; attempt += 1) limit.fail('10.0.0.1');

    expect(limit.tooMany('10.0.0.1')).toBe(true);
    expect(limit.tooMany('10.0.0.2')).toBe(false);
  });

  it('clears failures after a successful login', () => {
    const limit = new LoginRateLimit();
    for (let attempt = 0; attempt < 5; attempt += 1) limit.fail('10.0.0.1');

    limit.success('10.0.0.1');

    expect(limit.tooMany('10.0.0.1')).toBe(false);
  });

  it('allows attempts again after sixty seconds', () => {
    let now = 1_000;
    const limit = new LoginRateLimit(() => now);
    for (let attempt = 0; attempt < 5; attempt += 1) limit.fail('10.0.0.1');

    now += 60_000;

    expect(limit.tooMany('10.0.0.1')).toBe(false);
  });
});
