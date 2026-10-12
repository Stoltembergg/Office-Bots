import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../../shared/types';
import type { Appearance } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { Character } from '../sim/character';
import { CAR_GAP, CAR_HALF_L, CROSS_MIN_RED_MS, EMOTIONS, GREEN_MS, lightAt, MAX_PEDS, RED_MS, redLeft, STOP_HOLD_MS, StreetLife, YELLOW_MS, type Car, type Crossing, type Pedestrian, type StreetGeometry } from './street-life';

const GEO: StreetGeometry = { crossX0: 624, crossX1: 672, zebras: [{ x0: 624, x1: 672, light: true }, { x0: 1000, x1: 1032, light: false }], northY: 523, southY: 635, lanes: [{ y: 560, dir: 1 }, { y: 600, dir: -1 }], stopEast: 612, stopWest: 684, vlanes: [], crossings: [] };

function makeChar(seed: number): Character {
  const info: AgentInfo = {
    id: `rua:${seed}`, kind: 'main', roomId: '', name: '', look: 'f', role: '', sessionId: '', account: '', status: 'idle', recent: [], tasks: [],
    startedAt: 0, lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed,
  };
  return new Character(info, {} as Appearance);
}

/** Carro da rua principal (os campos dos cruzamentos no padrão). */
function hcar(c: Omit<Car, 'axis' | 'stoppedAt' | 'cleared'> & Partial<Car>): Car {
  return { axis: 'h', stoppedAt: 0, cleared: NaN, ...c };
}

function life(seed = 1): StreetLife {
  return new StreetLife(GEO, makeChar, mulberry32(seed));
}

