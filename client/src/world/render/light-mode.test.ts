import { describe, expect, it } from 'vitest';
import { lightMode } from './light-mode';

describe('modo de luz por kind de área (spec 5 e 8)', () => {
  it('copa, lounge, banheiros e saguão acendem por presença', () => {
    for (const k of ['cafe', 'lounge', 'restroom', 'hub'] as const) expect(lightMode(k)).toBe('presence');
  });
  it('a passarela é pintada como corredor, só nos trechos', () => {
    expect(lightMode('bridge')).toBe('bridge');
  });
  it('recepção, corredor e salas: luz própria', () => {
    for (const k of ['reception', 'corridor', 'room'] as const) expect(lightMode(k)).toBe('own');
  });
});
