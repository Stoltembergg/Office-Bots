import { describe, expect, it } from 'vitest';
import { parseIdleLeave } from './config';

describe('HABBLAUD_IDLE_LEAVE_MIN', () => {
  it('minutos em ms; vazio, zero, negativo ou texto desligam', () => {
    expect(parseIdleLeave('10')).toBe(600_000);
    expect(parseIdleLeave(' 0.5 ')).toBe(30_000);
    for (const v of [undefined, '', '0', '-3', 'dez']) expect(parseIdleLeave(v)).toBe(0);
  });
});
