// Vida na rua (D4 de "rua viva"): pedestres passando na calçada, semáforo com faixa de pedestres na frente da
// entrada, carros que param no vermelho e seguem no verde (em fila), pedestres que só atravessam com o sinal
// fechado para os carros, e conversas de rua com emoções. Cruzamentos (D2 de "cruzamentos e campo"): carros nas
// ruas norte–sul param de verdade no STOP, só entram no quadrado com a rua principal livre e cedem a pedestres;
// dentro do quadrado, os da principal cedem a eles; pedestres esperam na borda do asfalto de uma rua norte–sul. Lógica pura (sem canvas) e sem estado no Sim: o
// renderer chama update() por frame e desenha `peds` (com drawCharacter) e `cars`. Os pedestres são
// personagens sem agente (ids `rua:…`), nunca em sim.chars: não têm nome, balão nem clique.
import type { IconName } from '../../art/api';
import { FOOT_DY, TILE, WALK_SPEED } from '../constants';
import { ENTRANCE_W, ENTRANCE_X, SIDEWALK_TY, type ExteriorLayout } from '../layout/exterior';
import type { Character } from '../sim/character';

export type Light = 'green' | 'yellow' | 'red';

/** Ciclo do semáforo dos carros (ms): verde → amarelo → vermelho. */
export const GREEN_MS = 9_000;
export const YELLOW_MS = 2_000;
export const RED_MS = 7_000;
const CYCLE_MS = GREEN_MS + YELLOW_MS + RED_MS;

