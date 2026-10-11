import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../../shared/types';
import type { Appearance } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { Character } from '../sim/character';
import { CAR_GAP, CROSS_MIN_RED_MS, EMOTIONS, GREEN_MS, lightAt, MAX_PEDS, RED_MS, redLeft, StreetLife, YELLOW_MS, type Pedestrian, type StreetGeometry } from './street-life';

const GEO: StreetGeometry = { crossX0: 624, crossX1: 672, northY: 523, southY: 635, lanes: [{ y: 560, dir: 1 }, { y: 600, dir: -1 }], stopEast: 612, stopWest: 684 };

function makeChar(seed: number): Character {
  const info: AgentInfo = {
    id: `rua:${seed}`, kind: 'main', roomId: '', name: '', look: 'f', role: '', sessionId: '', account: '', status: 'idle', recent: [], tasks: [],
    startedAt: 0, lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed,
  };
  return new Character(info, {} as Appearance);
}

function life(seed = 1): StreetLife {
  return new StreetLife(GEO, makeChar, mulberry32(seed));
}

function ped(l: StreetLife, x: number, dir: 1 | -1, row: 'n' | 's', wantsCross = false): Pedestrian {
  const ch = makeChar(x);
  ch.x = x;
  ch.y = row === 'n' ? GEO.northY : GEO.southY;
  const p: Pedestrian = { ch, dir, row, state: 'walk', speed: 40, wantsCross, crossed: false, until: 0, nextIconAt: 0, talked: false };
  l.peds.push(p);
  return p;
}

/** Avança `ms` em passos de 50 ms sem deixar o semáforo sair do instante `at` quando `freeze` é dado. */
function run(l: StreetLife, from: number, ms: number, freeze?: number): number {
  let now = from;
  for (let t = 0; t < ms; t += 50) {
    now = from + t;
    l.update(freeze ?? now, 0.05, 0, 1400);
  }
  return now;
}

describe('semáforo', () => {
  it('ciclo verde → amarelo → vermelho e quanto falta do vermelho', () => {
    expect(lightAt(0)).toBe('green');
    expect(lightAt(GREEN_MS - 1)).toBe('green');
    expect(lightAt(GREEN_MS)).toBe('yellow');
    expect(lightAt(GREEN_MS + YELLOW_MS)).toBe('red');
    expect(lightAt(GREEN_MS + YELLOW_MS + RED_MS)).toBe('green');
    expect(redLeft(GREEN_MS + YELLOW_MS)).toBe(RED_MS);
    expect(redLeft(GREEN_MS + YELLOW_MS + 1000)).toBe(RED_MS - 1000);
    expect(redLeft(100)).toBe(0);
    expect(lightAt(-1)).toBe('red');
  });
});

describe('carros', () => {
  const RED = GREEN_MS + YELLOW_MS + 500;

  it('param antes da faixa no vermelho e seguem no verde', () => {
    const l = life();
    l.cars.push({ x: GEO.stopEast - 100, y: 560, dir: 1, speed: 60, v: 60, variant: 0 });
    run(l, RED, 6000, RED);
    const car = l.cars[0];
    expect(car.v).toBe(0);
    expect(car.x).toBeLessThanOrEqual(GEO.stopEast);
    expect(car.x).toBeGreaterThan(GEO.stopEast - 4);
    // verde: cruza a faixa
    run(l, 0, 3000, 0);
    expect(l.cars[0].x).toBeGreaterThan(GEO.crossX1);
  });

  it('quem vai para oeste para do outro lado da faixa', () => {
    const l = life();
    l.cars.push({ x: GEO.stopWest + 100, y: 600, dir: -1, speed: 60, v: 60, variant: 0 });
    run(l, RED, 6000, RED);
    expect(l.cars[0].v).toBe(0);
    expect(l.cars[0].x).toBeGreaterThanOrEqual(GEO.stopWest);
    expect(l.cars[0].x).toBeLessThan(GEO.stopWest + 4);
  });

  it('no amarelo quem está em cima da linha passa, quem está longe freia', () => {
    const l = life();
    const yellow = GREEN_MS + 200;
    l.cars.push({ x: GEO.stopEast - 20, y: 560, dir: 1, speed: 60, v: 60, variant: 0 }, { x: GEO.stopEast - 90, y: 600, dir: 1, speed: 60, v: 60, variant: 1 });
    run(l, yellow, 1500, yellow);
    expect(l.cars[0].x).toBeGreaterThan(GEO.stopEast);
    expect(l.cars[1].x).toBeLessThanOrEqual(GEO.stopEast);
  });

  it('fazem fila: o de trás para atrás do da frente', () => {
    const l = life();
    l.cars.push({ x: GEO.stopEast - 60, y: 560, dir: 1, speed: 60, v: 60, variant: 0 }, { x: GEO.stopEast - 160, y: 560, dir: 1, speed: 70, v: 70, variant: 1 });
    run(l, RED, 8000, RED);
    const [a, b] = l.cars;
    expect(a.v).toBe(0);
    expect(b.v).toBe(0);
    expect(a.x - b.x).toBeGreaterThanOrEqual(CAR_GAP - 1);
    expect(a.x - b.x).toBeLessThan(CAR_GAP + 12);
  });

  it('nascem numa borda e somem na outra', () => {
    const l = life(7);
    run(l, 0, 60_000);
    expect(l.cars.length).toBeGreaterThan(0);
    for (const c of l.cars) {
      expect(c.x).toBeGreaterThanOrEqual(-10);
      expect(c.x).toBeLessThanOrEqual(1410);
    }
  });
});

