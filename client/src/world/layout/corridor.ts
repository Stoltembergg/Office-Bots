// Corredor de um bloco: atravessa as colunas de pé de oeste a leste, com bebedouros, bancos e plantas.
import { COL_W, CORRIDOR_H, CORRIDOR_Y } from '../constants';
import { AreaBuilder } from './builder';
import { arrivalOf, blockKey, coreColumns, isPrincipal, type BlockId, type BlockLayout, type BridgeLayout } from './geometry';
import type { AreaLayout } from './types';

export const CORRIDOR_ID = 'core:corredor';

const TALL = ['ficus', 'palm', 'monstera', 'bonsai'] as const;
const SMALL = ['fern', 'succulent', 'flower'] as const;
/** Passadeira: uma família de cor só (azul-acinzentado discreto), com leve variação de tom. */
const RUNNERS = ['#8b9bb0', '#8597ab', '#909fb3'] as const;

/** Id da área do corredor: o principal mantém `core:corredor`; anexos usam `anexo:<bx>,<by>:corredor`. */
export function corridorId(block: BlockId): string {
  return isPrincipal(block) ? CORRIDOR_ID : `anexo:${block.bx},${block.by}:corredor`;
}

/** Pontas do corredor abertas por passarela horizontal: o bloco é pai ou filho dela, na mesma fileira. */
export function corridorEnds(block: BlockLayout, bridges: readonly BridgeLayout[]): { west: boolean; east: boolean } {
  const key = blockKey(block.id);
  let west = false;
  let east = false;
  for (const br of bridges) {
    const arrival = arrivalOf(br.child);
    if (arrival === 'hub') continue;
    if (blockKey(br.child) === key) {
      if (arrival === 'west') west = true;
      else east = true;
    } else if (blockKey(br.parent) === key) {
      if (br.child.bx > block.id.bx) east = true;
      else west = true;
    }
  }
  return { west, east };
}

/**
 * Corredor sobre as colunas de pé `lo..hi` do bloco. Cada ponta tem fachada de vidro, salvo quando uma passarela
 * horizontal chega por ela: aí as três linhas do meio (as da passarela) ficam abertas e caminháveis até a borda,
 * e só os cantos das linhas 0 e 4 ficam de vidro.
 */
export function layoutCorridor(block: BlockLayout, bridges: readonly BridgeLayout[] = []): AreaLayout {
  const { lo, hi } = block.columns;
  const env = block.envelope;
  const id = corridorId(block.id);
  const w = (hi - lo + 1) * COL_W;
  const open = corridorEnds(block, bridges);
  const b = new AreaBuilder(id, 'corridor', { x: env.x + lo * COL_W, y: env.y + CORRIDOR_Y, w, h: CORRIDOR_H });
  b.floor('concrete', 0, 0, w, CORRIDOR_H, 501);
  for (let ly = 0; ly < CORRIDOR_H; ly++) {
    const corner = ly === 0 || ly === CORRIDOR_H - 1;
    if (corner || !open.west) b.furn('glass_partition', 0, ly, corner ? 'end' : 'v', { order: 0.1 });
    if (corner || !open.east) b.furn('glass_partition', w - 1, ly, corner ? 'end' : 'v', { order: 0.1 });
  }
  b.walk(1, 0, w - 2, CORRIDOR_H);
  if (open.west) b.walk(0, 1, 1, CORRIDOR_H - 2);
  if (open.east) b.walk(w - 1, 1, 1, CORRIDOR_H - 2);

  const core = coreColumns(block.id);
  for (let c = lo; c <= hi; c++) {
    const x = (c - lo) * COL_W;
    if (c === core[0]) {
      // miolo: recepção (ou saguão) ao norte, banheiros ao sul
      b.furn('plant_tall', x + 2, 4, 'palm', { order: 0.5 });
      b.furn('plant_small', x + 13, 4, 'flower', { order: 0.5 });
    } else if (c === core[1]) {
      // miolo do principal: copa ao norte, lounge ao sul
      const bench = b.furn('bench', x + 2, 0, undefined, { order: 0.5 });
      for (let i = 0; i < 2; i++) b.seat('bench', 'bench', x + 2 + i, 0, 'down', undefined, { noFurniture: true, furnitureId: bench });
      b.furn('plant_tall', x + 13, 0, 'monstera', { order: 0.5 });
    } else {
      // colunas de projeto alternam: bebedouro (pares) e banco de espera (ímpares), contadas sem o miolo
      const k = c < core[0] ? c : c - core.length;
      if (k % 2 === 0) {
        b.furn('water_cooler', x + 3, 0, undefined, { order: 0.5 });
        b.spot('water', x + 3, 1, 'up', { dy: -3 });
        b.furn('plant_small', x + 4, 0, SMALL[k % SMALL.length], { order: 0.5 });
      } else {
        const bench = b.furn('bench', x + 11, 0, undefined, { order: 0.5 });
        for (let i = 0; i < 2; i++) b.seat('bench', 'bench', x + 11 + i, 0, 'down', undefined, { noFurniture: true, furnitureId: bench });
        b.furn('plant_tall', x + 13, 0, TALL[k % TALL.length], { order: 0.5 });
      }
      if (k % 2 === 1) b.furn('plant_small', x + 12, 4, SMALL[(k + 1) % SMALL.length], { order: 0.5 });
    }
    // planta alta onde as paredes das salas se encontram (uma coluna sim, outra não)
    if (c !== hi && c % 2 === 1) b.furn('plant_tall', x + 15, 4, TALL[(c + 1) % TALL.length], { order: 0.5 });
    // passadeira estreita (um trecho por coluna), centrada no corredor
    b.rug(x + 2, 1.95, COL_W - 4, 1.1, RUNNERS[c % RUNNERS.length], 502 + c);
    // pontos de conversa no meio do corredor (o group leva o id da área: Spots.byGroup é global)
    b.spot('talk', x + 5, 2, 'right', { group: `${id}:talk:${c}`, dx: -1 });
    b.spot('talk', x + 6, 2, 'left', { group: `${id}:talk:${c}`, dx: 1 });
  }
  return b.build();
}
