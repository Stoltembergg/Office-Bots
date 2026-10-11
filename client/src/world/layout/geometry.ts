// Geometria do prédio: modelo de blocos (spec seção 1: envelopes, ordem dos blocos, vagas por bloco,
// colunas de pé). Puro e testável.
import { BUILDING_H, COL_W, NORTH_Y, ROOM_H, SOUTH_Y, TILE } from '../constants';
import type { TileRect } from './types';

export type Side = 'north' | 'south';

// ---- Modelo de blocos -------------------------------------------------------------------------

/** Posição do bloco na grade de blocos: (0, 0) é o principal; anexos têm by ∈ {−1, 0, 1}. */
export interface BlockId {
  readonly bx: number;
  readonly by: number;
}
export const PRINCIPAL: BlockId = { bx: 0, by: 0 };
export const ROOMS_PER_BLOCK = 8;
/** Envelope do principal (colunas 0..5). */
export const MAIN_COLS = 6;
/** Envelope do anexo (colunas 0..4). */
export const ANNEX_COLS = 5;
/** Faixa de rua entre blocos (tiles). */
export const STREET_W = 12;
/** Passo entre fileiras de blocos (tiles): 41. */
export const ROW_STEP = BUILDING_H + STREET_W;
/** Transitório (spec 7.5): quantos blocos da ordem existem nesta fase. Fase 2 = 2 (principal e anexo 1). */
export const IMPLEMENTED_BLOCKS = 2;
/** Chegada do bloco: decide a ordem das vagas (spec 1.2) e a coluna de ligação (1.3). */
export type Arrival = 'core' | 'hub' | 'west' | 'east';
export interface SlotAddress {
  block: BlockId;
  col: number;
  side: Side;
}
export interface ColumnSpan {
  lo: number;
  hi: number;
}
/** Bloco existente: envelope fixo (spec 1.1), colunas de pé e retângulo de pé (envelope recortado a lo..hi). */
export interface BlockLayout {
  id: BlockId;
  envelope: TileRect;
  columns: ColumnSpan;
  rect: TileRect;
}
export interface ColumnRef {
  block: BlockId;
  col: number;
}

export function blockKey(b: BlockId): string {
  return `${b.bx},${b.by}`;
}

export function isPrincipal(b: BlockId): boolean {
  return b.bx === 0 && b.by === 0;
}

/** Colunas do envelope: 6 no principal, 5 nos anexos. */
export function blockCols(b: BlockId): number {
  return isPrincipal(b) ? MAIN_COLS : ANNEX_COLS;
}

const MAIN_W = MAIN_COLS * COL_W;
const ANNEX_W = ANNEX_COLS * COL_W;
/** Recuo dos anexos centrais (0, ±1) em relação ao principal: 8 tiles de cada lado. */
const ANNEX_INSET = (MAIN_W - ANNEX_W) / 2;
/** Passo entre envelopes vizinhos da mesma fileira (anexo + rua): 92. */
const ANNEX_STEP = ANNEX_W + STREET_W;

/** Envelope do bloco (spec 1.1): retângulo máximo, de posição fixa. */
export function blockRect(b: BlockId): TileRect {
  const y = b.by * ROW_STEP;
  if (isPrincipal(b)) return { x: 0, y, w: MAIN_W, h: BUILDING_H };
  if (b.bx === 0) return { x: ANNEX_INSET, y, w: ANNEX_W, h: BUILDING_H };
  if (b.bx > 0) return { x: MAIN_W + STREET_W + ANNEX_STEP * (b.bx - 1), y, w: ANNEX_W, h: BUILDING_H };
  return { x: ANNEX_STEP * b.bx, y, w: ANNEX_W, h: BUILDING_H };
}

/** Anel 1 da ordem dos blocos (spec 1.4): A1..A8. */
const RING_1: readonly BlockId[] = [
  { bx: 0, by: 1 },
  { bx: 1, by: 0 },
  { bx: 1, by: 1 },
  { bx: -1, by: 0 },
  { bx: -1, by: 1 },
  { bx: 0, by: -1 },
  { bx: 1, by: -1 },
  { bx: -1, by: -1 },
];
/** Anéis r ≥ 2: (sinal de bx, by) na ordem (r,0) (r,1) (−r,0) (−r,1) (r,−1) (−r,−1). */
const RING_SHAPE: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [-1, 0],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** n-ésimo bloco da ordem (spec 1.4): 0 → principal; n ≥ 1 → A_n. */
export function blockOrder(n: number): BlockId {
  if (n === 0) return PRINCIPAL;
  if (n <= RING_1.length) return RING_1[n - 1];
  const m = n - RING_1.length;
  const r = 2 + Math.floor((m - 1) / RING_SHAPE.length);
  const [sx, by] = RING_SHAPE[(m - 1) % RING_SHAPE.length];
  return { bx: sx * r, by };
}

