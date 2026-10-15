// Conta do Cursor: uma só (.cursor), letra R, cor da paleta sem repetir as já usadas.
import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { detectCursorAccount } from './accounts';

describe('conta do Cursor', () => {
  it('id .cursor, provider cursor, letra R, nome Cursor, cor da paleta', () => {
    const acc = detectCursorAccount('/home/x/.cursor');
    expect(acc).toMatchObject({ id: '.cursor', provider: 'cursor', short: 'R', name: 'Cursor', configDir: '/home/x/.cursor' });
    expect(ACCOUNT_COLORS).toContain(acc.color);
  });

  it('não repete as cores já usadas por outras contas', () => {
    const acc = detectCursorAccount('/home/x/.cursor', { taken: { colors: [ACCOUNT_COLORS[0], ACCOUNT_COLORS[1]] } });
    expect(acc.color).toBe(ACCOUNT_COLORS[2]);
  });
});
