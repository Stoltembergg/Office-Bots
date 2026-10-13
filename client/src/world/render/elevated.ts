// Camada elevada (passarela): quem está num tile elevado é desenhado depois de todo o chão. Para não inverter uma
// fila na porta, quem está no chão com o sprite cruzando o de alguém elevado sobe junto (fecho transitivo).
import { CHAR_AY, CHAR_H, CHAR_W } from '../../art/character/render';

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function charRect(ch: { x: number; y: number }): PxRect {
  return { x: ch.x - CHAR_W / 2, y: ch.y - CHAR_AY, w: CHAR_W, h: CHAR_H };
}

const overlaps = (a: PxRect, b: PxRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function promoteOverlapping<T>(elevated: readonly T[], ground: readonly T[], rectOf: (c: T) => PxRect): T[] {
  if (!elevated.length || !ground.length) return [];
  const up: PxRect[] = elevated.map(rectOf);
  const out: { c: T; i: number }[] = [];
  const rest = ground.map((c, i) => ({ c, i, r: rectOf(c) }));
  let grew = true;
  while (grew) {
    grew = false;
    for (let k = rest.length - 1; k >= 0; k--) {
      const { c, i, r } = rest[k];
      if (!up.some((u) => overlaps(u, r))) continue;
      out.push({ c, i });
      up.push(r);
      rest.splice(k, 1);
      grew = true;
    }
  }
  // na ordem do chão (estável), não na ordem em que subiram
  return out.sort((a, b) => a.i - b.i).map((o) => o.c);
}
