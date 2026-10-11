// Montagem do prédio: por bloco, núcleo (no principal) ou saguão + WC (nos anexos) e corredor sobre as colunas de pé;
// as passarelas entre blocos; mais as salas de projeto -> grade de caminhabilidade com origem e spots.
import { FURNITURE } from '../../art/api';
import { BLOCKED, FREE, SEAT, WalkGrid } from '../path/grid';
import { layoutBridge } from './bridge';
import { furnitureBlocks, furnitureIsSeat } from './builder';
import { coreAreas } from './core';
import { layoutCorridor } from './corridor';
import { bridgesFor, hubDoor, isPrincipal, worldBounds, type BlockLayout, type BridgeLayout } from './geometry';
import { hubAreas } from './hub';
import type { AreaLayout, SpotDef, TileRect } from './types';

export interface BuildingLayout {
  blocks: BlockLayout[];
  /** Passarelas entre os blocos (uma por anexo, até o pai). */
  bridges: BridgeLayout[];
  /** `worldBounds(blocks, bridges)`, em tiles: união dos retângulos de pé e dos trechos das passarelas. */
  rect: TileRect;
  /** Áreas fixas: núcleo do principal, saguão e WC de cada anexo, corredores e passarelas. */
  areas: AreaLayout[];
  rooms: AreaLayout[];
  grid: WalkGrid;
  spots: SpotDef[];
}

/** Marca na grade as células caminháveis de uma área, os bloqueios e os assentos. */
export function paintArea(grid: WalkGrid, area: AreaLayout): void {
  for (const r of area.walkable) grid.fill(r.x, r.y, r.w, r.h, FREE);
  for (const r of area.blocked ?? []) grid.fill(r.x, r.y, r.w, r.h, BLOCKED);
  for (const f of area.furniture) {
    const def = FURNITURE[f.kind];
    if (def.mount !== 'floor') continue;
    const { w, h } = def.footprint;
    if (furnitureBlocks(f.kind)) grid.fill(f.tx, f.ty, w, h, BLOCKED);
    else if (furnitureIsSeat(f.kind)) {
      for (let y = f.ty; y < f.ty + h; y++) for (let x = f.tx; x < f.tx + w; x++) if (grid.get(x, y) === FREE) grid.set(x, y, SEAT);
    }
  }
}

/** Grade com a origem e o tamanho de `bounds` (tiles), pintada com as áreas dadas. */
export function buildWalkGrid(bounds: TileRect, areas: readonly AreaLayout[], version = 0): WalkGrid {
  const grid = WalkGrid.forRect(bounds, version);
  for (const a of areas) paintArea(grid, a);
  return grid;
}

export function assembleBuilding(blocks: readonly BlockLayout[], rooms: readonly AreaLayout[], version = 0): BuildingLayout {
  const bridges = bridgesFor(blocks);
  const core: AreaLayout[] = [];
  const corridors: AreaLayout[] = [];
  for (const block of blocks) {
    if (isPrincipal(block.id)) core.push(...coreAreas(block.id));
    else core.push(...hubAreas(block.id, hubDoor(block.id, bridges)));
    corridors.push(layoutCorridor(block, bridges));
  }
  const walkways = bridges.map(layoutBridge);
  const areas = [...core, ...corridors, ...walkways];
  const rect = worldBounds(blocks, bridges);
  const all = [...areas, ...rooms];
  const grid = buildWalkGrid(rect, all, version);
  const spots: SpotDef[] = [];
  for (const a of all) spots.push(...a.spots);
  return { blocks: [...blocks], bridges, rect, areas, rooms: [...rooms], grid, spots };
}
