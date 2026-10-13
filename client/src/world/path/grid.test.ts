// Grade com origem (x0, y0): chaves, limites, preenchimento e buscas num retângulo que começa em tiles
// negativos (a caixa do mundo cresce para oeste e para o norte do prédio principal).
import { describe, expect, it } from 'vitest';
import { BLOCKED, FREE, SEAT, WalkGrid } from './grid';

/** Grade a partir de linhas de texto ('#' bloqueado, 's' assento, resto livre) com origem (x0, y0). */
function gridFrom(rows: string[], x0: number, y0: number): WalkGrid {
  const g = WalkGrid.forRect({ x: x0, y: y0, w: rows[0].length, h: rows.length });
  rows.forEach((r, y) => [...r].forEach((c, x) => g.set(x + x0, y + y0, c === '#' ? BLOCKED : c === 's' ? SEAT : FREE)));
  return g;
}

describe('WalkGrid com origem (−16, −41)', () => {
  const X0 = -16;
  const Y0 = -41;
  const W = 10;
  const H = 8;

  it('forRect guarda largura, altura, origem e versão', () => {
    const g = WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H }, 7);
    expect([g.w, g.h, g.x0, g.y0, g.version]).toEqual([W, H, X0, Y0, 7]);
    expect(g.cells.length).toBe(W * H);
    expect(WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H }).version).toBe(0);
  });

  it('key e at invertem um ao outro em toda a caixa', () => {
    const g = WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H });
    expect(g.key(X0, Y0)).toBe(0);
    expect(g.key(X0 + 1, Y0)).toBe(1);
    expect(g.key(X0, Y0 + 1)).toBe(W);
    expect(g.key(X0 + W - 1, Y0 + H - 1)).toBe(W * H - 1);
    expect(g.at(0)).toEqual({ x: X0, y: Y0 });
    expect(g.at(W)).toEqual({ x: X0, y: Y0 + 1 });
    expect(g.at(W * H - 1)).toEqual({ x: X0 + W - 1, y: Y0 + H - 1 });
    for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) expect(g.at(g.key(x, y))).toEqual({ x, y });
    for (let i = 0; i < W * H; i++) {
      const { x, y } = g.at(i);
      expect(g.key(x, y)).toBe(i);
    }
  });

  it('inside aceita só a caixa: recusa à esquerda de x0, acima de y0 e o (0, 0) do mundo', () => {
    const g = WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H });
    expect(g.inside(X0, Y0)).toBe(true);
    expect(g.inside(X0 + W - 1, Y0 + H - 1)).toBe(true);
    expect(g.inside(X0 - 1, Y0)).toBe(false);
    expect(g.inside(X0, Y0 - 1)).toBe(false);
    expect(g.inside(X0 + W, Y0)).toBe(false);
    expect(g.inside(X0, Y0 + H)).toBe(false);
    expect(g.inside(0, 0)).toBe(false);
  });

  it('fill, get e set trabalham em tiles negativos; fora da caixa get é BLOCKED e set não escreve', () => {
    const g = WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H });
    expect(g.get(X0, Y0)).toBe(BLOCKED);
    g.fill(-15, -40, 3, 2, FREE);
    expect(g.get(-15, -40)).toBe(FREE);
    expect(g.get(-13, -39)).toBe(FREE);
    expect(g.get(-12, -40)).toBe(BLOCKED);
    expect(g.get(-16, -40)).toBe(BLOCKED);
    expect(g.walkable(-15, -40)).toBe(true);
    g.set(-14, -40, SEAT);
    expect(g.get(-14, -40)).toBe(SEAT);
    expect(g.walkable(-14, -40)).toBe(true);
    // fora da caixa: set é ignorado (não cai na célula 0, que é o tile (x0, y0)) e get devolve BLOCKED
    g.set(0, 0, FREE);
    expect(g.get(X0, Y0)).toBe(BLOCKED);
    expect(g.get(0, 0)).toBe(BLOCKED);
    expect(g.walkable(0, 0)).toBe(false);
    // fill que passa da borda só marca o que está dentro
    g.fill(X0 - 2, Y0 - 2, 4, 4, FREE);
    expect(g.get(X0, Y0)).toBe(FREE);
    expect(g.get(X0 + 1, Y0 + 1)).toBe(FREE);
    expect(g.get(X0 - 1, Y0)).toBe(BLOCKED);
    // 6 do primeiro fill + 3 novas do segundo ((−15, −40) já contava)
    expect(g.cells.filter((c) => c !== BLOCKED)).toHaveLength(9);
  });

  it('nearestWalkable só devolve tiles de dentro da caixa, mesmo partindo de fora', () => {
    const g = WalkGrid.forRect({ x: X0, y: Y0, w: W, h: H });
    g.fill(X0, Y0, W, H, FREE);
    // de fora, a oeste: o vizinho de dentro na mesma linha
    expect(g.nearestWalkable(X0 - 1, -38)).toEqual({ x: X0, y: -38 });
    // de fora, acima: o vizinho de dentro na mesma coluna
    expect(g.nearestWalkable(-10, Y0 - 1)).toEqual({ x: -10, y: Y0 });
    // longe demais para o raio padrão (12): nada; com raio maior, o canto da caixa
    expect(g.nearestWalkable(-30, -50)).toBeNull();
    expect(g.nearestWalkable(-30, -50, 20)).toEqual({ x: X0, y: Y0 });
    // de dentro, num tile bloqueado, acha um livre adjacente
    g.set(-12, -38, BLOCKED);
    const n = g.nearestWalkable(-12, -38);
    expect(n).not.toBeNull();
    expect(g.inside(n!.x, n!.y)).toBe(true);
    expect(Math.abs(n!.x + 12) + Math.abs(n!.y + 38)).toBe(1);
    // tudo bloqueado: null
    g.fill(X0, Y0, W, H, BLOCKED);
    expect(g.nearestWalkable(-12, -38)).toBeNull();
  });

  it('nearestWalkable com accept: só tiles aceitos; sem nenhum no raio, null (nunca um tile de outra região)', () => {
    const g = WalkGrid.forRect({ x: 0, y: 0, w: 10, h: 1 });
    g.fill(0, 0, 10, 1, FREE);
    // o próprio tile é livre mas não aceito: segue para o aceito mais próximo
    expect(g.nearestWalkable(0, 0, 12, (x) => x >= 5)).toEqual({ x: 5, y: 0 });
    // raio curto demais para alcançar um aceito: null, mesmo havendo tiles livres a 1 de distância
    expect(g.nearestWalkable(0, 0, 3, (x) => x >= 5)).toBeNull();
    // sem accept, o comportamento de sempre
    expect(g.nearestWalkable(0, 0, 3)).toEqual({ x: 0, y: 0 });
    // o tile de partida recusado, um vizinho aceito de cada lado: devolve um dos dois
    const n = g.nearestWalkable(2, 0, 12, (x) => x !== 2);
    expect([1, 3]).toContain(n!.x);
  });

  it('reachableFrom marca índices por key e não sai da caixa', () => {
    const g = gridFrom(['..#..', '..#..', '.....'], X0, Y0);
    const seen = g.reachableFrom(X0, Y0);
    expect(seen.length).toBe(15);
    // contorna a parede por baixo: o canto oposto é alcançável
    expect(seen[g.key(X0 + 4, Y0)]).toBe(1);
    // a parede não
    expect(seen[g.key(X0 + 2, Y0)]).toBe(0);
    expect(seen[g.key(X0 + 2, Y0 + 1)]).toBe(0);
    // tudo o que foi marcado é um tile caminhável de dentro
    let count = 0;
    for (let i = 0; i < seen.length; i++) {
      if (!seen[i]) continue;
      count++;
      const { x, y } = g.at(i);
      expect(g.inside(x, y)).toBe(true);
      expect(g.walkable(x, y)).toBe(true);
    }
    expect(count).toBe(13);
    // partindo de um tile bloqueado ou de fora da caixa: nada
    expect(g.reachableFrom(X0 + 2, Y0).some((v) => v === 1)).toBe(false);
    expect(g.reachableFrom(0, 0).some((v) => v === 1)).toBe(false);
  });
});

describe('WalkGrid sem origem (chamadas antigas)', () => {
  it('new WalkGrid(w, h) continua com origem (0, 0) e as chaves de sempre', () => {
    const g = new WalkGrid(7, 3);
    expect([g.x0, g.y0, g.version]).toEqual([0, 0, 0]);
    expect(new WalkGrid(7, 3, 5).version).toBe(5);
    expect(g.key(3, 2)).toBe(2 * 7 + 3);
    expect(g.at(2 * 7 + 3)).toEqual({ x: 3, y: 2 });
    expect(g.inside(0, 0)).toBe(true);
    expect(g.inside(-1, 0)).toBe(false);
    expect(g.inside(7, 0)).toBe(false);
    g.set(6, 2, FREE);
    expect(g.get(6, 2)).toBe(FREE);
    expect(g.cells[2 * 7 + 6]).toBe(FREE);
  });
});
