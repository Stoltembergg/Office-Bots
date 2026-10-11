import { describe, expect, it } from 'vitest';
import { charRect, promoteOverlapping } from './elevated';

const r = (x: number, y: number) => ({ x, y, w: 24, h: 34 });
describe('camada elevada: quem está no chão com o sprite cruzando o de alguém elevado sobe junto', () => {
  it('sobe só quem cruza (e em cadeia), sem repetir, mantendo a ordem', () => {
    const a = { id: 'a', ...r(100, 100) };
    const b = { id: 'b', ...r(104, 120) }; // cruza a
    const c = { id: 'c', ...r(108, 150) }; // cruza b, não a
    const d = { id: 'd', ...r(300, 100) }; // longe
    expect(promoteOverlapping([a], [d, c, b], (o) => o).map((o) => o.id)).toEqual(['c', 'b']);
  });
  it('sem elevados, ninguém sobe', () => {
    expect(promoteOverlapping([], [{ ...r(0, 0) }], (o) => o)).toEqual([]);
  });
  it('charRect usa a âncora do sprite (24×34, âncora y 31)', () => {
    expect(charRect({ x: 50, y: 70 })).toEqual({ x: 38, y: 39, w: 24, h: 34 });
  });
});
