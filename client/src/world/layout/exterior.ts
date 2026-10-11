// Área externa: grama, árvores, calçada e rua; pátio/jardim nos slots sem sala. Tudo parte do
// retângulo de pé do prédio (worldBounds), não do envelope.
import type { WallStyle } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { BUILDING_H, COL_W, EXT_EAST, EXT_NORTH, EXT_SOUTH, EXT_WEST, ROOM_H, TILE } from '../constants';
import { blockColumnRect, blockRect, BRIDGE_W, bridgesFor, DOOR_LX, inRect, isCoreColumn, PRINCIPAL, slotAddress, slotAt, STREET_W, streetX, worldBounds, type BlockId, type BlockLayout, type BridgeLayout, type Side } from './geometry';
import type { ExteriorProp, FloorPatch, TileRect, WallItemPlacement, WallSegment } from './types';

export const EXTERIOR_WALL: WallStyle = { base: '#cfc8bd', trim: '#8a8174', pattern: 'brick', exterior: true };

/** Entrada do prédio (D9): porta de 3 tiles na parede sul da recepção (coluna 2 do principal, lx 7..10 → x 39..42). */
export const ENTRANCE_X = blockRect(PRINCIPAL).x + 2 * COL_W + DOOR_LX;
export const ENTRANCE_W = BRIDGE_W;
/** Caminho de pedra da porta (y 29) até a calçada (y 31): 2 tiles. */
export const ENTRANCE_DEPTH = 2;
/** Tile da porta de entrada (dentro da recepção, meio da abertura de 3 tiles): por onde todos chegam e vão embora. */
export const ENTRANCE_DOOR = { tx: ENTRANCE_X + 1, ty: blockRect(PRINCIPAL).y + BUILDING_H - 1 } as const;
/** Linha da calçada (segunda linha da calçada norte da rua principal) por onde os personagens chegam e vão. */
export const SIDEWALK_TY = ENTRANCE_DOOR.ty + 1 + ENTRANCE_DEPTH + 1;

/** Rua (tiles): perfil da spec 1.6 — h: linhas 2–3 e 9–10 calçada, 4–8 asfalto; v: colunas 1–2 e 8–9 calçada, 3–7 asfalto. */
export interface Street {
  axis: 'h' | 'v';
  rect: TileRect;
  /** Só a rua principal tem carros (lanes). */
  cars: boolean;
}

export interface ExteriorLayout {
  /** Limites da área desenhada (tiles). */
  bounds: TileRect;
  floors: FloorPatch[];
  props: ExteriorProp[];
  /** Faixas da rua principal (y em px) e sentido (+1 = leste, -1 = oeste). */
  lanes: { y: number; dir: 1 | -1 }[];
  /** Linha central da rua principal (px), para as faixas tracejadas. */
  streetY: number;
  streetH: number;
  /** Todas as ruas (D5): principal, norte (com bloco em by = −1) e norte–sul (uma por coluna de blocos |bx| ≥ 1). */
  streets: Street[];
}

/** Fechamento do corredor e pátio de um slot sem sala. */
export interface SlotShell {
  slot: number;
  rect: TileRect;
  /** Lado do corredor em que a vaga fica (norte: fachada com janelas; sul: mureta). */
  side: Side;
  walls: WallSegment[];
  windows: WallItemPlacement[];
  floors: FloorPatch[];
  props: ExteriorProp[];
}

/** Calçada + asfalto de uma rua (tiles): onde nada de jardim entra (D5). */
function pavedRect(s: Street): TileRect {
  return s.axis === 'h' ? { x: s.rect.x, y: s.rect.y + 2, w: s.rect.w, h: 9 } : { x: s.rect.x + 1, y: s.rect.y, w: 9, h: s.rect.h };
}

/** Lados de um bloco que dão para uma rua (D5): a cerca viva e o paving dos pátios ficam só deles. */
export function streetSides(b: BlockId, northStreet: boolean): readonly Side[] {
  if (b.by === 1) return ['north'];
  if (b.by === -1) return ['south'];
  return northStreet ? ['south', 'north'] : ['south'];
}

/** Gerador determinístico por posição (tiles): a mesma árvore sai no mesmo lugar não importa o tamanho do mundo. */
const at = (x: number, y: number, salt: number) => mulberry32(((x * 73856093) ^ (y * 19349663) ^ salt) >>> 0);

