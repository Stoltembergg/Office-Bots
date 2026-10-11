// Área externa: grama, árvores, calçada e rua; pátio/jardim nos slots sem sala. Tudo parte do
// retângulo de pé do prédio (worldBounds), não do envelope.
import type { WallStyle } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { BUILDING_H, COL_W, CORRIDOR_Y, EXT_EAST, EXT_NORTH, EXT_SOUTH, EXT_WEST, SOUTH_Y, TILE } from '../constants';
import { blockColumnRect, blockRect, isCoreColumn, PRINCIPAL, slotAddress, slotAt, worldBounds, type BlockLayout } from './geometry';
import type { ExteriorProp, FloorPatch, TileRect, WallItemPlacement, WallSegment } from './types';

export const EXTERIOR_WALL: WallStyle = { base: '#cfc8bd', trim: '#8a8174', pattern: 'brick', exterior: true };

/** Entrada decorativa ao norte da recepção (tiles): borda oeste do caminho de pedra e da porta decorativa. */
export const ENTRANCE_X = 39.5;
export const ENTRANCE_W = 3;
/** Caminho de pedra em y −4..0. */
export const ENTRANCE_DEPTH = 4;
/** Zona (tiles) que árvores e arbustos deixam livre em volta da entrada: x 34..48, y ≥ −8. */
const ENTRANCE_CLEAR_X0 = 34;
const ENTRANCE_CLEAR_X1 = 48;
const ENTRANCE_CLEAR_Y = -8;

export interface ExteriorLayout {
  /** Limites da área desenhada (tiles). */
  bounds: TileRect;
  floors: FloorPatch[];
  props: ExteriorProp[];
  /** Faixas da rua (y em px) e sentido (+1 = leste, -1 = oeste). */
  lanes: { y: number; dir: 1 | -1 }[];
  /** Linha central da rua (px), para as faixas tracejadas. */
  streetY: number;
  streetH: number;
}

/** Fechamento do corredor e pátio de um slot sem sala. */
export interface SlotShell {
  slot: number;
  rect: TileRect;
  walls: WallSegment[];
  windows: WallItemPlacement[];
  floors: FloorPatch[];
  props: ExteriorProp[];
}

