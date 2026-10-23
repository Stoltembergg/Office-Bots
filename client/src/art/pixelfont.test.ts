import { describe, expect, it } from 'vitest';
import { pixelTextCovers } from './pixelfont';

describe('pixelTextCovers', () => {
  it('aceita latim com acentos e recusa alfabetos sem glifo', () => {
    expect(pixelTextCovers('Fechado')).toBe(true);
    expect(pixelTextCovers('Fermé')).toBe(true);
    expect(pixelTextCovers('Cerrado')).toBe(true);
    expect(pixelTextCovers('닫힘')).toBe(false);
  });
});
