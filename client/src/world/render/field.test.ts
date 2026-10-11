import { describe, expect, it } from 'vitest';
import { TILE } from '../constants';
import { FIELD_CELL, fieldCells, fieldProp } from './field';

describe('campo de árvores além dos bounds', () => {
  it('é determinístico e fica dentro da própria célula, com 1 tile de folga', () => {
    for (let cx = -20; cx <= 20; cx += 3) {
      for (let cy = -20; cy <= 20; cy += 3) {
        const p = fieldProp(cx, cy);
        expect(fieldProp(cx, cy)).toEqual(p);
        if (!p) continue;
        expect(['tree', 'pine', 'bush']).toContain(p.kind);
        expect(p.x).toBeGreaterThanOrEqual((cx * FIELD_CELL + 1) * TILE);
        expect(p.x).toBeLessThan((cx * FIELD_CELL + FIELD_CELL - 1) * TILE);
        expect(p.y).toBeGreaterThanOrEqual((cy * FIELD_CELL + 1) * TILE);
        expect(p.y).toBeLessThan((cy * FIELD_CELL + FIELD_CELL - 1) * TILE);
      }
    }
  });

  it('nem toda célula tem prop, e há dos três tipos', () => {
    const kinds = new Set<string>();
    let empty = 0;
    for (let cx = 0; cx < 30; cx++) for (let cy = 0; cy < 30; cy++) {
      const p = fieldProp(cx, cy);
      if (p) kinds.add(p.kind);
      else empty++;
    }
    expect(empty).toBeGreaterThan(200);
    expect(empty).toBeLessThan(700);
    expect([...kinds].sort()).toEqual(['bush', 'pine', 'tree']);
  });

  it('a semente muda o campo', () => {
    let diff = 0;
    for (let cx = 0; cx < 10; cx++) for (let cy = 0; cy < 10; cy++) if (JSON.stringify(fieldProp(cx, cy, 1)) !== JSON.stringify(fieldProp(cx, cy, 2))) diff++;
    expect(diff).toBeGreaterThan(50);
  });

  it('fieldCells cobre o retângulo, inclusive em coordenadas negativas', () => {
    const s = FIELD_CELL * TILE;
    expect(fieldCells(-1, -1, s, s)).toEqual({ cx0: -1, cy0: -1, cx1: 1, cy1: 1 });
    expect(fieldCells(0, 0, s - 1, s - 1)).toEqual({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
  });
});