export function layoutExterior(blocks: readonly BlockLayout[]): ExteriorLayout {
  const world = worldBounds(blocks);
  const bounds: TileRect = { x: world.x - EXT_WEST, y: world.y - EXT_NORTH, w: world.w + EXT_WEST + EXT_EAST, h: world.h + EXT_NORTH + EXT_SOUTH };
  const px = (t: number) => t * TILE;
  const floors: FloorPatch[] = [];
  const props: ExteriorProp[] = [];
  const rng = mulberry32(0xc0de);
  const west = world.x;
  const east = world.x + world.w;
  const south = world.y + world.h;
  /** Árvore ou arbusto ao norte: descartado se cair na zona da entrada (o rng já foi consumido). */
  const plantNorth = (p: ExteriorProp) => {
    if (p.x >= px(ENTRANCE_CLEAR_X0) && p.x <= px(ENTRANCE_CLEAR_X1) && p.y >= px(ENTRANCE_CLEAR_Y)) return;
    props.push(p);
  };

  floors.push({ kind: 'grass', x: px(bounds.x), y: px(bounds.y), w: px(bounds.w), h: px(bounds.h), seed: 11 });
  // calçada e rua ao sul, em toda a largura da área
  floors.push({ kind: 'sidewalk', x: px(bounds.x), y: px(south + 2), w: px(bounds.w), h: px(2), seed: 12 });
  floors.push({ kind: 'street', x: px(bounds.x), y: px(south + 4), w: px(bounds.w), h: px(5), seed: 13 });
  floors.push({ kind: 'sidewalk', x: px(bounds.x), y: px(south + 9), w: px(bounds.w), h: px(2), seed: 14 });
  // caminho de pedra da entrada, ao norte da recepção (diante da porta decorativa em x 39,5..42,5)
  floors.push({ kind: 'sidewalk', x: px(ENTRANCE_X), y: px(-ENTRANCE_DEPTH), w: px(ENTRANCE_W), h: px(ENTRANCE_DEPTH), seed: 15 });

  // árvores ao norte (fileira com variação) e a oeste/leste
  for (let x = bounds.x + 1; x < bounds.x + bounds.w - 1; x += 4 + Math.floor(rng() * 3)) {
    plantNorth({ kind: rng() < 0.25 ? 'pine' : 'tree', x: px(x) + Math.floor(rng() * 8), y: px(-3) - Math.floor(rng() * 20), seed: Math.floor(rng() * 1e9) });
    if (rng() < 0.6) plantNorth({ kind: 'bush', x: px(x + 2), y: px(-1) - 2, seed: Math.floor(rng() * 1e9) });
  }
  // bosque ao norte: fileiras irregulares cada vez mais esparsas
  for (const [row, gap] of [
    [-6, 5],
    [-10, 6],
    [-14, 8],
  ] as const) {
    for (let x = bounds.x + 2; x < bounds.x + bounds.w - 1; x += gap + Math.floor(rng() * 4)) {
      plantNorth({ kind: rng() < 0.3 ? 'pine' : 'tree', x: px(x) + Math.floor(rng() * 8), y: px(row) - Math.floor(rng() * 12), seed: Math.floor(rng() * 1e9) });
    }
  }
  for (const side of [-1, 1]) {
    for (const band of [0, 7, 13]) {
      const baseX = side < 0 ? west - 6 - band : east + 4 + band;
      for (let y = 1; y < BUILDING_H; y += 3 + Math.floor(rng() * 3)) {
        props.push({ kind: rng() < 0.3 ? 'pine' : 'tree', x: px(baseX + Math.floor(rng() * 5)), y: px(y + 1), seed: Math.floor(rng() * 1e9) });
        if (band === 0 && rng() < 0.5) props.push({ kind: 'bush', x: px(side < 0 ? west - 2 : east + 1), y: px(y + 2), seed: Math.floor(rng() * 1e9) });
      }
    }
  }
  // cerca viva + flores ao longo da fachada sul e postes na calçada; diante de cada vaga de
  // projeto, o trecho do caminho do jardim só tem cerca quando há sala ali (nunca diante do miolo)
  const env = blockRect(PRINCIPAL);
  for (let x = west; x < east; x += 2) {
    const col = Math.floor((x - env.x) / COL_W);
    const lx = x - env.x - col * COL_W;
    const gate = !isCoreColumn(PRINCIPAL, col) && (lx === 6 || lx === 8) ? slotAt(PRINCIPAL, col, 'south') : undefined;
    props.push({ kind: (x / 2) % 3 === 1 ? 'flowers' : 'hedge', x: px(x) + TILE, y: px(south + 1) + 10, seed: x * 7 + 3, whenRoom: gate });
  }
  for (let x = bounds.x + 4; x < bounds.x + bounds.w; x += 10) {
    props.push({ kind: 'lamp', x: px(x), y: px(south + 3) + 6, seed: x });
  }
  for (const row of [13, 17, 21]) {
    for (let x = bounds.x + 3; x < bounds.x + bounds.w - 2; x += 6 + Math.floor(rng() * 5)) {
      props.push({ kind: rng() < 0.2 ? 'pine' : 'tree', x: px(x) + Math.floor(rng() * 10), y: px(south + row) + Math.floor(rng() * 10), seed: Math.floor(rng() * 1e9) });
      if (rng() < 0.3) props.push({ kind: 'bush', x: px(x + 3), y: px(south + row + 1), seed: Math.floor(rng() * 1e9) });
    }
  }
  // banco e totem com a marca ao lado do caminho de pedra, na entrada norte
  props.push({ kind: 'bench', x: px(45), y: px(-1) + 6, seed: 1 });
  props.push({ kind: 'totem', x: px(37) + 8, y: px(-1), seed: 2 });

  const streetY = px(south + 4);
  const streetH = px(5);
  return {
    bounds,
    floors,
    props,
    lanes: [
      { y: streetY + Math.round(streetH * 0.36), dir: 1 },
      { y: streetY + Math.round(streetH * 0.86), dir: -1 },
    ],
    streetY,
    streetH,
  };
}

/**
 * Parede externa + jardim de um slot vazio: deck de madeira com mesas e guarda-sóis, canteiros e caminho.
 * `ends` diz quais pontas da coluna são pontas de pé do prédio: ali o corredor é fechado com um `cap`.
 */