export function layoutExterior(blocks: readonly BlockLayout[], bridges: readonly BridgeLayout[] = bridgesFor(blocks)): ExteriorLayout {
  const world = worldBounds(blocks, bridges);
  const bounds: TileRect = { x: world.x - EXT_WEST, y: world.y - EXT_NORTH, w: world.w + EXT_WEST + EXT_EAST, h: world.h + EXT_NORTH + EXT_SOUTH };
  const px = (t: number) => t * TILE;
  const floors: FloorPatch[] = [];
  const props: ExteriorProp[] = [];
  const west = world.x;
  const east = world.x + world.w;
  // a rua principal fica ao sul do PRINCIPAL (não do retângulo de pé): com anexos ao sul, o mundo cresce e a rua não desce
  const main = blockRect(PRINCIPAL);
  const south = main.y + main.h;
  const northStreet = blocks.some((b) => b.id.by === -1);
  const streets: Street[] = [{ axis: 'h', rect: { x: bounds.x, y: south, w: bounds.w, h: STREET_W }, cars: true }];
  if (northStreet) streets.push({ axis: 'h', rect: { x: bounds.x, y: main.y - STREET_W, w: bounds.w, h: STREET_W }, cars: false });
  for (const bx of [...new Set(blocks.map((b) => b.id.bx))].filter((bx) => bx !== 0).sort((a, b) => a - b)) {
    streets.push({ axis: 'v', rect: { x: streetX(bx), y: bounds.y, w: STREET_W, h: bounds.h }, cars: false });
  }
  const paved = streets.map(pavedRect);
  /** Meia-largura (px) dos sprites com copa: a base pode ficar fora do bloco e a copa invadir a parede lateral. */
  const HALF_W: Partial<Record<ExteriorProp['kind'], number>> = { tree: 18, pine: 14 };
  /**
   * Um prop só entra se o tile da sua base não cai num bloco de pé, num trecho de passarela (spec 4) nem na calçada ou
   * asfalto de uma rua (D5; `onStreet` libera o mobiliário da calçada), e a copa não encosta num bloco.
   */
  const place = (p: ExteriorProp, onStreet = false) => {
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    if (blocks.some((b) => inRect(b.rect, tx, ty))) return;
    if (bridges.some((br) => br.rects.some((r) => inRect(r, tx, ty)))) return;
    if (!onStreet && paved.some((r) => inRect(r, tx, ty))) return;
    const h = HALF_W[p.kind] ?? 0;
    if (h && blocks.some((b) => ty >= b.rect.y && ty < b.rect.y + b.rect.h && p.x + h > b.rect.x * TILE && p.x - h < (b.rect.x + b.rect.w) * TILE)) return;
    props.push(p);
  };
  floors.push({ kind: 'grass', x: px(bounds.x), y: px(bounds.y), w: px(bounds.w), h: px(bounds.h), seed: 11 });
  // calçadas de todas as ruas antes de todo o asfalto: nos cruzamentos o asfalto fica por cima
  streets.forEach((s, i) => {
    const r = s.rect;
    if (s.axis === 'h') {
      floors.push({ kind: 'sidewalk', x: px(r.x), y: px(r.y + 2), w: px(r.w), h: px(2), seed: 12 + 10 * i });
      floors.push({ kind: 'sidewalk', x: px(r.x), y: px(r.y + 9), w: px(r.w), h: px(2), seed: 14 + 10 * i });
    } else {
      floors.push({ kind: 'sidewalk', x: px(r.x + 1), y: px(r.y), w: px(2), h: px(r.h), seed: 12 + 10 * i });
      floors.push({ kind: 'sidewalk', x: px(r.x + 8), y: px(r.y), w: px(2), h: px(r.h), seed: 14 + 10 * i });
    }
  });
  streets.forEach((s, i) => {
    const r = s.rect;
    if (s.axis === 'h') floors.push({ kind: 'street', x: px(r.x), y: px(r.y + 4), w: px(r.w), h: px(5), seed: 13 + 10 * i });
    else floors.push({ kind: 'street', x: px(r.x + 3), y: px(r.y), w: px(5), h: px(r.h), seed: 13 + 10 * i });
  });
  // caminho de pedra da entrada: da porta sul da recepção (y 29) até a calçada (y 31), atravessando a cerca viva
  floors.push({ kind: 'sidewalk', x: px(ENTRANCE_X), y: px(south), w: px(ENTRANCE_W), h: px(ENTRANCE_DEPTH), seed: 15 });

  // árvores e arbustos por posição (D5): candidatos de 4 em 4 tiles em x (grade alinhada a múltiplos de 4 do mundo),
  // cada um com o seu gerador semeado por (x, fileira). Faixas relativas ao retângulo de pé do mundo.
  const x0 = Math.floor(bounds.x / 4) * 4;
  const x1 = bounds.x + bounds.w;
  /** Uma fileira horizontal de árvores: `density` por candidato, `kinds` chance de pinheiro, `yJitter` px para cima. */
  const row = (ty: number, density: number, pine: number, yJitter: number, bush?: { chance: number; dy: number }) => {
    for (let x = x0; x < x1; x += 4) {
      const r = at(x, ty, 0x7a);
      if (r() >= density) continue;
      place({ kind: r() < pine ? 'pine' : 'tree', x: px(x) + Math.floor(r() * 8), y: px(ty) - Math.floor(r() * yJitter), seed: Math.floor(r() * 1e9) });
      if (bush && r() < bush.chance) place({ kind: 'bush', x: px(x + 2), y: px(ty + bush.dy) - 2, seed: Math.floor(r() * 1e9) });
    }
  };
  // norte: fileira cheia junto ao topo do mundo e bosque cada vez mais esparso
  const top = world.y;
  row(top - 3, 0.8, 0.25, 20, { chance: 0.6, dy: 2 });
  row(top - 6, 0.6, 0.3, 12);
  row(top - 10, 0.5, 0.3, 12);
  row(top - 14, 0.4, 0.3, 12);
  // sul: abaixo da rua principal ou do fundo do mundo, o que for mais ao sul
  const bottom = Math.max(world.y + world.h, south + STREET_W);
  for (const dy of [1, 5, 9]) {
    const ty = bottom + dy;
    for (let x = x0; x < x1; x += 4) {
      const r = at(x, ty, 0x5b);
      if (r() >= 0.55) continue;
      place({ kind: r() < 0.2 ? 'pine' : 'tree', x: px(x) + Math.floor(r() * 10), y: px(ty) + Math.floor(r() * 10), seed: Math.floor(r() * 1e9) });
      if (r() < 0.3) place({ kind: 'bush', x: px(x + 3), y: px(ty + 1), seed: Math.floor(r() * 1e9) });
    }
  }
  // laterais: três bandas a oeste e a leste do mundo, candidatos em y múltiplos de 3
  for (const side of [-1, 1] as const) {
    for (const band of [0, 7, 13]) {
      const baseX = side < 0 ? west - 6 - band : east + 4 + band;
      for (let y = Math.ceil((world.y + 1) / 3) * 3; y < world.y + world.h; y += 3) {
        const r = at(baseX, y, 0x3c);
        if (r() >= 0.7) continue;
        place({ kind: r() < 0.3 ? 'pine' : 'tree', x: px(baseX + Math.floor(r() * 5)), y: px(y + 1), seed: Math.floor(r() * 1e9) });
        if (band === 0 && r() < 0.5) place({ kind: 'bush', x: px(side < 0 ? west - 2 : east + 1), y: px(y + 2), seed: Math.floor(r() * 1e9) });
      }
    }
  }
  // cerca viva + flores diante de cada bloco, de cada lado com rua (D5), ao longo do retângulo de pé; diante de cada
  // vaga de projeto, o trecho do caminho do jardim só tem cerca quando há sala ali (nunca diante do miolo). As peças
  // sob uma passarela saem (place); diante da entrada do prédio (caminho de pedra, x 39..42) a cerca do principal abre.
  for (const b of blocks) {
    const env = b.envelope;
    const entrance = b.id.bx === 0 && b.id.by === 0;
    for (const side of streetSides(b.id, northStreet)) {
      const y = side === 'south' ? px(env.y + BUILDING_H + 1) + 10 : px(env.y - 1) + 10;
      for (let x = b.rect.x; x < b.rect.x + b.rect.w; x += 2) {
        if (entrance && side === 'south' && x + 1 < ENTRANCE_X + ENTRANCE_W && x + 3 > ENTRANCE_X) continue;
        const col = Math.floor((x - env.x) / COL_W);
        const lx = x - env.x - col * COL_W;
        const gate = !isCoreColumn(b.id, col) && (lx === 6 || lx === 8) ? slotAt(b.id, col, side) : undefined;
        place({ kind: (x / 2) % 3 === 1 ? 'flowers' : 'hedge', x: px(x) + TILE, y, seed: x * 7 + 3, whenRoom: gate });
      }
    }
  }
  // postes: calçada norte da rua principal e calçada sul da rua norte, de 10 em 10 tiles numa grade fixa do mundo (não
  // mudam de lugar quando o mundo cresce para oeste); nenhum no asfalto das ruas norte–sul
  const asphaltV = streets.filter((s) => s.axis === 'v').map((s) => ({ x0: s.rect.x + 3, x1: s.rect.x + 8 }));
  // (x ≡ 4 mod 10: no principal ficam em 34 e 44, longe do totem em 36 e do banco em 46)
  for (let x = Math.floor(bounds.x / 10) * 10 + 4; x < bounds.x + bounds.w; x += 10) {
    if (x < bounds.x || asphaltV.some((a) => x >= a.x0 && x < a.x1)) continue;
    place({ kind: 'lamp', x: px(x), y: px(south + 3) + 6, seed: x }, true);
    if (northStreet) place({ kind: 'lamp', x: px(x), y: px(main.y - 3) + 6, seed: x + 1 }, true);
  }
  // banco e totem com a marca na calçada, dos dois lados do caminho de pedra (longe dos postes em x 34 e 44)
  place({ kind: 'bench', x: px(ENTRANCE_X + ENTRANCE_W + 4), y: px(south + 2) + 4, seed: 1 }, true);
  place({ kind: 'totem', x: px(ENTRANCE_X - 3) + 8, y: px(south + 2) + 4, seed: 2 }, true);
  // semáforos da faixa de pedestres na frente da entrada: um em cada calçada, nas pontas opostas da faixa
  place({ kind: 'traffic_light', x: px(ENTRANCE_X) - 6, y: px(south + 3) + 6, seed: 3 }, true);
  place({ kind: 'traffic_light', x: px(ENTRANCE_X + ENTRANCE_W) + 6, y: px(south + 9) + 6, seed: 4 }, true);

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
    streets,
  };
}

