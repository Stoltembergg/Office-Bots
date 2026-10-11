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

export interface StreetGeometry {
  /** Faixa de pedestres (px de mundo): bordas oeste e leste, na frente da entrada. */
  crossX0: number;
  crossX1: number;
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
  return {
    crossX0,
    crossX1,
    northY: SIDEWALK_TY * TILE + FOOT_DY,
    southY: (south + 10) * TILE + FOOT_DY,
    lanes: ex.lanes,
    stopEast: crossX0 - 12,
    stopWest: crossX1 + 12,
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
      const stop = c.dir > 0 ? this.geo.stopEast : this.geo.stopWest;
      // distância até a linha de parada (positiva = ainda não chegou; quem já passou segue)
      const toStop = (stop - c.x) * c.dir;
      let want = c.speed;
      const mustStop = light === 'red' || (light === 'yellow' && toStop > 30);
      if (mustStop && toStop > 0 && toStop < BRAKE_DIST) want = Math.min(want, Math.max(0, (toStop - 2) * 1.2));
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
    const cx = (this.geo.crossX0 + this.geo.crossX1) / 2;
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
          if (p.wantsCross && !p.crossed && Math.abs(ch.x - cx) <= s + 1) {
            ch.x = cx;
            p.state = 'wait';
            break;
          }
          ch.x += p.dir * s;
          this.maybeTalk(p, now);
          break;
        }
        case 'wait': {
          // na beira da faixa, de frente para a rua, até o sinal fechar para os carros (com tempo de sobra)
          ch.setPose('stand');
          ch.dir = p.row === 'n' ? 'down' : 'up';
          if (light === 'red' && redLeft(now, this.t0) >= CROSS_MIN_RED_MS) p.state = 'cross';
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
    this.peds.push({ ch, dir, row, state: 'walk', speed: WALK_SPEED * 0.8 * ch.speedK, wantsCross: this.rng() < 0.35, crossed: false, until: 0, nextIconAt: 0, talked: false });
  }
}
