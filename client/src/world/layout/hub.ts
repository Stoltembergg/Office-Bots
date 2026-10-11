// Miolo dos anexos (spec 3.1, D1): saguão e WC na coluna do miolo, um de cada lado do corredor. O saguão fica do lado
// por onde a passarela própria chega (norte na fileira 1, sul nos demais) e o WC do outro. O saguão reúne, em menor,
// o que o principal espalha: um canto de café e água, um banheirinho atrás de vidro, banco de espera e um ponto de
// conversa. A planta do WC é a mesma do banheiro do principal, com outro id.
import { AreaBuilder } from './builder';
import { CORE_WALLS, layoutRestroom } from './core';
import { blockColumnRect, blockKey, BRIDGE_W, coreColumns, DOOR_LX, HUB_DOOR_H, hubSide, LOUNGE_EXIT_H, type BlockId, type Side } from './geometry';
import type { AreaLayout } from './types';

export function hubId(block: BlockId): string {
  return `anexo:${block.bx},${block.by}:saguao`;
}

export function annexRestroomId(block: BlockId): string {
  return `anexo:${block.bx},${block.by}:wc`;
}

/**
 * Saguão do anexo, na coluna do miolo, do lado `side` do corredor. `door` = há passarela encostando na parede externa
 * (a própria, ou a do filho (bx, 1) que sai pela parede sul de um anexo lateral): a parede externa ganha a porta
 * (lx 7..10). Ao norte, a face é a parede externa (porta de 2 linhas com batente largo; sem porta, uma janela) e o
 * lado do corredor fica aberto com vidro só nas pontas, como a recepção antiga. Ao sul, a face abre para o corredor
 * com uma passagem larga (como o lounge) e a parede sul é a externa (porta de 1 linha, como a saída do lounge).
 */
export function layoutHub(block: BlockId, side: Side, door: boolean): AreaLayout {
  const id = hubId(block);
  const b = new AreaBuilder(id, 'hub', blockColumnRect(block, coreColumns(block)[0], side));
  const wall = CORE_WALLS.reception;
  b.floor('marble', 0, 0, 16, 12, 601);
  b.rug(5, 5.2, 6, 2.6, '#3d5a80', 602);
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);
  if (side === 'north') {
    b.face(0.5, 15, wall, door ? [{ lx: DOOR_LX, w: BRIDGE_W }] : []);
    if (door) {
      b.wall('door_frame', DOOR_LX + BRIDGE_W / 2, 'wide3', { order: 0.05 });
      b.walk(DOOR_LX, 0, BRIDGE_W, HUB_DOOR_H);
      b.area.exit = { x: b.x0 + DOOR_LX, y: b.y0, w: BRIDGE_W, h: HUB_DOOR_H };
    } else {
      b.wall('window', 8.5, undefined, { order: 0.3 });
    }
    // aberto para o corredor ao sul, com vidro só nas pontas
    for (const lx of [1, 2, 3, 12, 13, 14]) b.furn('glass_partition', lx, 11, 'h', { order: 0.15 });
    b.walk(1, 2, 14, 10);
  } else {
    b.face(0.5, 6.5, wall);
    b.face(10, 5.5, wall);
    b.walk(7, 0, 3, 2);
    b.area.door = { x: b.x0 + 7, y: b.y0, w: 3, h: 2 };
    b.south(0.5, 15, 11, { ...wall, exterior: true }, door ? [{ lx: DOOR_LX, w: BRIDGE_W }] : []);
    if (door) {
      b.walk(DOOR_LX, 11, BRIDGE_W, LOUNGE_EXIT_H);
      b.area.exit = { x: b.x0 + DOOR_LX, y: b.y0 + 11, w: BRIDGE_W, h: LOUNGE_EXIT_H };
    }
    b.walk(1, 2, 14, 9);
  }
  b.wall('clock', 5.5);
  // pôster entre a pia e a cabine: a face do saguão não tem trecho sem móvel embaixo para um quadro de 2 tiles
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
  return b.build();
}

const hubCache = new Map<string, AreaLayout[]>();

/**
 * Saguão e WC do anexo, calculados uma vez por (bloco, porta externa). `door` é o lado da porta externa do saguão
 * (`hubDoor`), ou null sem passarela encostando; quando existe, é sempre o lado do saguão (`hubSide`).
 */
export function hubAreas(block: BlockId, door: Side | null): AreaLayout[] {
  const key = `${blockKey(block)}:${door ?? '-'}`;
  const cached = hubCache.get(key);
  if (cached) return cached;
  const side = hubSide(block);
  const other: Side = side === 'north' ? 'south' : 'north';
  const core = coreColumns(block)[0];
  const areas = [layoutHub(block, side, door !== null), layoutRestroom(blockColumnRect(block, core, other), annexRestroomId(block), other)];
  hubCache.set(key, areas);
  return areas;
}
