// Vida na rua (D4 de "rua viva"): pedestres passando na calçada, semáforo com faixa de pedestres na frente da
// entrada, carros que param no vermelho e seguem no verde (em fila), pedestres que só atravessam com o sinal
// fechado para os carros, e conversas de rua com emoções. Lógica pura (sem canvas) e sem estado no Sim: o
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
/** Um carro a menos que isto (px) da linha de parada já não consegue frear para quem vai atravessar numa faixa sem sinal. */
export const YIELD_SAFE_DIST = 70;

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
}

export function streetGeometry(ex: ExteriorLayout): StreetGeometry {
  const main = ex.streets.find((s) => s.cars) ?? ex.streets[0];
  const south = main.rect.y;
  const crossX0 = ENTRANCE_X * TILE;
  const crossX1 = (ENTRANCE_X + ENTRANCE_W) * TILE;
  // cruzamentos da rua principal: uma faixa de 2 tiles de cada lado da rua norte–sul (nas calçadas dela), sem sinal
  const zebras: Zebra[] = [{ x0: crossX0, x1: crossX1, light: true }];
  for (const i of ex.intersections) {
    if (i.y !== south + 4) continue;
    zebras.push({ x0: (i.x - 2) * TILE, x1: i.x * TILE, light: false }, { x0: (i.x + 5) * TILE, x1: (i.x + 7) * TILE, light: false });
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
  };
}

export interface Car {
  x: number;
  y: number;
  dir: 1 | -1;
  /** Velocidade de cruzeiro e a atual (px/s; 0 = parado no sinal ou na fila). */
  speed: number;
  v: number;
  variant: number;
}

export type PedState = 'walk' | 'wait' | 'cross' | 'talk';

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

  /** Um passo; x0..x1 é a extensão horizontal (px) em que carros e pedestres existem (base ∪ visão). */
  update(now: number, dt: number, x0: number, x1: number): void {
    this.updateCars(now, dt, x0, x1);
    this.updatePeds(now, dt, x0, x1);
  }

  private updateCars(now: number, dt: number, x0: number, x1: number): void {
    if (now >= this.nextCarAt && this.geo.lanes.length) {
      this.nextCarAt = now + 4000 + this.rng() * 9000;
      const lane = this.geo.lanes[Math.floor(this.rng() * this.geo.lanes.length)];
      const speed = 38 + this.rng() * 30;
      this.cars.push({ x: lane.dir > 0 ? x0 : x1, y: lane.y, dir: lane.dir, speed, v: speed, variant: Math.floor(this.rng() * 6) });
    }
    const light = this.light(now);
    const step = Math.min(dt, 0.1);
    for (const c of this.cars) {
      let want = c.speed;
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
        if (o === c || o.y !== c.y) continue;
        const gap = (o.x - c.x) * c.dir;
        if (gap > 0 && gap < CAR_GAP + 60) want = Math.min(want, Math.max(0, (gap - CAR_GAP) * 1.5));
      }
      // abaixo de 1 px/s é parado (senão a frenagem só se aproxima do zero)
      c.v = want < 1 ? 0 : want;
      c.x += c.dir * c.v * step;
    }
    this.cars = this.cars.filter((c) => c.x >= x0 - 10 && c.x <= x1 + 10);
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
          ch.x += p.dir * s;
          this.maybeTalk(p, now);
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
    this.peds.push({ ch, dir, row, state: 'walk', speed: WALK_SPEED * 0.8 * ch.speedK, wantsCross: this.rng() < 0.35, crossed: false, until: 0, nextIconAt: 0, talked: false, zebra: null });
  }
}
