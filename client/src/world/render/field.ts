// Campo de árvores procedural além dos bounds da área externa: o mundo não acaba quando a
// câmera afasta. Por célula de FIELD_CELL × FIELD_CELL tiles, um hash da célula decide se há árvore, pinheiro ou
// arbusto e onde dentro dela — determinístico (a mesma célula dá o mesmo prop em qualquer frame e zoom) e sem
// estado. O renderer só pede as células visíveis que ficam fora dos bounds e fora das faixas estendidas das ruas.
import { mulberry32 } from '../../../../shared/hash';
import { TILE } from '../constants';
import type { ExteriorProp } from '../layout/types';

/** Lado da célula, em tiles. */
export const FIELD_CELL = 8;

/** Prop da célula (cx, cy) do campo, ou null (célula vazia, ~45 % delas). */
export function fieldProp(cx: number, cy: number, seed = 0): ExteriorProp | null {
  const r = mulberry32(((cx * 73856093) ^ (cy * 19349663) ^ (seed * 83492791) ^ 0x7a3) >>> 0);
  const roll = r();
  if (roll >= 0.55) return null;
  const kind = roll < 0.1 ? 'bush' : roll < 0.25 ? 'pine' : 'tree';
  // dentro da célula com 1 tile de folga nas bordas: copas vizinhas não se encostam numa linha reta
  const x = (cx * FIELD_CELL + 1 + Math.floor(r() * (FIELD_CELL - 2))) * TILE + Math.floor(r() * TILE);
  const y = (cy * FIELD_CELL + 1 + Math.floor(r() * (FIELD_CELL - 2))) * TILE + Math.floor(r() * TILE);
  return { kind, x, y, seed: Math.floor(r() * 1e9) };
}

/** A célula (cx, cy) encosta no retângulo (px) com 1 tile de folga? Essas células são plantadas pela área externa, não pelo campo. */
export function cellTouches(cx: number, cy: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const s = FIELD_CELL * TILE;
  const x = cx * s;
  const y = cy * s;
  return x + s > x0 - TILE && x < x1 + TILE && y + s > y0 - TILE && y < y1 + TILE;
}

/** Índices das células (inclusive) que cobrem um retângulo em px. */
export function fieldCells(x0: number, y0: number, x1: number, y1: number): { cx0: number; cy0: number; cx1: number; cy1: number } {
  const s = FIELD_CELL * TILE;
  return { cx0: Math.floor(x0 / s), cy0: Math.floor(y0 / s), cx1: Math.floor(x1 / s), cy1: Math.floor(y1 / s) };
}