/** Inverso de blockOrder. Lança para um bloco fora da ordem (by fora de −1..1). */
export function blockIndex(b: BlockId): number {
  if (isPrincipal(b)) return 0;
  const ring = Math.abs(b.bx);
  if (ring <= 1) {
    const i = RING_1.findIndex((r) => r.bx === b.bx && r.by === b.by);
    if (i < 0) throw new Error(`bloco fora da ordem: ${blockKey(b)}`);
    return i + 1;
  }
  const k = RING_SHAPE.findIndex(([sx, by]) => sx === Math.sign(b.bx) && by === b.by);
  if (k < 0) throw new Error(`bloco fora da ordem: ${blockKey(b)}`);
  return RING_1.length + (ring - 2) * RING_SHAPE.length + k + 1;
}

/** Pai do bloco (spec 1.4): de onde sai a passarela. O principal não tem pai. */
export function parentOf(b: BlockId): BlockId | null {
  if (isPrincipal(b)) return null;
  if (b.bx === 0) return PRINCIPAL;
  if (b.by === 1) return { bx: b.bx, by: 0 };
  return { bx: b.bx - Math.sign(b.bx), by: b.by };
}

export function arrivalOf(b: BlockId): Arrival {
  if (isPrincipal(b)) return 'core';
  if (b.bx === 0 || b.by === 1) return 'hub';
  return b.bx > 0 ? 'west' : 'east';
}

const MAIN_CORE: readonly number[] = [2, 3];
const ANNEX_CORE: readonly number[] = [2];

/** Colunas do miolo: [2, 3] no principal (recepção/WC e copa/lounge), [2] no anexo (hub). */
export function coreColumns(b: BlockId): readonly number[] {
  return isPrincipal(b) ? MAIN_CORE : ANNEX_CORE;
}

export function isCoreColumn(b: BlockId, col: number): boolean {
  return coreColumns(b).includes(col);
}

/** Ordem das 8 vagas locais (coluna, lado) por tipo de chegada (spec 1.2); índice = vaga local s mod 8. */
export const SLOT_ORDER: Readonly<Record<Arrival, readonly (readonly [number, Side])[]>> = {
  core: [[4, 'north'], [1, 'north'], [4, 'south'], [1, 'south'], [5, 'north'], [0, 'north'], [5, 'south'], [0, 'south']],
  hub: [[3, 'north'], [1, 'north'], [3, 'south'], [1, 'south'], [4, 'north'], [0, 'north'], [4, 'south'], [0, 'south']],
  west: [[0, 'north'], [0, 'south'], [1, 'north'], [1, 'south'], [3, 'north'], [3, 'south'], [4, 'north'], [4, 'south']],
  east: [[4, 'north'], [4, 'south'], [3, 'north'], [3, 'south'], [1, 'north'], [1, 'south'], [0, 'north'], [0, 'south']],
};

/** Bloco da vaga global. Vagas de blocos ainda não implementados (⌊slot/8⌋ ≥ k) ficam no principal (spec 7.5). */
export function blockFor(slot: number, k = IMPLEMENTED_BLOCKS): BlockId {
  const n = Math.floor(slot / ROOMS_PER_BLOCK);
  return n < k ? blockOrder(n) : PRINCIPAL;
}

/** Endereço (bloco, coluna, lado) da vaga global; transitório 7.5: colunas extras (6, 7, 8...) a leste do principal. */
export function slotAddress(slot: number, k = IMPLEMENTED_BLOCKS): SlotAddress {
  slot = Math.max(0, slot);
  const n = Math.floor(slot / ROOMS_PER_BLOCK);
  if (n < k) {
    const block = blockOrder(n);
    const [col, side] = SLOT_ORDER[arrivalOf(block)][slot % ROOMS_PER_BLOCK];
    return { block, col, side };
  }
  const e = slot - ROOMS_PER_BLOCK * k;
  return { block: PRINCIPAL, col: MAIN_COLS + Math.floor(e / 2), side: e % 2 === 0 ? 'north' : 'south' };
}

