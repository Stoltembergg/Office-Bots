import { describe, expect, it } from 'vitest';
import { demoSessionsFrom } from './overlays';

describe('demoSessionsFrom', () => {
  it('inteiro entre 1 e 40; vazio ou inválido vira 4', () => {
    expect(demoSessionsFrom('7')).toBe(7);
    expect(demoSessionsFrom(' 12 ')).toBe(12);
    expect(demoSessionsFrom('2.9')).toBe(2);
    expect(demoSessionsFrom('0')).toBe(1);
    expect(demoSessionsFrom('-3')).toBe(1);
    expect(demoSessionsFrom('999')).toBe(40);
    expect(demoSessionsFrom('')).toBe(4);
    expect(demoSessionsFrom('abc')).toBe(4);
  });
});
