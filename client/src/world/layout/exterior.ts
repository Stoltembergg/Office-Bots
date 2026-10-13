// Área externa: grama, árvores, calçada e rua; pátio/jardim nos slots sem sala. Tudo parte do
// retângulo de pé do prédio (worldBounds), não do envelope.
import type { WallStyle } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { BUILDING_H, COL_W, EXT_EAST, EXT_NORTH, EXT_SOUTH, EXT_WEST, ROOM_H, TILE } from '../constants';
import { blockColumnRect, blockRect, BRIDGE_W, bridgesFor, DOOR_LX, inRect, isCoreColumn, PRINCIPAL, slotAddress, slotAt, STREET_W, streetX, worldBounds, type BlockId, type BlockLayout, type BridgeLayout, type Side } from './geometry';
import { cellTouches, fieldCells, fieldProp } from '../render/field';
import type { ExteriorProp, FloorPatch, TileRect, WallItemPlacement, WallSegment } from './types';

export const EXTERIOR_WALL: WallStyle = { base: '#cfc8bd', trim: '#8a8174', pattern: 'brick', exterior: true };

/** Entrada do prédio: porta de 3 tiles na parede sul da recepção (coluna 2 do principal, lx 7..10 → x 39..42). */
export const ENTRANCE_X = blockRect(PRINCIPAL).x + 2 * COL_W + DOOR_LX;
export const ENTRANCE_W = BRIDGE_W;
/** Caminho de pedra da porta (y 29) até a calçada (y 31): 2 tiles. */
export const ENTRANCE_DEPTH = 2;
/** Tile da porta de entrada (dentro da recepção, meio da abertura de 3 tiles): por onde todos chegam e vão embora. */
export const ENTRANCE_DOOR = { tx: ENTRANCE_X + 1, ty: blockRect(PRINCIPAL).y + BUILDING_H - 1 } as const;
/** Linha da calçada (segunda linha da calçada norte da rua principal) por onde os personagens chegam e vão. */
export const SIDEWALK_TY = ENTRANCE_DOOR.ty + 1 + ENTRANCE_DEPTH + 1;

/** Rua (tiles), 12 de largura — h: linhas 2–3 e 9–10 calçada, 4–8 asfalto; v: colunas 1–2 e 8–9 calçada, 3–7 asfalto. */
export interface Street {
  axis: 'h' | 'v';
  rect: TileRect;
  /** Tem carros: a principal (lanes) e as norte–sul (vlanes); a rua norte não. */
  cars: boolean;
}

/**
 * Postes de 6 em 6 tiles numa grade fixa do mundo (não mudam de lugar quando o mundo cresce), dentro de `area`:
 * nas duas calçadas da rua principal (a do sul deslocada de 3 tiles), na calçada sul da rua norte e ao longo da
 * calçada leste de cada rua norte–sul; nenhum no asfalto das ruas norte–sul, junto à entrada (caminho de pedra,
 * totem, banco e semáforos) nem nos cruzamentos. A base chama com os seus limites; o render chama com a parte
 * visível além da base, para a fileira seguir até onde a câmera for.
 */