/** Inverso de slotAddress. Lança se (col, side) não é vaga do bloco (coluna de miolo). */
export function slotAt(block: BlockId, col: number, side: Side, k = IMPLEMENTED_BLOCKS): number {
  if (isPrincipal(block) && col >= MAIN_COLS) {
    return ROOMS_PER_BLOCK * k + 2 * (col - MAIN_COLS) + (side === 'north' ? 0 : 1);
  }
  const i = SLOT_ORDER[arrivalOf(block)].findIndex(([c, s]) => c === col && s === side);
  if (i < 0) throw new Error(`coluna ${col} ${side} não é vaga do bloco ${blockKey(block)}`);
  return ROOMS_PER_BLOCK * blockIndex(block) + i;
}

/** Retângulo (tiles) de uma coluna × lado do bloco: sala ao norte ou ao sul do corredor. */
export function blockColumnRect(block: BlockId, col: number, side: Side): TileRect {
  const env = blockRect(block);
  return { x: env.x + col * COL_W, y: env.y + (side === 'north' ? NORTH_Y : SOUTH_Y), w: COL_W, h: ROOM_H };
}

/**
 * Colunas de pé do bloco (spec 1.3): da menor à maior entre o miolo, as colunas das vagas presentes
 * deste bloco, a ponta por onde chega a passarela (bloco lateral) e, por filho, o miolo (filho vertical)
 * ou a ponta voltada para ele (filho lateral).
 */
export function standingColumns(block: BlockId, slots: Iterable<number>, children: Iterable<BlockId> = [], k = IMPLEMENTED_BLOCKS): ColumnSpan {
  const cols = new Set<number>(coreColumns(block));
  const key = blockKey(block);
  for (const s of slots) {
    const a = slotAddress(s, k);
    if (blockKey(a.block) === key) cols.add(a.col);
  }
  const arrival = arrivalOf(block);
  if (arrival === 'west') cols.add(0);
  if (arrival === 'east') cols.add(blockCols(block) - 1);
  for (const f of children) {
    if (arrivalOf(f) === 'hub') for (const c of coreColumns(block)) cols.add(c);
    else cols.add(f.bx > block.bx ? blockCols(block) - 1 : 0);
  }
  return { lo: Math.min(...cols), hi: Math.max(...cols) };
}

/** Retângulo de pé: o envelope recortado em x às colunas lo..hi. Pode passar do envelope (7.5). */
export function standingRect(block: BlockId, span: ColumnSpan): TileRect {
  const env = blockRect(block);
  return { x: env.x + span.lo * COL_W, y: env.y, w: (span.hi - span.lo + 1) * COL_W, h: BUILDING_H };
}

/** Chave dos blocos de pé ("0,0:0-5;0,1:2-3"): muda só quando um bloco entra/sai ou uma coluna sobe/desce. */
export function standingKey(blocks: readonly BlockLayout[]): string {
  return blocks.map((b) => `${blockKey(b.id)}:${b.columns.lo}-${b.columns.hi}`).join(';');
}

/**
 * Blocos existentes (spec 1.3): os das vagas, seus ancestrais e o principal, ordenados por blockIndex. `keep` são
 * blocos mantidos sem vaga (trava de encolher, spec 7.2): entram com os ancestrais e ficam só com o miolo.
 */
export function existingBlocks(slots: Iterable<number>, k = IMPLEMENTED_BLOCKS, keep: readonly BlockId[] = []): BlockLayout[] {
  const slotList = [...slots];
  const ids = new Map<string, BlockId>([[blockKey(PRINCIPAL), PRINCIPAL]]);
  const add = (from: BlockId) => {
    for (let b: BlockId | null = from; b !== null; b = parentOf(b)) ids.set(blockKey(b), b);
  };
  for (const s of slotList) add(blockFor(s, k));
  for (const b of keep) add(b);
  const ordered = [...ids.values()].sort((a, b) => blockIndex(a) - blockIndex(b));
  return ordered.map((id) => {
    const children = ordered.filter((o) => {
      const p = parentOf(o);
      return p !== null && blockKey(p) === blockKey(id);
    });
    const columns = standingColumns(id, slotList, children, k);
    return { id, envelope: blockRect(id), columns, rect: standingRect(id, columns) };
  });
}

