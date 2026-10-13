import { describe, expect, it } from 'vitest';
import { PathFinder } from './astar';
import { BLOCKED, FREE, SEAT, WalkGrid } from './grid';

function gridFrom(rows: string[]): WalkGrid {
  const g = new WalkGrid(rows[0].length, rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => g.set(x, y, c === '#' ? BLOCKED : c === 's' ? SEAT : FREE)));
  return g;
}

function pairs(out: number[]): [number, number][] {
  const r: [number, number][] = [];
  for (let i = 0; i < out.length; i += 2) r.push([out[i], out[i + 1]]);
  return r;
}

describe('A* 4 direções', () => {
  it('encontra o caminho mais curto contornando paredes', () => {
    const g = gridFrom(['.....', '.###.', '...#.', '.#...']);
    const pf = new PathFinder(g);
    const out: number[] = [];
    expect(pf.find(0, 0, 4, 3, out)).toBe(true);
    const p = pairs(out);
    expect(p[p.length - 1]).toEqual([4, 3]);
    expect(p.length).toBe(7);
    // passos adjacentes em 4 direções e só por células livres
    let prev: [number, number] = [0, 0];
    for (const [x, y] of p) {
      expect(Math.abs(x - prev[0]) + Math.abs(y - prev[1])).toBe(1);
      expect(g.walkable(x, y)).toBe(true);
      prev = [x, y];
    }
  });

  it('retorna false quando não há caminho e true (vazio) quando já está no destino', () => {
    const g = gridFrom(['..#..', '..#..', '..#..']);
    const pf = new PathFinder(g);
    const out: number[] = [1, 2, 3];
    expect(pf.find(0, 0, 4, 0, out)).toBe(false);
    expect(out).toEqual([]);
    expect(pf.find(1, 1, 1, 1, out)).toBe(true);
    expect(out).toEqual([]);
  });

  it('evita assentos quando há alternativa, mas pode terminar num assento', () => {
    const g = gridFrom(['.s.', '...']);
    const pf = new PathFinder(g);
    const out: number[] = [];
    pf.find(0, 0, 2, 0, out);
    expect(pairs(out).some(([x, y]) => x === 1 && y === 0)).toBe(false);
    pf.find(0, 0, 1, 0, out);
    expect(pairs(out)).toEqual([[1, 0]]);
  });

  it('pode partir de uma célula bloqueada (personagem num assento/elevador)', () => {
    const g = gridFrom(['#..', '...']);
    const pf = new PathFinder(g);
    const out: number[] = [];
    expect(pf.find(0, 0, 2, 1, out)).toBe(true);
  });

  it('prefere trajetos com menos curvas', () => {
    const g = gridFrom(['......', '......', '......', '......']);
    const pf = new PathFinder(g);
    const out: number[] = [];
    pf.find(0, 0, 5, 3, out);
    const p = pairs(out);
    let turns = 0;
    let last = -1;
    let prev: [number, number] = [0, 0];
    for (const c of p) {
      const d = c[0] !== prev[0] ? 0 : 1;
      if (last >= 0 && d !== last) turns++;
      last = d;
      prev = c;
    }
    expect(turns).toBeLessThanOrEqual(1);
  });

  it('reaproveita buffers entre buscas sem vazar estado', () => {
    const g = gridFrom(['.....', '.....']);
    const pf = new PathFinder(g);
    const out: number[] = [];
    for (let i = 0; i < 500; i++) {
      expect(pf.find(0, 0, 4, 1, out)).toBe(true);
      expect(out.length / 2).toBe(5);
    }
  });

  it('acha o tile caminhável mais próximo', () => {
    const g = gridFrom(['###', '#.#', '###']);
    expect(g.nearestWalkable(0, 0)).toEqual({ x: 1, y: 1 });
    expect(g.nearestWalkable(1, 1)).toEqual({ x: 1, y: 1 });
  });

  it('acha caminho numa grade com origem negativa (tiles com x e y negativos)', () => {
    // a mesma planta do 1º caso, mas com a grade começando em (−16, −41)
    const g = WalkGrid.forRect({ x: -16, y: -41, w: 5, h: 4 });
    ['.....', '.###.', '...#.', '.#...'].forEach((r, y) => [...r].forEach((c, x) => g.set(x - 16, y - 41, c === '#' ? BLOCKED : FREE)));
    const pf = new PathFinder(g);
    const out: number[] = [];
    expect(pf.find(-16, -41, -12, -38, out)).toBe(true);
    const p = pairs(out);
    expect(p[p.length - 1]).toEqual([-12, -38]);
    expect(p.length).toBe(7);
    let prev: [number, number] = [-16, -41];
    for (const [x, y] of p) {
      expect(Math.abs(x - prev[0]) + Math.abs(y - prev[1])).toBe(1);
      expect(g.inside(x, y)).toBe(true);
      expect(g.walkable(x, y)).toBe(true);
      prev = [x, y];
    }
    // o (0, 0) do mundo fica fora desta grade: não é destino nem partida válidos
    expect(pf.find(-16, -41, 0, 0, out)).toBe(false);
    expect(pf.find(0, 0, -12, -38, out)).toBe(false);
  });
});
