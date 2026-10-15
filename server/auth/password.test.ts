import { describe, expect, it } from 'vitest';
import { hashPassword, passwordsEqual } from './password';

describe('password helpers', () => {
  it('hashes passwords with SHA-256', () => {
    expect(hashPassword('secret')).toHaveLength(32);
  });

  it('accepts equal passwords', () => {
    expect(passwordsEqual('secret', 'secret')).toBe(true);
  });

  it('rejects different passwords', () => {
    expect(passwordsEqual('secret', 'other')).toBe(false);
  });

  it('compares empty strings safely', () => {
    expect(passwordsEqual('', '')).toBe(true);
    expect(passwordsEqual('', 'non-empty')).toBe(false);
  });
});
