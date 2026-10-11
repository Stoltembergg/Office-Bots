// Miolo dos anexos (spec 3.1): saguão (chegada da passarela) ao norte do corredor e WC ao sul, na coluna do miolo.
// O saguão reúne, em menor, o que o principal espalha: um canto de café e água, um banheirinho atrás de vidro,
// banco de espera e um ponto de conversa. A planta do WC é a mesma do banheiro do principal, com outro id.
import { AreaBuilder } from './builder';
import { CORE_WALLS, layoutRestroom } from './core';
import { blockColumnRect, blockKey, coreColumns, type BlockId } from './geometry';
import type { AreaLayout } from './types';

export function hubId(block: BlockId): string {
  return `anexo:${block.bx},${block.by}:saguao`;
}

export function annexRestroomId(block: BlockId): string {
  return `anexo:${block.bx},${block.by}:wc`;
}

/**
 * Saguão do anexo, na coluna do miolo ao norte do corredor. `exit` = há passarela chegando pela face norte: a face
 * ganha a porta externa (lx 7..10, 2 linhas, batente largo); sem passarela, uma janela fecha a face.
 */
export function layoutHub(block: BlockId, exit: boolean): AreaLayout {
  const id = hubId(block);
  const b = new AreaBuilder(id, 'hub', blockColumnRect(block, coreColumns(block)[0], 'north'));
  const wall = CORE_WALLS.reception;
  b.floor('marble', 0, 0, 16, 12, 601);
  b.rug(5, 5.2, 6, 2.6, '#3d5a80', 602);
  b.face(0.5, 15, wall, exit ? [{ lx: 7, w: 3 }] : []);
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);
  if (exit) {
    b.wall('door_frame', 8.5, 'wide3', { order: 0.05 });
    b.walk(7, 0, 3, 2);
    b.area.exit = { x: b.x0 + 7, y: b.y0, w: 3, h: 2 };
  } else {
    b.wall('window', 8.5, undefined, { order: 0.3 });
  }
  b.wall('clock', 5.5);
  // pôster entre a pia e a cabine: a face norte do saguão não tem trecho sem móvel embaixo para um quadro de 2 tiles
  b.wall('poster', 12.5, 'coffee', { order: 0.6 });

  // canto de café e água (oeste)
  b.furn('counter', 1, 2, 'drawers', { order: 0.3 });
  const machine = b.furn('coffee_machine', 2, 2, undefined, { order: 0.35 });
  b.spot('coffee', 2, 3, 'up', { dy: -3, furnitureId: machine });
  b.furn('counter', 3, 2, 'plain', { order: 0.3 });
  b.furn('water_cooler', 4, 2, undefined, { order: 0.4 });
  b.spot('water', 4, 3, 'up', { dy: -3 });
  b.furn('plant_small', 5, 2, 'fern', { order: 0.4 });

  // banheirinho (leste) atrás de uma divisória de vidro: pia com espelho e uma cabine
  for (const ly of [2, 3, 4]) b.furn('glass_partition', 10, ly, 'v', { order: 0.2 });
  b.furn('glass_partition', 10, 5, 'end', { order: 0.2 });
  b.wall('mirror', 11.5);
  b.furn('sink', 11, 2, undefined, { order: 0.3 });
  b.spot('sink', 11, 3, 'up', { dy: -3 });
  const stall = b.furn('toilet_stall', 13, 2, undefined, { order: 0.3 });
  b.spot('stall', 13, 4, 'up', { furnitureId: stall, x: b.px(14), y: b.py(4) - 3, sortY: b.py(4) - 0.5 });

  // espera e conversa
  const bench = b.furn('bench', 6, 8, undefined, { order: 0.5 });
  for (let i = 0; i < 2; i++) b.seat('bench', 'bench', 6 + i, 8, 'down', undefined, { noFurniture: true, furnitureId: bench });
  b.spot('talk', 10, 8, 'right', { group: `talk:${id}`, dx: -1 });
  b.spot('talk', 11, 8, 'left', { group: `talk:${id}`, dx: 1 });
  b.furn('plant_tall', 1, 9, 'palm', { order: 0.5 });
  b.furn('plant_tall', 14, 9, 'ficus', { order: 0.5 });
  b.furn('trash_bin', 14, 6, undefined, { order: 0.4 });

  // aberto para o corredor ao sul, com vidro só nas pontas (como a recepção)
  for (const lx of [1, 2, 3, 12, 13, 14]) b.furn('glass_partition', lx, 11, 'h', { order: 0.15 });
  b.walk(1, 2, 14, 10);
  return b.build();
}

const hubCache = new Map<string, AreaLayout[]>();

/** Saguão e WC do anexo, calculados uma vez por (bloco, com/sem passarela). */
export function hubAreas(block: BlockId, exit: boolean): AreaLayout[] {
  const key = `${blockKey(block)}:${exit ? 1 : 0}`;
  const cached = hubCache.get(key);
  if (cached) return cached;
  const core = coreColumns(block)[0];
  const areas = [layoutHub(block, exit), layoutRestroom(blockColumnRect(block, core, 'south'), annexRestroomId(block))];
  hubCache.set(key, areas);
  return areas;
}