export function lampsAlong(streets: readonly Street[], northStreetY: number | null, area: TileRect): ExteriorProp[] {
  const out: ExteriorProp[] = [];
  const px = (t: number) => t * TILE;
  const asphaltV = streets.filter((s) => s.axis === 'v').map((s) => ({ x0: s.rect.x + 3, x1: s.rect.x + 8 }));
  const nearEntrance = (x: number) => x >= ENTRANCE_X - 4 && x < ENTRANCE_X + ENTRANCE_W + 5;
  const main = streets.find((s) => s.axis === 'h' && s.cars);
  const lampRow = (offset: number, y: number, seed: number) => {
    if (Math.floor(y / TILE) < area.y || Math.floor(y / TILE) >= area.y + area.h) return;
    for (let x = Math.floor(area.x / 6) * 6 + offset; x < area.x + area.w; x += 6) {
      if (x < area.x || nearEntrance(x) || asphaltV.some((a) => x >= a.x0 - 1 && x < a.x1 + 1)) continue;
      out.push({ kind: 'lamp', x: px(x), y, seed: x + seed });
    }
  };
  if (main) {
    lampRow(2, px(main.rect.y + 3) + 6, 0);
    lampRow(5, px(main.rect.y + 10) + 6, 2);
  }
  if (northStreetY !== null) lampRow(2, px(northStreetY - 3) + 6, 1);
  const hStreets = streets.filter((s) => s.axis === 'h');
  for (const v of streets.filter((s) => s.axis === 'v')) {
    const lx = v.rect.x + 8;
    if (lx < area.x || lx >= area.x + area.w) continue;
    for (let y = Math.ceil(area.y / 6) * 6 + 2; y < area.y + area.h; y += 6) {
      if (hStreets.some((h) => y >= h.rect.y - 1 && y < h.rect.y + STREET_W + 2)) continue;
      out.push({ kind: 'lamp', x: px(lx) + 8, y: px(y) + 6, seed: y + 7 });
    }
  }
  return out;
}