/**
 * Parede externa + jardim de um slot vazio: deck de madeira com mesas e guarda-sóis, canteiros e caminho.
 * `ends` diz quais pontas da coluna são pontas de pé do prédio: ali o corredor é fechado com um `cap`; `street` diz se
 * há rua daquele lado (D5): só então o jardim tem caminho de pedra até a calçada e `paving`. Sem `street`, vale a
 * regra da fase 2 (só o sul do principal).
 */
export function slotShell(slot: number, ends: { west: boolean; east: boolean; street?: boolean }): SlotShell {
  const addr = slotAddress(slot);
  const side = addr.side;
  const street = ends.street ?? (addr.block.by === 0 && side === 'south');
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
    // fachada com janelas fechando o corredor (linhas 10–11 da coluna, medidas a partir do bloco)
    const fy = (rect.y + ROOM_H - 2) * TILE;
    walls.push({ kind: 'face', x: x0, y: fy, w: W, style: EXTERIOR_WALL });
    [3, 8, 13].forEach((cx, i) =>
      windows.push({ id: `shell:${slot}:janela${i}`, kind: 'window', cx: x0 + cx * TILE, baseY: (rect.y + ROOM_H) * TILE, on: 'face', order: 0 }),
    );
    if (ends.east) walls.push({ kind: 'cap', x: x0 + W - TILE / 2, y: fy, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    if (ends.west) walls.push({ kind: 'cap', x: x0, y: fy, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    // caminho do gramado até o deck, deck no meio e canteiros sob as janelas; com rua ao norte, o caminho segue até a
    // calçada (paving fora do pátio, que só existe enquanto o slot está vazio)
    floors.push({ kind: 'sidewalk', x: x0 + T(7), y: T(rect.y), w: T(2), h: T(3), seed: slot });
    if (street) props.push({ kind: 'paving', x: x0 + T(7), y: T(rect.y) - 2 * TILE, seed: slot, slot });
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
    // mureta externa fechando o corredor (linha 17 da coluna, medida a partir do bloco) e jardim abaixo
    const wy = rect.y * TILE;
    walls.push({ kind: 'south', x: x0, y: wy, w: W, style: EXTERIOR_WALL });
    if (ends.east) walls.push({ kind: 'cap', x: x0 + W - TILE / 2, y: wy, w: TILE / 2, h: TILE, style: EXTERIOR_WALL });
    if (ends.west) walls.push({ kind: 'cap', x: x0, y: wy, w: TILE / 2, h: TILE, style: EXTERIOR_WALL });
    // com rua ao sul o jardim dá na calçada: caminho de pedra e o trecho entre a fachada e a calçada (que só existe
    // enquanto o slot está vazio: a cerca viva fecha); nos anexos da fileira 1 não há rua ao sul
    if (street) {
      floors.push({ kind: 'sidewalk', x: x0 + T(7), y: T(rect.y + 1), w: T(2), h: T(rect.h - 1), seed: slot });
      props.push({ kind: 'paving', x: x0 + T(7), y: T(rect.y + rect.h), seed: slot, slot });
    }
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
  return { slot, rect, side, walls, windows, floors, props };
}