export function slotShell(slot: number, ends: { west: boolean; east: boolean }): SlotShell {
  const addr = slotAddress(slot);
  const side = addr.side;
  const rect = blockColumnRect(addr.block, addr.col, side);
  const x0 = rect.x * TILE;
  const rng = mulberry32(0x9a7d + slot * 31);
  const walls: WallSegment[] = [];
  const windows: WallItemPlacement[] = [];
  const floors: FloorPatch[] = [];
  const props: ExteriorProp[] = [];
  const W = COL_W * TILE;
  const T = (n: number) => n * TILE;
  const seed = () => Math.floor(rng() * 1e9);
  /** Deck de madeira com borda de pedra (tiles locais). */
  const deck = (lx: number, ly: number, w: number, h: number) => {
    floors.push({ kind: 'sidewalk', x: x0 + T(lx), y: T(rect.y + ly), w: T(w), h: T(h), seed: slot + 7 });
    floors.push({ kind: 'wood', x: x0 + T(lx) + 4, y: T(rect.y + ly) + 4, w: T(w) - 8, h: T(h) - 8, seed: slot + 8 });
  };

  if (side === 'north') {
    // fachada com janelas fechando o corredor (linhas 10–11)
    const fy = (CORRIDOR_Y - 2) * TILE;
    walls.push({ kind: 'face', x: x0, y: fy, w: W, style: EXTERIOR_WALL });
    [3, 8, 13].forEach((cx, i) =>
      windows.push({ id: `shell:${slot}:janela${i}`, kind: 'window', cx: x0 + cx * TILE, baseY: CORRIDOR_Y * TILE, on: 'face', order: 0 }),
    );
    if (ends.east) walls.push({ kind: 'cap', x: x0 + W - TILE / 2, y: fy, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    if (ends.west) walls.push({ kind: 'cap', x: x0, y: fy, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    // caminho do gramado até o deck, deck no meio e canteiros sob as janelas
    floors.push({ kind: 'sidewalk', x: x0 + T(7), y: T(rect.y), w: T(2), h: T(3), seed: slot });
    deck(3, 3, 10, 5);
    props.push({ kind: 'parasol', x: x0 + T(5.5), y: T(rect.y + 6) + 4, seed: seed(), slot });
    props.push({ kind: 'parasol', x: x0 + T(10.5), y: T(rect.y + 6) + 4, seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(3.5), y: T(rect.y + 3) + 6, seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(12.5), y: T(rect.y + 3) + 6, seed: seed(), slot });
    for (const cx of [3, 8, 13]) props.push({ kind: 'flowers', x: x0 + T(cx), y: T(rect.y + 9) + 12, seed: slot * 3 + cx, slot });
    props.push({ kind: 'tree', x: x0 + T(1) + 4, y: T(rect.y + 3), seed: seed(), slot });
    props.push({ kind: rng() < 0.5 ? 'pine' : 'tree', x: x0 + T(15) - 4, y: T(rect.y + 3) + 6, seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(1) + 8, y: T(rect.y + 8), seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(15) - 8, y: T(rect.y + 8), seed: seed(), slot });
  } else {
    // mureta externa fechando o corredor (linha 17) e jardim abaixo, ligado à calçada da rua
    walls.push({ kind: 'south', x: x0, y: SOUTH_Y * TILE, w: W, style: EXTERIOR_WALL });
    if (ends.east) walls.push({ kind: 'cap', x: x0 + W - TILE / 2, y: SOUTH_Y * TILE, w: TILE / 2, h: TILE, style: EXTERIOR_WALL });
    if (ends.west) walls.push({ kind: 'cap', x: x0, y: SOUTH_Y * TILE, w: TILE / 2, h: TILE, style: EXTERIOR_WALL });
    floors.push({ kind: 'sidewalk', x: x0 + T(7), y: T(rect.y + 1), w: T(2), h: T(rect.h - 1), seed: slot });
    // trecho entre a fachada e a calçada: só existe enquanto o slot está vazio (a cerca viva fecha)
    props.push({ kind: 'paving', x: x0 + T(7), y: T(BUILDING_H), seed: slot, slot });
    deck(3, 3.5, 10, 5);
    props.push({ kind: 'parasol', x: x0 + T(5.5), y: T(rect.y + 6.5) + 4, seed: seed(), slot });
    props.push({ kind: 'parasol', x: x0 + T(10.5), y: T(rect.y + 6.5) + 4, seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(3.5), y: T(rect.y + 4) + 4, seed: seed(), slot });
    props.push({ kind: 'bush', x: x0 + T(12.5), y: T(rect.y + 4) + 4, seed: seed(), slot });
    for (const cx of [3, 13]) props.push({ kind: 'flowers', x: x0 + T(cx), y: T(rect.y + 2), seed: slot * 3 + cx, slot });
    props.push({ kind: 'bench', x: x0 + T(4), y: T(rect.y + 10) + 6, seed: slot, slot });
    props.push({ kind: 'bench', x: x0 + T(12), y: T(rect.y + 10) + 6, seed: slot + 1, slot });
    props.push({ kind: 'tree', x: x0 + T(1) + 6, y: T(rect.y + 11), seed: seed(), slot });
    props.push({ kind: rng() < 0.5 ? 'pine' : 'tree', x: x0 + T(15) - 6, y: T(rect.y + 11) + 4, seed: seed(), slot });
    props.push({ kind: 'rock', x: x0 + T(14), y: T(rect.y + 2) + 4, seed: slot + 3, slot });
  }
  return { slot, rect, walls, windows, floors, props };
}