/** União dos retângulos de pé e dos trechos das passarelas. Sem blocos: o principal recortado às colunas 2–3. */
export function worldBounds(blocks: readonly BlockLayout[], bridges: readonly BridgeLayout[] = []): TileRect {
  if (blocks.length === 0) return standingRect(PRINCIPAL, standingColumns(PRINCIPAL, []));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of [...blocks.map((b) => b.rect), ...bridges.flatMap((b) => b.rects)]) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Coluna de pé do bloco que contém o tile, ou null (fora da altura do bloco ou fora de lo..hi). */
export function columnAt(block: BlockLayout, tx: number, ty: number): number | null {
  const env = block.envelope;
  if (ty < env.y || ty >= env.y + BUILDING_H) return null;
  const col = Math.floor((tx - env.x) / COL_W);
  if (col < block.columns.lo || col > block.columns.hi) return null;
  return col;
}

/** Colunas (bloco, coluna) em que há algum tile da lista, sem repetição. */
export function occupiedColumns(blocks: readonly BlockLayout[], tiles: Iterable<{ tx: number; ty: number }>): ColumnRef[] {
  const seen = new Set<string>();
  const refs: ColumnRef[] = [];
  for (const t of tiles) {
    // margem de 1 tile em x: quem está na borda segura as duas colunas (como a trava antiga)
    for (const tx of [t.tx - 1, t.tx, t.tx + 1]) {
      for (const b of blocks) {
        const col = columnAt(b, tx, t.ty);
        if (col === null) continue;
        const key = `${blockKey(b.id)}:${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ block: b.id, col });
      }
    }
  }
  return refs;
}

/**
 * Trava de encolher (spec 7.2): estende as colunas de pé de cada bloco até cobrir as referências dele.
 * Refs de blocos ausentes são ignoradas. Não muta a entrada; `retained` diz se algum lo/hi mudou.
 */
export function retainColumns(blocks: readonly BlockLayout[], refs: readonly ColumnRef[]): { blocks: BlockLayout[]; retained: boolean } {
  let retained = false;
  const out = blocks.map((b) => {
    const key = blockKey(b.id);
    let lo = b.columns.lo;
    let hi = b.columns.hi;
    for (const r of refs) {
      if (blockKey(r.block) !== key) continue;
      lo = Math.min(lo, r.col);
      hi = Math.max(hi, r.col);
    }
    if (lo !== b.columns.lo || hi !== b.columns.hi) retained = true;
    const columns = { lo, hi };
    return { id: b.id, envelope: b.envelope, columns, rect: standingRect(b.id, columns) };
  });
  return { blocks: out, retained };
}

/** Referência a uma passarela com alguém (trava): o bloco filho dela e o id. */
export interface BridgeRef {
  block: BlockId;
  bridge: string;
}
export type RegionRef = ColumnRef | BridgeRef;
export function isColumnRef(r: RegionRef): r is ColumnRef {
  return 'col' in r;
}

/** Colunas (por bloco) e passarelas do layout dado onde há algum tile da lista. */
export function occupiedRegions(blocks: readonly BlockLayout[], bridges: readonly BridgeLayout[], tiles: Iterable<{ tx: number; ty: number }>): RegionRef[] {
  const list = [...tiles];
  const refs: RegionRef[] = occupiedColumns(blocks, list);
  for (const br of bridges) {
    if (list.some((t) => br.rects.some((r) => inRect(r, t.tx, t.ty)))) refs.push({ block: br.child, bridge: br.id });
  }
  return refs;
}

/**
 * Trava de encolher por regiões (spec 7.2): os blocos das vagas presentes mais os blocos (e ancestrais) das
 * referências, com as colunas estendidas até cobri-las. `retained` diz se algo além do layout fresco ficou de pé.
 */
export function retainRegions(slots: Iterable<number>, refs: readonly RegionRef[], k = IMPLEMENTED_BLOCKS): { blocks: BlockLayout[]; retained: boolean } {
  const slotList = [...slots];
  const fresh = existingBlocks(slotList, k);
  const kept = existingBlocks(slotList, k, refs.map((r) => r.block));
  const out = retainColumns(kept, refs.filter(isColumnRef));
  return { blocks: out.blocks, retained: out.retained || kept.length !== fresh.length };
}

// ---- Passarelas ---------------------------------------------------------------------------------

/** Largura da passarela (tiles). */
export const BRIDGE_W = 3;
/** x local (na coluna) da porta externa de 3 tiles: lx 7..10. */
export const DOOR_LX = 7;
/** Altura (tiles) da passagem na parede sul do lounge (1 tile de parede) e na face norte do saguão (2 tiles de parede). */
export const LOUNGE_EXIT_H = 1;
export const HUB_DOOR_H = 2;

export interface BridgeLayout {
  /** `passarela:<bx>,<by>` do bloco filho. */
  id: string;
  child: BlockId;
  parent: BlockId;
  /** Trechos retangulares (tiles), do pai ao filho. */
  rects: TileRect[];
  /** Tiles das portas em que a passarela encosta (no pai e no filho): não recebem guarda-corpo. */
  openings: TileRect[];
}

export function bridgeId(child: BlockId): string {
  return `passarela:${blockKey(child)}`;
}

/**
 * Trechos da passarela do bloco filho ao pai (spec 3.6). Fase 2: só o anexo 1 (0, 1), em Z sobre a rua: sai pela
 * porta sul do lounge (coluna 3 do principal), corre para oeste e entra pela porta norte do saguão (coluna 2 do
 * anexo). Qualquer outro bloco lança (passarelas horizontais e colunas de ligação são da fase 3).
 */
export function bridgeRects(child: BlockId): TileRect[] {
  const parent = parentOf(child);
  if (!parent || child.bx !== 0 || child.by !== 1) throw new Error(`passarela de ${blockKey(child)} ainda não implementada (fase 3)`);
  const from = blockRect(parent);
  const to = blockRect(child);
  const exitX = from.x + coreColumns(parent)[1] * COL_W + DOOR_LX;
  const entryX = to.x + coreColumns(child)[0] * COL_W + DOOR_LX;
  const y0 = from.y + from.h;
  return [
    { x: exitX, y: y0, w: BRIDGE_W, h: 4 },
    { x: Math.min(exitX, entryX), y: y0 + 4, w: Math.abs(exitX - entryX) + BRIDGE_W, h: 3 },
    { x: entryX, y: y0 + 7, w: BRIDGE_W, h: to.y - (y0 + 7) },
  ];
}

/** Tiles das portas em que a passarela encosta: a porta sul do lounge (1 linha) e a porta norte do saguão (2 linhas). */
export function bridgeOpenings(child: BlockId): TileRect[] {
  const rects = bridgeRects(child);
  const first = rects[0];
  const last = rects[rects.length - 1];
  return [
    { x: first.x, y: first.y - LOUNGE_EXIT_H, w: first.w, h: LOUNGE_EXIT_H },
    { x: last.x, y: last.y + last.h, w: last.w, h: HUB_DOOR_H },
  ];
}

/** Passarelas dos blocos existentes: uma por bloco que não é o principal, até o pai. */
export function bridgesFor(blocks: readonly BlockLayout[]): BridgeLayout[] {
  const out: BridgeLayout[] = [];
  for (const b of blocks) {
    const parent = parentOf(b.id);
    if (!parent) continue;
    out.push({ id: bridgeId(b.id), child: b.id, parent, rects: bridgeRects(b.id), openings: bridgeOpenings(b.id) });
  }
  return out;
}

// ---- Regiões (bloco ou passarela) ---------------------------------------------------------------

/** Bloco cujo retângulo de pé contém o tile, ou null. */
export function blockAt(blocks: readonly BlockLayout[], tx: number, ty: number): BlockLayout | null {
  return blocks.find((b) => inRect(b.rect, tx, ty)) ?? null;
}

export type Region = { kind: 'block'; block: BlockLayout } | { kind: 'bridge'; bridge: BridgeLayout };

/** Região do tile (spec 5): o bloco de pé que o contém, senão a passarela, senão null (rua, jardim, fora). */
export function regionAt(blocks: readonly BlockLayout[], bridges: readonly BridgeLayout[], tx: number, ty: number): Region | null {
  const block = blockAt(blocks, tx, ty);
  if (block) return { kind: 'block', block };
  for (const bridge of bridges) if (bridge.rects.some((r) => inRect(r, tx, ty))) return { kind: 'bridge', bridge };
  return null;
}

/** `bloco:<bx>,<by>` ou o id da passarela. */
export function regionKey(r: Region): string {
  return r.kind === 'block' ? `bloco:${blockKey(r.block.id)}` : r.bridge.id;
}

// ---- Retângulos ---------------------------------------------------------------------------------

export function rectPx(r: TileRect): { x: number; y: number; w: number; h: number } {
  return { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
}

export function inRect(r: TileRect, tx: number, ty: number): boolean {
  return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
}