describe('pedestres', () => {
  it('quem quer atravessar espera na beira da faixa até o vermelho dos carros, atravessa e segue na outra calçada', () => {
    const l = life();
    const p = ped(l, (GEO.crossX0 + GEO.crossX1) / 2 - 30, 1, 'n', true);
    run(l, 0, 2000, 0); // verde
    expect(p.state).toBe('wait');
    expect(p.ch.y).toBe(GEO.northY);
    expect(p.ch.dir).toBe('down');
    expect(p.ch.pose).toBe('stand');
    // vermelho quase acabando: ainda não atravessa
    const lateRed = GREEN_MS + YELLOW_MS + RED_MS - CROSS_MIN_RED_MS + 100;
    run(l, lateRed, 500, lateRed);
    expect(p.state).toBe('wait');
    // vermelho recém-aberto: atravessa (7 tiles) e continua para leste na calçada sul
    const red = GREEN_MS + YELLOW_MS + 100;
    run(l, red, 600, red);
    expect(p.state).toBe('cross');
    expect(p.ch.dir).toBe('down');
    expect(p.ch.y).toBeGreaterThan(GEO.northY);
    run(l, red, 4000, red);
    expect(p.crossed).toBe(true);
    expect(p.row).toBe('s');
    expect(p.state).toBe('walk');
    expect(p.ch.y).toBe(GEO.southY);
    expect(p.ch.dir).toBe('right');
  });

  it('quem não quer atravessar passa direto pela faixa', () => {
    const l = life();
    const p = ped(l, GEO.crossX0 - 30, 1, 'n', false);
    run(l, 0, 3000, 0);
    expect(p.state).toBe('walk');
    expect(p.ch.x).toBeGreaterThan(GEO.crossX1);
  });

  it('dois que se cruzam podem parar para conversar, com emoções, e depois seguem', () => {
    // rng fixo abaixo da chance de conversa
    const l = new StreetLife(GEO, makeChar, () => 0.1);
    const a = ped(l, 200, 1, 'n');
    const b = ped(l, 300, -1, 'n');
    run(l, 0, 1500);
    expect(a.state).toBe('talk');
    expect(b.state).toBe('talk');
    expect(a.ch.pose).toBe('talk');
    expect(a.ch.dir).toBe('right');
    expect(b.ch.dir).toBe('left');
    expect(a.ch.icon === null || EMOTIONS.includes(a.ch.icon)).toBe(true);
    run(l, 1500, 1000);
    expect(EMOTIONS).toContain(a.ch.icon);
    run(l, 2500, 7000);
    expect(a.state).toBe('walk');
    expect(b.state).toBe('walk');
    expect(a.talked).toBe(true);
    expect(b.talked).toBe(true);
    expect(a.ch.icon).toBeNull();
  });

  it('com o sorteio acima da chance, cruzam sem parar e não tentam de novo', () => {
    const l = new StreetLife(GEO, makeChar, () => 0.9);
    const a = ped(l, 200, 1, 'n');
    const b = ped(l, 300, -1, 'n');
    run(l, 0, 3000, 0);
    expect(a.state).toBe('walk');
    expect(a.talked).toBe(true);
    expect(a.ch.x).toBeGreaterThan(b.ch.x);
  });

  it('não conversam em calçadas diferentes nem no mesmo sentido', () => {
    const l = new StreetLife(GEO, makeChar, () => 0.1);
    const a = ped(l, 200, 1, 'n');
    const b = ped(l, 300, -1, 's');
    const c = ped(l, 220, 1, 'n');
    run(l, 0, 3000, 0);
    expect([a.state, b.state, c.state]).toEqual(['walk', 'walk', 'walk']);
  });

  it('nascem fora da extensão, aparecem andando e nunca passam de MAX_PEDS', () => {
    const l = life(3);
    let max = 0;
    for (let t = 0; t < 120_000; t += 50) {
      l.update(t, 0.05, 0, 1400);
      max = Math.max(max, l.peds.length);
    }
    expect(max).toBeGreaterThan(2);
    expect(max).toBeLessThanOrEqual(MAX_PEDS);
    for (const p of l.peds) {
      expect(p.ch.id.startsWith('rua:')).toBe(true);
      expect([GEO.northY, GEO.southY]).toContain(p.ch.y === GEO.northY || p.ch.y === GEO.southY ? p.ch.y : p.row === 'n' ? GEO.northY : GEO.southY);
      expect(p.ch.alpha).toBeGreaterThan(0);
    }
  });
});
