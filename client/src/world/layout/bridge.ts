// Passarela entre blocos como área: piso de chapas e tiles caminháveis nos trechos, sem paredes,
// guarda-corpo em cada borda de tile que não dá em outro trecho nem numa porta. Não entra na camada base: o render
// desenha a passarela numa camada elevada, depois de tudo o que está no chão.
import { TILE } from '../constants';
import { AreaBuilder } from './builder';
import { inRect, type BridgeLayout } from './geometry';
import type { AreaLayout, TileRect } from './types';

/** Bordas do tile: variante do guarda-corpo e o vizinho que ela encara. */
const SIDES = [
  ['n', 0, -1],
  ['s', 0, 1],
  ['w', -1, 0],
  ['e', 1, 0],
] as const;

const cache = new Map<string, AreaLayout>();

/** Caixa (tiles) que cobre todos os trechos. */
function boundsOf(rects: readonly TileRect[]): TileRect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function layoutBridge(bridge: BridgeLayout): AreaLayout {
  const cached = cache.get(bridge.id);
  if (cached) return cached;
  const rect = boundsOf(bridge.rects);
  const b = new AreaBuilder(bridge.id, 'bridge', rect);
  const on = (tx: number, ty: number) => bridge.rects.some((r) => inRect(r, tx, ty));
  const opening = (tx: number, ty: number) => bridge.openings.some((r) => inRect(r, tx, ty));
  bridge.rects.forEach((r, i) => {
    b.floor('bridge', r.x - rect.x, r.y - rect.y, r.w, r.h, 701 + i);
    b.walk(r.x - rect.x, r.y - rect.y, r.w, r.h);
  });
  for (const r of bridge.rects) {
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        for (const [side, dx, dy] of SIDES) {
          if (on(tx + dx, ty + dy) || opening(tx + dx, ty + dy)) continue;
          // as variantes laterais são desenhadas no centro do tile; o deslocamento em px as leva à borda (ver `railing` em common.ts)
          const shift = side === 'w' ? -TILE / 2 : side === 'e' ? TILE / 2 : undefined;
          b.furn('railing', tx - rect.x, ty - rect.y, side, { order: 0.9, dx: shift });
        }
      }
    }
  }
  const area = b.build();
  cache.set(bridge.id, area);
  return area;
}