function ped(l: StreetLife, x: number, dir: 1 | -1, row: 'n' | 's', wantsCross = false): Pedestrian {
  const ch = makeChar(x);
  ch.x = x;
  ch.y = row === 'n' ? GEO.northY : GEO.southY;
  const p: Pedestrian = { ch, dir, row, state: 'walk', speed: 40, wantsCross, crossed: false, until: 0, nextIconAt: 0, talked: false, zebra: null, crossing: null };
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
    l.cars.push(hcar({ x: GEO.stopEast - 100, y: 560, dir: 1, speed: 60, v: 60, variant: 0 }));
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
    l.cars.push(hcar({ x: GEO.stopWest + 100, y: 600, dir: -1, speed: 60, v: 60, variant: 0 }));
    run(l, RED, 6000, RED);
    expect(l.cars[0].v).toBe(0);
    expect(l.cars[0].x).toBeGreaterThanOrEqual(GEO.stopWest);
    expect(l.cars[0].x).toBeLessThan(GEO.stopWest + 4);
  });

  it('no amarelo quem está em cima da linha passa, quem está longe freia', () => {
    const l = life();
    const yellow = GREEN_MS + 200;
    l.cars.push(hcar({ x: GEO.stopEast - 20, y: 560, dir: 1, speed: 60, v: 60, variant: 0 }), hcar({ x: GEO.stopEast - 90, y: 600, dir: 1, speed: 60, v: 60, variant: 1 }));
    run(l, yellow, 1500, yellow);
    expect(l.cars[0].x).toBeGreaterThan(GEO.stopEast);
    expect(l.cars[1].x).toBeLessThanOrEqual(GEO.stopEast);
  });

  it('fazem fila: o de trás para atrás do da frente', () => {
    const l = life();
    l.cars.push(hcar({ x: GEO.stopEast - 60, y: 560, dir: 1, speed: 60, v: 60, variant: 0 }), hcar({ x: GEO.stopEast - 160, y: 560, dir: 1, speed: 70, v: 70, variant: 1 }));
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

  it('não começa a atravessar com carro em cima da faixa nem com carro que ainda vai cruzá-la; só depois de livre', () => {
    const l = life();
    const p = ped(l, (GEO.crossX0 + GEO.crossX1) / 2 - 30, 1, 'n', true);
    run(l, 0, 2000, 0);
    expect(p.state).toBe('wait');
    const red = GREEN_MS + YELLOW_MS + 100;
    // carro parado em cima da faixa (passou da linha no fim do amarelo); o run sorteia carros, então a lista é zerada
    l.cars.length = 0;
    l.cars.push(hcar({ x: (GEO.crossX0 + GEO.crossX1) / 2, y: 0, dir: 1, speed: 0, v: 0, variant: 0 }));
    expect(l.crossingClear()).toBe(false);
    run(l, red, 300, red);
    expect(p.state).toBe('wait');
    // carro já além da faixa, indo embora: livre
    l.cars.length = 0;
    l.cars.push(hcar({ x: GEO.crossX1 + 200, y: 560, dir: 1, speed: 0, v: 0, variant: 0 }));
    expect(l.crossingClear()).toBe(true);
    // carro antes da linha de parada, vindo: ainda vai parar, livre
    l.cars.length = 0;
    l.cars.push(hcar({ x: GEO.stopEast - 100, y: 560, dir: 1, speed: 0, v: 0, variant: 0 }));
    expect(l.crossingClear()).toBe(true);
    // carro entre a linha de parada e a faixa, prestes a passar: ocupado
    l.cars.length = 0;
    l.cars.push(hcar({ x: GEO.stopEast + 2, y: 560, dir: 1, speed: 0, v: 0, variant: 0 }));
    expect(l.crossingClear()).toBe(false);
    l.cars.length = 0;
    run(l, red, 50, red);
    expect(p.state).toBe('cross');
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

describe('faixas sem sinal (cruzamentos)', () => {
  const Z = GEO.zebras[1];

  it('o pedestre que quer atravessar para na primeira faixa que encontra e, com a rua livre, atravessa', () => {
    const l = life();
    const p = ped(l, Z.x0 - 30, 1, 'n', true);
    run(l, 0, 3000, 0);
    expect(p.zebra).toBe(Z);
    expect(['cross', 'walk']).toContain(p.state);
    expect(p.crossed || p.state === 'cross').toBe(true);
  });

  it('com um carro perto da faixa (sem distância para frear) o pedestre espera na calçada', () => {
    const l = life();
    const p = ped(l, (Z.x0 + Z.x1) / 2, 1, 'n', true);
    l.cars.push(hcar({ x: Z.x0 - 50, y: 560, dir: 1, speed: 50, v: 50, variant: 0 }));
    l.update(0, 0.05, 0, 1400);
    expect(p.state).toBe('wait');
    // o carro passa e a faixa fica livre: aí atravessa
    l.cars.length = 0;
    l.update(0, 0.05, 0, 1400);
    expect(p.state).toBe('cross');
  });

  it('os carros param antes da linha enquanto há alguém atravessando e voltam a andar depois', () => {
    const l = life();
    const p = ped(l, (Z.x0 + Z.x1) / 2, 1, 'n', true);
    p.state = 'cross';
    const car = hcar({ x: Z.x0 - 12 - 90, y: 560, dir: 1 as const, speed: 50, v: 50, variant: 0 });
    l.cars.push(car);
    for (let i = 0; i < 300; i++) {
      p.state = 'cross';
      l.update(0, 0.05, 0, 1400);
    }
    expect(car.v).toBe(0);
    expect(car.x).toBeLessThan(Z.x0 - 12);
    p.state = 'walk';
    p.crossed = true;
    for (let i = 0; i < 20; i++) l.update(0, 0.05, 0, 1400);
    expect(car.v).toBeGreaterThan(0);
  });
});

describe('cruzamentos (ruas norte–sul)', () => {
  // quadrado do asfalto comum em x 1040..1120, y 544..624 (a rua principal de GEO); faixas da rua N–S nas calçadas
  const K: Crossing = { x0: 1040, x1: 1120, y0: 544, y1: 624, zebraN: { y0: 512, y1: 544 }, zebraS: { y0: 624, y1: 656 }, stopS: 500, stopN: 668, main: true };
  const GEOV: StreetGeometry = { ...GEO, vlanes: [{ x: 1060, dir: 1 }, { x: 1100, dir: -1 }], crossings: [K] };
  const lifeV = () => new StreetLife(GEOV, makeChar, mulberry32(1));
  const vcar = (y: number, dir: 1 | -1, speed = 60, extra: Partial<Car> = {}): Car => ({ axis: 'v', x: dir > 0 ? 1060 : 1100, y, dir, speed, v: speed, variant: 0, stoppedAt: 0, cleared: NaN, ...extra });
  /** Avança até o carro parar (v = 0) ou `ms`; devolve o instante. */
  const untilStopped = (l: StreetLife, c: Car, from: number, ms: number) => {
    let now = from;
    for (let t = 0; t < ms && c.v > 0; t += 50) {
      now = from + t;
      l.update(now, 0.05, 0, 1400, 0, 1000);
    }
    return now;
  };
  const runV = (l: StreetLife, from: number, ms: number) => {
    let now = from;
    for (let t = 0; t < ms; t += 50) {
      now = from + t;
      l.update(now, 0.05, 0, 1400, 0, 1000);
    }
    return now;
  };

  it('o carro da rua norte–sul para de verdade na linha do STOP e, com a principal livre, só segue depois de STOP_HOLD_MS', () => {
    const l = lifeV();
    const c = vcar(300, 1);
    l.cars.push(c);
    let now = untilStopped(l, c, 1000, 6000);
    expect(c.v).toBe(0);
    // a frente do carro (y + CAR_HALF_L) na linha de parada
    expect(Math.abs(c.y + CAR_HALF_L - K.stopS)).toBeLessThanOrEqual(4);
    const yStop = c.y;
    now = runV(l, now, STOP_HOLD_MS - 200);
    expect(c.y).toBe(yStop);
    runV(l, now, 3000);
    expect(c.y).toBeGreaterThan(K.y1);
  });

  it('não entra no quadrado com um carro da principal chegando sem distância para frear; entra quando ele passou', () => {
    const l = lifeV();
    const c = vcar(K.stopS - CAR_HALF_L, 1, 60, { v: 0, stoppedAt: 1 });
    const h = hcar({ x: K.x0 - 50, y: 560, dir: 1, speed: 0, v: 0, variant: 0 });
    l.cars.push(c, h);
    runV(l, 5000, 1000);
    expect(c.y).toBe(K.stopS - CAR_HALF_L);
    h.x = K.x1 + 40; // já passou, fora da margem do quadrado
    runV(l, 6000, 1000);
    expect(c.y).toBeGreaterThan(K.stopS);
  });

  it('o carro da principal cede a um carro norte–sul parado dentro do quadrado', () => {
    const l = lifeV();
    l.cars.push(vcar(584, 1, 0, { v: 0, cleared: K.stopS - CAR_HALF_L }));
    const h = hcar({ x: 880, y: 560, dir: 1, speed: 60, v: 60, variant: 0 });
    l.cars.push(h);
    untilStopped(l, h, 1000, 6000);
    expect(h.v).toBe(0);
    expect(h.x).toBeLessThanOrEqual(K.x0 - 2 * 16);
  });

  it('um carro norte–sul perto não trava quem atravessa a rua principal na faixa do cruzamento', () => {
    const l = lifeV();
    // faixa sem sinal da principal a leste do quadrado (x 1120..1152) e um carro norte–sul parado no STOP ao lado dela
    l.cars.push(vcar(K.stopN + CAR_HALF_L, -1, 60, { v: 0, stoppedAt: 1 }));
    const p = ped(l, 1136, 1, 'n', true);
    p.zebra = { x0: 1120, x1: 1152, light: false };
    p.state = 'wait';
    runV(l, 1000, 4000);
    expect(p.row).toBe('s');
    expect(p.state).toBe('walk');
  });

  it('o pedestre para na borda do asfalto da rua norte–sul com um carro chegando, atravessa quando ele está parado no STOP e o carro espera', () => {
    const l = lifeV();
    const c = vcar(400, 1);
    l.cars.push(c);
    const p = ped(l, 1000, 1, 'n');
    let now = runV(l, 1000, 1000);
    expect(p.state).toBe('waitv');
    expect(p.ch.x).toBe(K.x0 - 6);
    // enquanto o carro freia (a aproximação da linha leva uns segundos) o pedestre espera; no passo em que ele para, atravessa
    now = untilStopped(l, c, now, 8000);
    now = runV(l, now, 100);
    expect(p.state).toBe('crossv');
    expect(c.v).toBe(0);
    runV(l, now, 4000);
    expect(p.state).toBe('walk');
    expect(p.ch.x).toBeGreaterThan(K.x1);
    expect(c.y).toBeGreaterThan(K.stopS);
  });
});