/** Sinal para os carros no instante `now` (ciclo a partir de `t0`). */
export function lightAt(now: number, t0 = 0): Light {
  const t = (((now - t0) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  return t < GREEN_MS ? 'green' : t < GREEN_MS + YELLOW_MS ? 'yellow' : 'red';
}

/** Quanto falta (ms) do vermelho atual; 0 se o sinal não está vermelho. */
export function redLeft(now: number, t0 = 0): number {
  const t = (((now - t0) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  return t < GREEN_MS + YELLOW_MS ? 0 : CYCLE_MS - t;
}

/** Faixa de pedestres atravessando a rua principal (px de mundo): `light` = com semáforo (a da entrada); sem ele, quem manda é o pedestre (carros cedem). */
export interface Zebra {
  x0: number;
  x1: number;
  light: boolean;
}

/** Distância (px) da linha de parada até a borda da faixa. */
const STOP_GAP = 12;
/** Meio comprimento (px) do carro ao longo do sentido em que anda (sprite 36 de comprimento). */
export const CAR_HALF_L = 18;
/** Parada obrigatória no STOP (ms) antes de olhar a rua principal. */
export const STOP_HOLD_MS = 700;
/** Pedestre a menos disto (px) da borda do asfalto de uma rua norte–sul para e olha os carros. */
const PED_EDGE = 6;
/** Um carro a menos que isto (px) da linha de parada já não consegue frear para quem vai atravessar numa faixa sem sinal. */
export const YIELD_SAFE_DIST = 70;

/** Cruzamento de uma rua norte–sul com uma leste–oeste (px). */
export interface Crossing {
  /** Asfalto comum. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Faixas de pedestres atravessando a rua norte–sul, nas calçadas norte e sul da rua leste–oeste. */
  zebraN: { y0: number; y1: number };
  zebraS: { y0: number; y1: number };
  /** Linhas de parada (px): quem vai para o sul para antes de zebraN; quem vai para o norte, antes de zebraS. */
  stopS: number;
  stopN: number;
  /** A rua leste–oeste tem carros (a principal): quem entra no quadrado precisa dela livre. */
  main: boolean;
}

export interface StreetGeometry {
  /** Faixa de pedestres (px de mundo): bordas oeste e leste, na frente da entrada. */
  crossX0: number;
  crossX1: number;
  /** Todas as faixas da rua principal: a da entrada (com semáforo) e as dos cruzamentos com as ruas norte–sul. */
  zebras: readonly Zebra[];
  /** Linhas (y dos pés, px) por onde os pedestres andam: calçada norte e calçada sul da rua principal. */
  northY: number;
  southY: number;
  /** Faixas dos carros (y em px) e sentido. */
  lanes: readonly { y: number; dir: 1 | -1 }[];
  /** Linhas de parada (px): quem vai para leste para antes da borda oeste da faixa, e vice-versa. */
  stopEast: number;
  stopWest: number;
  /** Faixas das ruas norte–sul (x do centro, px; +1 = sul). */
  vlanes: readonly { x: number; dir: 1 | -1 }[];
  crossings: readonly Crossing[];
}

export function streetGeometry(ex: ExteriorLayout): StreetGeometry {
  const main = ex.streets.find((s) => s.cars) ?? ex.streets[0];
  const south = main.rect.y;
  const crossX0 = ENTRANCE_X * TILE;
  const crossX1 = (ENTRANCE_X + ENTRANCE_W) * TILE;
  // cruzamentos da rua principal: uma faixa de 2 tiles de cada lado da rua norte–sul (nas calçadas dela), sem sinal
  const zebras: Zebra[] = [{ x0: crossX0, x1: crossX1, light: true }];
  const crossings: Crossing[] = [];
  for (const i of ex.intersections) {
    const main = i.y === south + 4;
    if (main) zebras.push({ x0: (i.x - 2) * TILE, x1: i.x * TILE, light: false }, { x0: (i.x + 5) * TILE, x1: (i.x + 7) * TILE, light: false });
    const zebraN = { y0: (i.y - 2) * TILE, y1: i.y * TILE };
    const zebraS = { y0: (i.y + 5) * TILE, y1: (i.y + 7) * TILE };
    crossings.push({ x0: i.x * TILE, x1: (i.x + 5) * TILE, y0: i.y * TILE, y1: (i.y + 5) * TILE, zebraN, zebraS, stopS: zebraN.y0 - STOP_GAP, stopN: zebraS.y1 + STOP_GAP, main });
  }
  return {
    crossX0,
    crossX1,
    zebras,
    northY: SIDEWALK_TY * TILE + FOOT_DY,
    southY: (south + 10) * TILE + FOOT_DY,
    lanes: ex.lanes,
    stopEast: crossX0 - STOP_GAP,
    stopWest: crossX1 + STOP_GAP,
    vlanes: ex.vlanes,
    crossings,
  };
}

export interface Car {
  /** h: anda em x (x = centro, y = base do sprite); v: anda em y (y = centro, x = centro da faixa). */
  axis: 'h' | 'v';
  x: number;
  y: number;
  dir: 1 | -1;
  /** Parado na linha de um STOP desde (ms); 0 = andando. */
  stoppedAt: number;
  /** Linha (px) do STOP já cumprido: não para de novo nela. */
  cleared: number;
  /** Velocidade de cruzeiro e a atual (px/s; 0 = parado no sinal ou na fila). */
  speed: number;
  v: number;
  variant: number;
}

export type PedState = 'walk' | 'wait' | 'cross' | 'talk' | 'waitv' | 'crossv';

export interface Pedestrian {
  ch: Character;
  dir: 1 | -1;
  row: 'n' | 's';
  state: PedState;
  speed: number;
  /** Vai atravessar na faixa quando chegar nela (uma vez). */
  wantsCross: boolean;
  crossed: boolean;
  /** Fim da conversa (ms). */
  until: number;
  nextIconAt: number;
  /** Já conversou (ou cruzou com alguém sem parar): não para de novo. */
  talked: boolean;
  /** Faixa em que espera e atravessa. */
  zebra: Zebra | null;
  /** Rua norte–sul em cuja borda espera / que está atravessando. */
  crossing: Crossing | null;
}

/** Emoções das conversas de rua (ícones sobre a cabeça). */
export const EMOTIONS: readonly IconName[] = ['heart', 'chat', 'idea', 'music', 'wave', 'star'];

export const MAX_PEDS = 10;
/** Distância mínima (px) até o carro da frente na mesma faixa. */
export const CAR_GAP = 44;
/** A partir desta distância (px) da linha de parada o carro começa a frear com o sinal fechado. */
const BRAKE_DIST = 110;
/** Só começa a atravessar se ainda sobra este tanto de vermelho (a travessia leva ~2,3 s). */
export const CROSS_MIN_RED_MS = 2_800;
/** Folga somada ao tempo de travessia calculado pela velocidade do pedestre. */
export const CROSS_SLACK_MS = 600;
/** Margem (px) de cada lado da faixa que precisa estar sem carro para alguém começar a atravessar. */
export const CROSS_CLEAR_PX = 20;
/** Dois pedestres a menos de isto (px), em sentidos opostos, podem parar para conversar. */
const TALK_DIST = 14;
const TALK_CHANCE = 0.35;

export class StreetLife {
  peds: Pedestrian[] = [];
  cars: Car[] = [];
  private nextPedAt = 0;
  private nextCarAt = 0;
  private nextVCarAt = 0;
  private seq = 0;

  constructor(
    public geo: StreetGeometry,
    private readonly makeChar: (seed: number) => Character,
    private readonly rng: () => number = Math.random,
    readonly t0 = 0,
  ) {}

  light(now: number): Light {
    return lightAt(now, this.t0);
  }

  has(id: string): boolean {
    return this.peds.some((p) => p.ch.id === id);
  }

  /** Um passo; x0..x1 (e y0..y1 para as ruas norte–sul) é a extensão (px) em que carros e pedestres existem (base ∪ visão). */
  update(now: number, dt: number, x0: number, x1: number, y0 = -1e9, y1 = 1e9): void {
    this.updateCars(now, dt, x0, x1, y0, y1);
    this.updatePeds(now, dt, x0, x1);
  }

  private updateCars(now: number, dt: number, x0: number, x1: number, y0: number, y1: number): void {
    if (now >= this.nextCarAt && this.geo.lanes.length) {
      this.nextCarAt = now + 4000 + this.rng() * 9000;
      const lane = this.geo.lanes[Math.floor(this.rng() * this.geo.lanes.length)];
      const speed = 38 + this.rng() * 30;
      this.cars.push({ axis: 'h', x: lane.dir > 0 ? x0 : x1, y: lane.y, dir: lane.dir, speed, v: speed, variant: Math.floor(this.rng() * 6), stoppedAt: 0, cleared: NaN });
    }
    if (now >= this.nextVCarAt && this.geo.vlanes.length && y1 - y0 < 1e8) {
      this.nextVCarAt = now + 6000 + this.rng() * 10000;
      const lane = this.geo.vlanes[Math.floor(this.rng() * this.geo.vlanes.length)];
      const speed = 34 + this.rng() * 26;
      this.cars.push({ axis: 'v', x: lane.x, y: lane.dir > 0 ? y0 : y1, dir: lane.dir, speed, v: speed, variant: Math.floor(this.rng() * 6), stoppedAt: 0, cleared: NaN });
    }
    const light = this.light(now);
    const step = Math.min(dt, 0.1);
    for (const c of this.cars) {
      if (c.axis === 'v') {
        this.stepVCar(c, now, step);
        continue;
      }
      let want = c.speed;
      // um carro da rua norte–sul que saiu do STOP e ainda não atravessou o quadrado: para antes da faixa que o antecede
      for (const k of this.geo.crossings) {
        if (!k.main || !this.carCommitted(k)) continue;
        const stop = c.dir > 0 ? k.x0 - 2 * TILE - STOP_GAP : k.x1 + 2 * TILE + STOP_GAP;
        const toStop = (stop - c.x) * c.dir;
        if (toStop > 0 && toStop < BRAKE_DIST) want = Math.min(want, Math.max(0, (toStop - 2) * 1.2));
      }
      for (const z of this.geo.zebras) {
        const stop = c.dir > 0 ? z.x0 - STOP_GAP : z.x1 + STOP_GAP;
        // distância até a linha de parada (positiva = ainda não chegou; quem já passou segue)
        const toStop = (stop - c.x) * c.dir;
        // sinal fechado, ou alguém atravessando a faixa: o carro para antes da linha
        const mustStop = z.light ? light === 'red' || (light === 'yellow' && toStop > 30) || this.pedOn(z) : this.pedOn(z);
        if (mustStop && toStop > 0 && toStop < BRAKE_DIST) want = Math.min(want, Math.max(0, (toStop - 2) * 1.2));
      }
      // fila: não encosta no carro da frente na mesma faixa
      for (const o of this.cars) {
        if (o === c || o.axis !== 'h' || o.y !== c.y) continue;
        const gap = (o.x - c.x) * c.dir;
        if (gap > 0 && gap < CAR_GAP + 60) want = Math.min(want, Math.max(0, (gap - CAR_GAP) * 1.5));
      }
      // abaixo de 1 px/s é parado (senão a frenagem só se aproxima do zero)
      c.v = want < 1 ? 0 : want;
      c.x += c.dir * c.v * step;
    }
    this.cars = this.cars.filter((c) => (c.axis === 'h' ? c.x >= x0 - 10 && c.x <= x1 + 10 : c.y >= y0 - 10 && c.y <= y1 + 10));
  }

  /**
   * Carro de uma rua norte–sul: cede a pedestre nas duas faixas de cada cruzamento, para de verdade na linha do STOP
   * (STOP_HOLD_MS) e só entra no quadrado com ele livre (nenhum carro da principal dentro nem chegando sem distância
   * para frear, nenhum outro carro norte–sul dentro) e sem pedestre nas faixas. Fila como na principal.
   */
  private stepVCar(c: Car, now: number, step: number): void {
    let want = c.speed;
    for (const k of this.geo.crossings) {
      if (c.x < k.x0 || c.x > k.x1) continue;
      for (const [z, side] of [
        [k.zebraN, 'n'],
        [k.zebraS, 's'],
      ] as const) {
        const stop = c.dir > 0 ? z.y0 - STOP_GAP - CAR_HALF_L : z.y1 + STOP_GAP + CAR_HALF_L;
        const toStop = (stop - c.y) * c.dir;
        if (this.pedOnV(k, side) && toStop > 0 && toStop < BRAKE_DIST) want = Math.min(want, Math.max(0, (toStop - 2) * 1.2));
      }
      const line = c.dir > 0 ? k.stopS - CAR_HALF_L : k.stopN + CAR_HALF_L;
      const toLine = (line - c.y) * c.dir;
      if (c.cleared === line || toLine < -4 || toLine > BRAKE_DIST) continue;
      if (c.stoppedAt === 0) {
        want = Math.min(want, Math.max(0, (toLine - 2) * 1.2));
        if (toLine <= 3 && c.v < 1) c.stoppedAt = now;
        continue;
      }
      const go = now - c.stoppedAt >= STOP_HOLD_MS && this.boxClear(k, c) && !this.pedOnV(k, 'n') && !this.pedOnV(k, 's');
      if (go) {
        c.cleared = line;
        c.stoppedAt = 0;
      } else want = 0;
    }
    for (const o of this.cars) {
      if (o === c || o.axis !== 'v' || o.x !== c.x) continue;
      const gap = (o.y - c.y) * c.dir;
      if (gap > 0 && gap < CAR_GAP + 60) want = Math.min(want, Math.max(0, (gap - CAR_GAP) * 1.5));
    }
    c.v = want < 1 ? 0 : want;
    c.y += c.dir * c.v * step;
  }

  /** Um carro norte–sul que já cumpriu o STOP deste cruzamento (ou está dentro do quadrado) e ainda não saiu dele. */
  carCommitted(k: Crossing): boolean {
    return this.cars.some((o) => {
      if (o.axis !== 'v' || o.x < k.x0 || o.x > k.x1) return false;
      const inBox = o.y + CAR_HALF_L > k.y0 && o.y - CAR_HALF_L < k.y1;
      const line = o.dir > 0 ? k.stopS - CAR_HALF_L : k.stopN + CAR_HALF_L;
      const beforeExit = o.dir > 0 ? o.y - CAR_HALF_L < k.y1 : o.y + CAR_HALF_L > k.y0;
      return inBox || (o.cleared === line && beforeExit);
    });
  }

  /**
   * Quadrado livre para o carro norte–sul `c` entrar: nenhum outro norte–sul dentro; nenhum carro da principal dentro
   * (com margem), nem chegando a menos de YIELD_SAFE_DIST, nem perto o bastante para alcançar o quadrado antes de `c`
   * terminar de atravessá-lo na velocidade dele (o da principal pode estar acelerando: conta a de cruzeiro).
   */
  boxClear(k: Crossing, c: Car): boolean {
    const toExit = c.dir > 0 ? k.y1 - (c.y - CAR_HALF_L) : c.y + CAR_HALF_L - k.y0;
    const tCross = toExit / Math.max(c.speed, 1) + 0.4;
    return this.cars.every((o) => {
      if (o === c) return true;
      if (o.axis === 'v') return !(o.x >= k.x0 && o.x <= k.x1 && o.y + CAR_HALF_L > k.y0 - 4 && o.y - CAR_HALF_L < k.y1 + 4);
      if (!k.main) return true;
      if (o.x >= k.x0 - CROSS_CLEAR_PX && o.x <= k.x1 + CROSS_CLEAR_PX) return false;
      const passed = o.dir > 0 ? o.x > k.x1 : o.x < k.x0;
      if (passed) return true;
      const toBox = (o.dir > 0 ? k.x0 - o.x : o.x - k.x1) - CAR_HALF_L;
      return toBox > YIELD_SAFE_DIST && toBox > Math.max(o.v, o.speed) * tCross + 10;
    });
  }

  /** Alguém atravessando a rua norte–sul agora na faixa norte ou sul do cruzamento. */
  pedOnV(k: Crossing, side: 'n' | 's'): boolean {
    return this.peds.some((p) => p.state === 'crossv' && p.row === side && p.ch.x >= k.x0 - 4 && p.ch.x <= k.x1 + 4);
  }

  /**
   * Um pedestre na calçada `side` pode começar a atravessar a rua norte–sul: nenhum carro dela em cima da faixa (com
   * margem) nem chegando a ela em movimento sem distância para frear; um parado na linha do STOP espera por ele.
   */
  vClear(k: Crossing, side: 'n' | 's'): boolean {
    const z = side === 'n' ? k.zebraN : k.zebraS;
    return this.cars.every((c) => {
      if (c.axis !== 'v' || c.x < k.x0 || c.x > k.x1) return true;
      // em cima da faixa bloqueia; perto dela (a linha do STOP fica a STOP_GAP) só bloqueia em movimento
      if (c.y + CAR_HALF_L > z.y0 && c.y - CAR_HALF_L < z.y1) return false;
      if (c.v > 0 && c.y + CAR_HALF_L > z.y0 - CROSS_CLEAR_PX && c.y - CAR_HALF_L < z.y1 + CROSS_CLEAR_PX) return false;
      const passed = c.dir > 0 ? c.y - CAR_HALF_L > z.y1 : c.y + CAR_HALF_L < z.y0;
      if (passed) return true;
      const toZebra = c.dir > 0 ? z.y0 - (c.y + CAR_HALF_L) : c.y - CAR_HALF_L - z.y1;
      return toZebra > YIELD_SAFE_DIST || c.v === 0;
    });
  }

  private updatePeds(now: number, dt: number, x0: number, x1: number): void {
    if (now >= this.nextPedAt && this.peds.length < MAX_PEDS) {
      this.nextPedAt = now + 3000 + this.rng() * 5000;
      this.spawnPed(x0, x1);
    }
    const light = this.light(now);
    for (const p of this.peds) {
      const ch = p.ch;
      ch.animT += dt * 1000;
      if (ch.icon && now >= ch.iconUntil) ch.icon = null;
      if (ch.alpha < 1) ch.alpha = Math.min(1, ch.alpha + dt * 1.5);
      switch (p.state) {
        case 'walk': {
          ch.setPose('walk');
          ch.dir = p.dir > 0 ? 'right' : 'left';
          const s = p.speed * dt;
          const z = p.wantsCross && !p.crossed ? this.geo.zebras.find((q) => Math.abs(ch.x - (q.x0 + q.x1) / 2) <= s + 1) : undefined;
          if (z) {
            ch.x = (z.x0 + z.x1) / 2;
            p.zebra = z;
            p.state = 'wait';
            break;
          }
          // borda do asfalto de uma rua norte–sul: para e olha os carros
          const edge = (k: Crossing) => (p.dir > 0 ? k.x0 - PED_EDGE : k.x1 + PED_EDGE);
          const k = this.geo.crossings.find((q) => q.main && (ch.x - edge(q)) * p.dir < 0 && (ch.x + p.dir * s - edge(q)) * p.dir >= 0);
          if (k) {
            ch.x = edge(k);
            p.crossing = k;
            p.state = 'waitv';
            break;
          }
          ch.x += p.dir * s;
          this.maybeTalk(p, now);
          break;
        }
        case 'waitv': {
          ch.setPose('stand');
          ch.dir = p.dir > 0 ? 'right' : 'left';
          if (p.crossing && this.vClear(p.crossing, p.row)) p.state = 'crossv';
          break;
        }
        case 'crossv': {
          ch.setPose('walk');
          ch.dir = p.dir > 0 ? 'right' : 'left';
          ch.x += p.dir * p.speed * dt;
          const k = p.crossing!;
          const past = p.dir > 0 ? ch.x > k.x1 + PED_EDGE : ch.x < k.x0 - PED_EDGE;
          if (past) {
            p.state = 'walk';
            p.crossing = null;
          }
          break;
        }
        case 'wait': {
          // na beira da faixa, de frente para a rua, até o sinal fechar para os carros, com tempo de sobra para
          // a travessia deste pedestre (os lentos precisam de mais que CROSS_MIN_RED_MS) e com a faixa livre:
          // um carro que passou da linha de parada no fim do amarelo ainda está em cima dela
          ch.setPose('stand');
          ch.dir = p.row === 'n' ? 'down' : 'up';
          const target = p.row === 'n' ? this.geo.southY : this.geo.northY;
          const need = Math.max(CROSS_MIN_RED_MS, (Math.abs(target - ch.y) / p.speed) * 1000 + CROSS_SLACK_MS);
          const z = p.zebra ?? this.geo.zebras[0];
          const go = z.light ? light === 'red' && redLeft(now, this.t0) >= need && this.crossingClear(z) : this.crossingClear(z, YIELD_SAFE_DIST);
          if (go) p.state = 'cross';
          break;
        }
        case 'cross': {
          const target = p.row === 'n' ? this.geo.southY : this.geo.northY;
          const dy = target - ch.y;
          ch.setPose('walk');
          ch.dir = dy > 0 ? 'down' : 'up';
          const s = p.speed * dt;
          if (Math.abs(dy) <= s) {
            ch.y = target;
            p.row = p.row === 'n' ? 's' : 'n';
            p.crossed = true;
            p.state = 'walk';
          } else ch.y += Math.sign(dy) * s;
          break;
        }
        case 'talk': {
          ch.setPose('talk');
          if (now >= p.nextIconAt) {
            p.nextIconAt = now + 900 + this.rng() * 900;
            ch.setIcon(EMOTIONS[Math.floor(this.rng() * EMOTIONS.length)], 1400, now);
          }
          if (now >= p.until) {
            p.state = 'walk';
            p.talked = true;
            ch.icon = null;
          }
          break;
        }
      }
    }
    this.peds = this.peds.filter((p) => p.ch.x >= x0 - 40 && p.ch.x <= x1 + 40);
  }

  /** Dois que se cruzam na mesma calçada podem parar frente a frente por 3–6 s, trocando emoções. */
  /** Alguém atravessando a faixa agora (os carros cedem). */
  pedOn(z: Zebra): boolean {
    return this.peds.some((p) => p.state === 'cross' && p.ch.x >= z.x0 - 4 && p.ch.x <= z.x1 + 4);
  }

  /**
   * Nenhum carro em cima da faixa (com margem) nem prestes a passar por ela: só quem já passou ou ainda vai parar na
   * linha. Numa faixa sem sinal, `minStop` é a distância mínima (px) que o carro precisa ter da linha para conseguir frear.
   */
  crossingClear(z: Zebra = this.geo.zebras[0], minStop = 0): boolean {
    return this.cars.every((c) => {
      // só os carros da rua principal passam por estas faixas; um norte–sul tem x fixo e nunca "passaria"
      if (c.axis !== 'h') return true;
      if (c.x >= z.x0 - CROSS_CLEAR_PX && c.x <= z.x1 + CROSS_CLEAR_PX) return false;
      const passed = c.dir > 0 ? c.x > z.x1 : c.x < z.x0;
      if (passed) return true;
      const stop = c.dir > 0 ? z.x0 - STOP_GAP : z.x1 + STOP_GAP;
      return (stop - c.x) * c.dir > minStop;
    });
  }

  private maybeTalk(p: Pedestrian, now: number): void {
    if (p.talked) return;
    for (const q of this.peds) {
      if (q === p || q.state !== 'walk' || q.talked || q.row !== p.row || q.dir === p.dir) continue;
      if (Math.abs(q.ch.x - p.ch.x) > TALK_DIST) continue;
      if (this.rng() >= TALK_CHANCE) {
        // se cruzam sem parar (e não tentam de novo um passo adiante)
        p.talked = true;
        q.talked = true;
        return;
      }
      const until = now + 3000 + this.rng() * 3000;
      for (const [a, b] of [
        [p, q],
        [q, p],
      ] as const) {
        a.state = 'talk';
        a.until = until;
        a.nextIconAt = now + this.rng() * 600;
        a.ch.dir = b.ch.x > a.ch.x ? 'right' : 'left';
        a.ch.setPose('talk');
      }
      return;
    }
  }

  private spawnPed(x0: number, x1: number): void {
    const seed = ((this.seq++ * 2654435761) ^ Math.floor(this.rng() * 1e9)) >>> 0;
    const ch = this.makeChar(seed);
    const dir: 1 | -1 = this.rng() < 0.5 ? 1 : -1;
    const row: 'n' | 's' = this.rng() < 0.5 ? 'n' : 's';
    ch.x = dir > 0 ? x0 - 20 : x1 + 20;
    ch.y = row === 'n' ? this.geo.northY : this.geo.southY;
    ch.alpha = 0;
    ch.dir = dir > 0 ? 'right' : 'left';
    ch.setPose('walk');
    this.peds.push({ ch, dir, row, state: 'walk', speed: WALK_SPEED * 0.8 * ch.speedK, wantsCross: this.rng() < 0.35, crossed: false, until: 0, nextIconAt: 0, talked: false, zebra: null, crossing: null });
  }
}