export interface ExteriorLayout {
  /** Limites da área desenhada (tiles). */
  bounds: TileRect;
  floors: FloorPatch[];
  props: ExteriorProp[];
  /** Faixas da rua principal (y em px) e sentido (+1 = leste, -1 = oeste). */
  lanes: { y: number; dir: 1 | -1 }[];
  /** Faixas das ruas norte–sul (x do centro do carro, px) e sentido (+1 = sul, -1 = norte): mão direita. */
  vlanes: { x: number; dir: 1 | -1 }[];
  /** Linha central da rua principal (px), para as faixas tracejadas. */
  streetY: number;
  streetH: number;
  /** y (tiles) do topo do principal quando há rua norte (os postes dela ficam em y − 3); null sem ela. */
  northStreetY: number | null;
  /** Todas as ruas: principal, norte (com bloco em by = −1) e norte–sul (uma por coluna de blocos |bx| ≥ 1). */
  streets: Street[];
  /** Cruzamentos (tiles): o asfalto comum de cada rua norte–sul com cada rua leste–oeste (5×5). */
  intersections: TileRect[];
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

/** Calçada + asfalto de uma rua (tiles): onde nada de jardim entra. */
function pavedRect(s: Street): TileRect {
  return s.axis === 'h' ? { x: s.rect.x, y: s.rect.y + 2, w: s.rect.w, h: 9 } : { x: s.rect.x + 1, y: s.rect.y, w: 9, h: s.rect.h };
}

/** Meia-largura e altura (px) da copa de árvores e pinheiros: nenhuma copa entra em calçada ou asfalto. */
export const CANOPY_HALF_W = 18;
export const CANOPY_UP = 50;

/**
 * A copa de um prop com base em (x, y) (px) encosta na calçada ou no asfalto de `s` (linhas 2–10 de uma rua h;
 * colunas 1–9 de uma v)? Ao longo do eixo a rua não tem fim: o render a estende além dos bounds, e uma árvore de
 * célula que atravessa a borda da base cairia sobre a extensão.
 */
export function canopyOverlapsStreet(x: number, y: number, s: Street): boolean {
  const r = s.rect;
  if (s.axis === 'h') return y > (r.y + 2) * TILE && y - CANOPY_UP < (r.y + 11) * TILE;
  return x + CANOPY_HALF_W > (r.x + 1) * TILE && x - CANOPY_HALF_W < (r.x + 10) * TILE;
}

/** Lados de um bloco que dão para uma rua: a cerca viva e o paving dos pátios ficam só deles. */
export function streetSides(b: BlockId, northStreet: boolean): readonly Side[] {
  if (b.by === 1) return ['north'];
  if (b.by === -1) return ['south'];
  return northStreet ? ['south', 'north'] : ['south'];
}

/** Gerador determinístico por posição (tiles): a mesma árvore sai no mesmo lugar não importa o tamanho do mundo. */

export function layoutExterior(blocks: readonly BlockLayout[], bridges: readonly BridgeLayout[] = bridgesFor(blocks)): ExteriorLayout {
  const world = worldBounds(blocks, bridges);
  const bounds: TileRect = { x: world.x - EXT_WEST, y: world.y - EXT_NORTH, w: world.w + EXT_WEST + EXT_EAST, h: world.h + EXT_NORTH + EXT_SOUTH };
  const px = (t: number) => t * TILE;
  const floors: FloorPatch[] = [];
  const props: ExteriorProp[] = [];
  // a rua principal fica ao sul do PRINCIPAL (não do retângulo de pé): com anexos ao sul, o mundo cresce e a rua não desce
  const main = blockRect(PRINCIPAL);
  const south = main.y + main.h;
  const northStreet = blocks.some((b) => b.id.by === -1);
  const streets: Street[] = [{ axis: 'h', rect: { x: bounds.x, y: south, w: bounds.w, h: STREET_W }, cars: true }];
  if (northStreet) streets.push({ axis: 'h', rect: { x: bounds.x, y: main.y - STREET_W, w: bounds.w, h: STREET_W }, cars: false });
  for (const bx of [...new Set(blocks.map((b) => b.id.bx))].filter((bx) => bx !== 0).sort((a, b) => a - b)) {
    streets.push({ axis: 'v', rect: { x: streetX(bx), y: bounds.y, w: STREET_W, h: bounds.h }, cars: true });
  }
  const paved = streets.map(pavedRect);
  /** Meia-largura (px) dos sprites com copa: a base pode ficar fora do bloco e a copa invadir a parede lateral. */
  const HALF_W: Partial<Record<ExteriorProp['kind'], number>> = { tree: 18, pine: 14 };
  /**
   * Um prop só entra se o tile da sua base não cai num bloco de pé, num trecho de passarela nem na calçada ou
   * asfalto de uma rua (`onStreet` libera o mobiliário da calçada), e a copa não encosta num bloco.
   */
  const place = (p: ExteriorProp, onStreet = false) => {
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    // plantas do campo ficam a 1 tile de qualquer bloco; a cerca viva e o resto encostam
    const m = p.kind === 'tree' || p.kind === 'pine' || p.kind === 'bush' ? 1 : 0;
    if (blocks.some((b) => inRect({ x: b.rect.x - m, y: b.rect.y - m, w: b.rect.w + 2 * m, h: b.rect.h + 2 * m }, tx, ty))) return;
    if (bridges.some((br) => br.rects.some((r) => inRect(r, tx, ty)))) return;
    if (!onStreet && paved.some((r) => inRect(r, tx, ty))) return;
    if ((p.kind === 'tree' || p.kind === 'pine') && streets.some((s) => canopyOverlapsStreet(p.x, p.y, s))) return;
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

  // árvores e arbustos: as mesmas células de 8×8 tiles do campo que o renderer desenha além da
  // base, aqui as que encostam nos bounds (o renderer pula exatamente essas). Como a célula é do mundo, uma árvore
  // nunca muda de lugar quando um bloco nasce. Ficam de fora (place) blocos, passarelas, ruas, jardins e entrada.
  const gardens = blocks.flatMap((b) => streetSides(b.id, northStreet).map((side): TileRect => (side === 'south' ? { x: b.rect.x, y: b.envelope.y + BUILDING_H, w: b.rect.w, h: 3 } : { x: b.rect.x, y: b.envelope.y - 3, w: b.rect.w, h: 3 })));
  const entrance: TileRect = { x: ENTRANCE_X - 4, y: south - 1, w: ENTRANCE_W + 9, h: ENTRANCE_DEPTH + 2 };
  const { cx0, cy0, cx1, cy1 } = fieldCells(px(bounds.x) - TILE, px(bounds.y) - TILE, px(bounds.x + bounds.w) + TILE, px(bounds.y + bounds.h) + TILE);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!cellTouches(cx, cy, px(bounds.x), px(bounds.y), px(bounds.x + bounds.w), px(bounds.y + bounds.h))) continue;
      const p = fieldProp(cx, cy);
      if (!p) continue;
      const tx = Math.floor(p.x / TILE);
      const ty = Math.floor(p.y / TILE);
      if (gardens.some((g) => inRect(g, tx, ty)) || inRect(entrance, tx, ty)) continue;
      place(p);
    }
  }
  // cerca viva + flores diante de cada bloco, de cada lado com rua, ao longo do retângulo de pé; diante de cada
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
  for (const l of lampsAlong(streets, northStreet ? main.y : null, bounds)) place(l, true);
  // postes: de 6 em 6 tiles numa grade fixa do mundo (não mudam de lugar quando o mundo cresce para oeste), nas duas
  // calçadas da rua principal (a do sul é deslocada de 3 tiles), na calçada sul da rua norte e ao longo da calçada leste
  // de cada rua norte–sul; nenhum no asfalto das ruas norte–sul, junto à entrada (caminho de pedra, totem, banco e
  // semáforos) nem nos cruzamentos
  // banco e totem com a marca na calçada, dos dois lados do caminho de pedra (longe dos postes em x 34 e 44)
  place({ kind: 'bench', x: px(ENTRANCE_X + ENTRANCE_W + 4), y: px(south + 2) + 4, seed: 1 }, true);
  place({ kind: 'totem', x: px(ENTRANCE_X - 3) + 8, y: px(south + 2) + 4, seed: 2 }, true);
  // cruzamentos: a rua norte–sul é a via secundária, então cada aproximação tem uma placa de PARE na calçada à direita
  // de quem chega (a que vai para o sul pela calçada oeste, a que vai para o norte pela calçada leste)
  const intersections: TileRect[] = [];
  for (const v of streets.filter((s) => s.axis === 'v')) {
    for (const h of streets.filter((s) => s.axis === 'h')) {
      intersections.push({ x: v.rect.x + 3, y: h.rect.y + 4, w: 5, h: 5 });
      place({ kind: 'stop_sign', x: px(v.rect.x + 1) + 16, y: px(h.rect.y + 1) + 14, seed: 5 }, true);
      place({ kind: 'stop_sign', x: px(v.rect.x + 8) + 16, y: px(h.rect.y + 12) - 2, seed: 6 }, true);
    }
  }
  // semáforos da faixa de pedestres na frente da entrada: um em cada calçada, nas pontas opostas da faixa
  place({ kind: 'traffic_light', x: px(ENTRANCE_X) - 6, y: px(south + 3) + 6, seed: 3 }, true);
  place({ kind: 'traffic_light', x: px(ENTRANCE_X + ENTRANCE_W) + 6, y: px(south + 9) + 6, seed: 4 }, true);

  const streetY = px(south + 4);
  const streetH = px(5);
  return {
    bounds,
    floors,
    props,
    northStreetY: northStreet ? main.y : null,
    lanes: [
      { y: streetY + Math.round(streetH * 0.36), dir: 1 },
      { y: streetY + Math.round(streetH * 0.86), dir: -1 },
    ],
    // mão direita: quem vai para o sul na metade oeste do asfalto (colunas 3–7), quem vai para o norte na leste
    vlanes: streets.filter((s) => s.axis === 'v').flatMap((s) => [
      { x: px(s.rect.x + 3) + 20, dir: 1 as const },
      { x: px(s.rect.x + 3) + 60, dir: -1 as const },
    ]),
    streetY,
    streetH,
    streets,
    intersections,
  };
}

/**
 * Parede externa + jardim de um slot vazio: deck de madeira com mesas e guarda-sóis, canteiros e caminho.
 * `ends` diz quais pontas da coluna são pontas de pé do prédio: ali o corredor é fechado com um `cap`; `street` diz se
 * há rua daquele lado: só então o jardim tem caminho de pedra até a calçada e `paving`. Sem `street`, vale a
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
