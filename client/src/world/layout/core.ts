// Núcleo do prédio principal (colunas 2 e 3 do bloco): recepção com elevadores, banheiros, copa e lounge.
// Cada área recebe o retângulo (16×12, tiles absolutos) da coluna em que fica; tudo dentro dela é local a ele.
import type { WallStyle } from '../../art/api';
import { TILE } from '../constants';
import { AreaBuilder, SEATED_SORT_BIAS } from './builder';
import { blockColumnRect, blockKey, BRIDGE_W, DOOR_LX, HUB_DOOR_H, LOUNGE_EXIT_H, type BlockId, type Side } from './geometry';
import type { AreaLayout, TileRect } from './types';

export const RECEPTION_ID = 'core:recepcao';
export const RESTROOM_ID = 'core:banheiros';
export const CAFE_ID = 'core:copa';
export const LOUNGE_ID = 'core:lounge';

/** Paredes do núcleo: tons claros e neutros (frios), com acabamentos diferentes por ambiente. */
export const CORE_WALLS = {
  reception: { base: '#e9e5dc', trim: '#a88e6c', pattern: 'wood_panel' } satisfies WallStyle,
  restroom: { base: '#dce8ee', trim: '#8fb0c0', pattern: 'tiles' } satisfies WallStyle,
  cafe: { base: '#eef0ee', trim: '#9aa6ad', pattern: 'plain' } satisfies WallStyle,
  cafeSplash: { base: '#d9dcdf', trim: '#8d969e', pattern: 'marble' } satisfies WallStyle,
  lounge: { base: '#e6e2ea', trim: '#8f8aa3', pattern: 'plain' } satisfies WallStyle,
  glass: { base: '#cfe6f0', trim: '#9fb9c6', pattern: 'glass' } satisfies WallStyle,
};

/** Centros (em tiles locais) dos dois elevadores na face da recepção (a oeste da porta do corredor, lx 7..9). */
export const ELEVATOR_CX = [3, 5.5] as const;

export function layoutReception(rect: TileRect): AreaLayout {
  const b = new AreaBuilder(RECEPTION_ID, 'reception', rect);
  const wall = CORE_WALLS.reception;
  b.floor('marble', 0, 0, 16, 12, 101);
  b.rug(1.5, 2.2, 6.5, 2.6, '#3d5a80', 102);
  b.rug(8.6, 6.4, 5.2, 3.2, '#b65f3a', 103);
  // ao sul do corredor (a entrada do prédio é pela rua): a face norte abre para o corredor (porta de 2 tiles com batente) e a parede sul tem a
  // entrada do prédio, de 3 tiles, dando no caminho de pedra até a calçada. Os elevadores ficam na face, a oeste da porta.
  b.face(0.5, 15, wall, [{ lx: 7, w: 2 }]);
  b.wall('door_frame', 8, undefined, { order: 0.05 });
  b.south(0.5, 15, 11, { ...wall, exterior: true }, [{ lx: DOOR_LX, w: BRIDGE_W }]);
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);

  // elevadores (decoração: todos chegam e vão embora pela porta da rua, ao sul)
  ELEVATOR_CX.forEach((cx, i) => {
    b.wall('elevator', cx, undefined, { order: 0.2 + i * 0.1 });
    const lx = Math.floor(cx - 0.5);
    b.spot('elevator', lx, 2, 'up', { x: b.px(cx), y: b.py(2) + 2, group: `elevator:${i}` });
  });
  // face sem sobreposição: elevadores 2..4 e 4,5..6,5 | porta 7..9 | relógio 9,5..10,5 | placa 10,5..13,5 |
  // quadro 13,5..15,5 (a cap leste começa em 15,5)
  b.wall('sign', 12, undefined, { order: 0.9 });
  b.wall('clock', 10, undefined, { order: 0.7 });
  b.wall('painting', 14.5, undefined, { order: 0.6 });

  b.furn('plant_tall', 1, 2, 'monstera', { order: 0.2 });
  b.furn('plant_tall', 14, 4, 'ficus', { order: 0.21 });
  b.furn('reception_desk', 9, 5, undefined, { order: 0.4 });
  b.furn('plant_small', 12, 5, 'flower', { order: 0.45 });
  b.furn('filing_cabinet', 8, 5, undefined, { order: 0.42 });
  // cantinho de espera com poltronas
  b.seat('armchair', 'armchair', 9, 8, 'right', 'right', { order: 0.6 });
  b.furn('coffee_table', 10, 8, undefined, { order: 0.58 });
  b.seat('armchair', 'armchair', 12, 8, 'left', 'left', { order: 0.61 });
  b.furn('plant_tall', 14, 9, 'palm', { order: 0.22 });

  // banco de espera (olhando para baixo)
  const bench = b.furn('bench', 2, 7, undefined, { order: 0.5 });
  for (let i = 0; i < 2; i++) b.seat('bench', 'bench', 2 + i, 7, 'down', undefined, { noFurniture: true, furnitureId: bench });
  b.furn('plant_small', 4, 7, 'fern', { order: 0.52 });
  b.furn('water_cooler', 1, 7, undefined, { order: 0.53 });
  b.spot('water', 1, 8, 'up', { dy: -3 });

  b.walk(1, 2, 14, 9);
  b.walk(7, 0, 2, 2);
  b.area.door = { x: b.x0 + 7, y: b.y0, w: 2, h: 2 };
  b.walk(DOOR_LX, 11, BRIDGE_W, LOUNGE_EXIT_H);
  b.area.exit = { x: b.x0 + DOOR_LX, y: b.y0 + 11, w: BRIDGE_W, h: LOUNGE_EXIT_H };
  b.spot('talk', 6, 9, 'right', { group: 'talk:recepcao', dx: -1 });
  b.spot('talk', 7, 9, 'left', { group: 'talk:recepcao', dx: 1 });

  const a = b.build();
  a.shade = undefined;
  return a;
}

/** Banheiros: o do principal (`core:banheiros`) e, com outro `id`, o WC dos anexos (mesma planta). */
/** WC: ao sul do corredor (porta na face, com batente) ou ao norte (porta na mureta sul, como as salas do norte). */
export function layoutRestroom(rect: TileRect, id = RESTROOM_ID, side: Side = 'south'): AreaLayout {
  const b = new AreaBuilder(id, 'restroom', rect);
  const wall = CORE_WALLS.restroom;
  b.floor('tile_white', 0, 0, 16, 12, 201);
  // tapetinho só na frente das pias (nada de tapete grande no meio do banheiro)
  b.rug(2, 3.15, 3, 0.85, '#6fa3b8', 202);
  if (side === 'south') {
    b.face(0.5, 15, wall, [{ lx: 7, w: 2 }]);
    b.wall('door_frame', 8, undefined, { order: 0.05 });
    b.south(0.5, 15, 11, { ...wall, exterior: true });
    b.walk(7, 0, 2, 2);
    b.area.door = { x: b.x0 + 7, y: b.y0, w: 2, h: 2 };
  } else {
    b.face(0.5, 15, { ...wall, exterior: true });
    b.south(0.5, 15, 11, wall, [{ lx: 7, w: 2 }]);
    b.walk(7, 11, 2, 1);
    b.area.door = { x: b.x0 + 7, y: b.y0 + 11, w: 2, h: 1 };
  }
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);
  b.walk(1, 2, 14, 9);

  // pias com espelho
  for (let i = 0; i < 3; i++) {
    b.wall('mirror', 2.5 + i, undefined, { order: 0.3 });
    b.furn('sink', 2 + i, 2, undefined, { order: 0.35 });
    b.spot('sink', 2 + i, 3, 'up', { dy: -3 });
  }
  b.furn('trash_bin', 5, 2, undefined, { order: 0.4 });
  b.furn('plant_small', 1, 2, 'fern', { order: 0.2 });
  b.wall('clock', 6, undefined, { order: 0.5 });

  // cabines encostadas na parede norte (entram pela porta ao sul e somem)
  for (let i = 0; i < 3; i++) {
    const lx = 9 + i * 2;
    const stall = b.furn('toilet_stall', lx, 2, undefined, { order: 0.3 + i * 0.05 });
    b.spot('stall', lx, 4, 'up', { furnitureId: stall, x: b.px(lx + 1), y: b.py(4) - 3, sortY: b.py(4) - 0.5 });
  }
  b.wall('poster', 1.5, 'cat', { order: 0.5 });
  b.furn('plant_small', 14, 6, 'succulent', { order: 0.2 });
  b.furn('plant_tall', 1, 10, 'ficus', { order: 0.21 });
  b.furn('plant_tall', 14, 10, 'monstera', { order: 0.22 });
  const bench = b.furn('bench', 3, 9, undefined, { order: 0.5 });
  for (let i = 0; i < 2; i++) b.seat('bench', 'bench', 3 + i, 9, 'down', undefined, { noFurniture: true, furnitureId: bench });
  b.furn('trash_bin', 9, 10, undefined, { order: 0.6 });
  b.rug(2.5, 9.9, 3, 0.9, '#9cc3cf', 203);
  b.furn('plant_small', 1, 6, 'flower', { order: 0.24 });
  b.furn('plant_small', 12, 10, 'fern', { order: 0.25 });
  return b.build();
}

/** `open` = há passarela saindo pela porta norte (a do anexo ao norte da rua norte); sem ela a parede fica fechada. */
export function layoutCafe(rect: TileRect, open = true): AreaLayout {
  const b = new AreaBuilder(CAFE_ID, 'cafe', rect);
  const wall = CORE_WALLS.cafe;
  b.floor('tile_check', 0, 0, 16, 12, 301);
  // frontão de mármore atrás da bancada (oeste) + porta norte de 3 tiles (saída para a passarela do anexo ao norte, em lx 7..10)
  // + parede clara com janela (leste)
  b.face(0.5, 6.5, CORE_WALLS.cafeSplash);
  b.face(10, 5.5, wall);
  if (open) {
    b.wall('door_frame', DOOR_LX + BRIDGE_W / 2, 'wide3', { order: 0.05 });
    b.walk(DOOR_LX, 0, BRIDGE_W, HUB_DOOR_H);
    b.area.exit = { x: b.x0 + DOOR_LX, y: b.y0, w: BRIDGE_W, h: HUB_DOOR_H };
  } else {
    b.face(DOOR_LX, BRIDGE_W, wall);
  }
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);

  // bancada encostada na parede norte, a oeste da porta
  b.furn('fridge', 1, 2, undefined, { order: 0.2 });
  b.spot('fridge', 1, 3, 'up', { dy: -3 });
  b.furn('counter', 2, 2, 'drawers', { order: 0.22 });
  b.furn('counter_sink', 3, 2, undefined, { order: 0.24 });
  b.spot('sink', 3, 3, 'up', { dy: -3 });
  b.furn('microwave', 4, 2, undefined, { order: 0.26 });
  for (const lx of [5, 6]) {
    const m = b.furn('coffee_machine', lx, 2, undefined, { order: 0.28 });
    b.spot('coffee', lx, 3, 'up', { dy: -3, furnitureId: m });
  }
  b.wall('shelf_wall', 3, undefined, { order: 0.4 });
  // cardápio do café acima das cafeteiras
  b.wall('poster', 5.5, 'coffee', { order: 0.45 });

  // a leste da porta: máquina de lanche, bebedouro e a janela (nada alto na frente dela)
  const vend = b.furn('vending_machine', 10, 2, undefined, { order: 0.34 });
  b.spot('snack', 10, 3, 'up', { dy: -3, furnitureId: vend });
  b.furn('water_cooler', 11, 2, undefined, { order: 0.36 });
  b.spot('water', 11, 3, 'up', { dy: -3 });
  b.wall('window', 13.25, undefined, { order: 0.4 });
  b.spot('window', 12, 2, 'up', { dx: 12, dy: 1 });
  b.spot('window', 13, 2, 'up', { dx: 8, dy: 1 });

  // mesa comunitária comprida no centro, sobre um tapete, com cadeiras dos dois lados
  b.rug(2.6, 4.15, 8.8, 3.7, '#b98a5e', 302);
  b.furn('meeting_table', 4, 5, undefined, { order: 0.5 });
  b.furn('meeting_table', 7, 5, undefined, { order: 0.51 });
  for (let i = 0; i < 6; i++) {
    const lx = 4 + i;
    b.seat('cafe_seat', 'cafe_chair', lx, 4, 'down', 'down', { order: 0.55 + i * 0.01 });
    b.seat('cafe_seat', 'cafe_chair', lx, 7, 'up', 'up', { order: 0.62 + i * 0.01 });
  }
  b.furn('plant_small', 3, 5, 'flower', { order: 0.52 });

  // mesinhas bistrô junto às janelas
  for (const [lx, ly, i] of [
    [12, 5, 0],
    [12, 8, 1],
  ] as const) {
    b.furn('cafe_table', lx, ly, undefined, { order: 0.7 + i * 0.03 });
    b.seat('cafe_seat', 'cafe_chair', lx - 1, ly, 'right', 'right', { order: 0.72 + i * 0.03 });
    b.seat('cafe_seat', 'cafe_chair', lx + 1, ly, 'left', 'left', { order: 0.73 + i * 0.03 });
  }
  b.furn('plant_tall', 1, 10, 'monstera', { order: 0.2 });
  b.furn('plant_tall', 14, 10, 'ficus', { order: 0.21 });
  b.furn('trash_bin', 1, 6, undefined, { order: 0.6 });

  // aberta para o corredor com vidro
  for (const lx of [1, 2, 3, 4, 5, 10, 11, 12, 13, 14]) b.furn('glass_partition', lx, 11, 'h', { order: 0.15 });
  b.walk(1, 2, 14, 10);
  b.spot('talk', 7, 9, 'right', { group: 'talk:copa', dx: -1 });
  b.spot('talk', 8, 9, 'left', { group: 'talk:copa', dx: 1 });
  b.area.shade = undefined;
  return b.build();
}

/** `open` = há passarela saindo pela porta sul (lx 7..10); sem ela a parede sul fica fechada. */
export function layoutLounge(rect: TileRect, open = true): AreaLayout {
  const b = new AreaBuilder(LOUNGE_ID, 'lounge', rect);
  const wall = CORE_WALLS.lounge;
  b.floor('wood', 0, 0, 16, 12, 401);
  b.rug(1.5, 3.2, 7, 5.2, '#4f8a5b', 402);
  b.rug(9.2, 4.6, 5.6, 4.4, '#d7c8a8', 403);
  // parede com TV a oeste; vidro a leste; passagem larga no meio
  b.face(0.5, 6.5, wall);
  b.face(10, 5.5, CORE_WALLS.glass);
  // parede sul com a porta da passarela (lx 7..10); sem passarela a parede é inteira
  b.south(0.5, 15, 11, { ...wall, exterior: true }, open ? [{ lx: DOOR_LX, w: BRIDGE_W }] : []);
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);
  b.walk(1, 2, 14, 9);
  b.walk(7, 0, 3, 2);
  b.area.door = { x: b.x0 + 7, y: b.y0, w: 3, h: 2 };
  if (open) {
    b.walk(DOOR_LX, 11, BRIDGE_W, LOUNGE_EXIT_H);
    b.area.exit = { x: b.x0 + DOOR_LX, y: b.y0 + 11, w: BRIDGE_W, h: LOUNGE_EXIT_H };
  }

  furnishLounge(b, null);
  return b.build();
}

/**
 * Mobília do lounge, a mesma no principal e nos anexos. `cafe` (só nos anexos) troca o quadro e a planta do canto
 * oeste por um canto de café e água, e `tv` diz onde pendurar a TV (nulo = não pendura, como no principal que a põe
 * em 4,5). Os grupos de spots levam o id da área quando não é o lounge principal, para não colidirem.
 */
export function furnishLounge(b: AreaBuilder, cafe: { tv: number | null } | null): void {
  const sfx = b.area.id === LOUNGE_ID ? '' : `:${b.area.id}`;
  if (cafe) {
    if (cafe.tv !== null) b.wall('tv', cafe.tv, undefined, { order: 0.4 });
  } else {
    b.wall('tv', 4.5, undefined, { order: 0.4 });
    b.wall('painting', 1.75, undefined, { order: 0.5 });
  }

  // sofá de costas para a câmera, de frente para a TV
  const sofa = b.furn('sofa', 3, 6, 'up', { order: 0.5 });
  for (let i = 0; i < 3; i++) b.seat('sofa', 'sofa', 3 + i, 6, 'up', 'up', { noFurniture: true, furnitureId: sofa });
  b.furn('coffee_table', 3, 4, undefined, { dx: TILE / 2, order: 0.45 });
  b.block(5, 4, 1, 1);
  b.seat('armchair', 'armchair', 2, 4, 'right', 'right', { order: 0.55 });
  b.seat('armchair', 'armchair', 6, 4, 'left', 'left', { order: 0.56 });

  // ping-pong (jogadores nas pontas oeste/leste)
  b.furn('pingpong_table', 10, 6, undefined, { order: 0.4 });
  const ppY = b.py(7) + 5;
  const ppSort = b.py(8) + SEATED_SORT_BIAS;
  b.spot('pingpong', 9, 7, 'right', { x: b.px(10) - 8, y: ppY, group: `pingpong${sfx}`, sortY: ppSort });
  b.spot('pingpong', 13, 7, 'left', { x: b.px(13) + 8, y: ppY, group: `pingpong${sfx}`, sortY: ppSort });

  // fliperamas e estantes
  for (const lx of [13, 14]) {
    b.furn('arcade', lx, 2, undefined, { order: 0.3 });
    b.spot('arcade', lx, 3, 'up', { dy: -3 });
  }
  b.furn('bookshelf', 10, 2, undefined, { order: 0.3 });
  b.spot('shelf', 10, 3, 'up', { dx: 8, dy: -2 });
  b.furn('binder_shelf', 12, 2, undefined, { order: 0.31 });
  // planta baixa sob o quadro (uma alta cobriria a pintura)
  if (cafe) {
    b.furn('counter', 1, 2, 'drawers', { order: 0.3 });
    const machine = b.furn('coffee_machine', 2, 2, undefined, { order: 0.35 });
    b.spot('coffee', 2, 3, 'up', { dy: -3, furnitureId: machine });
    b.furn('counter', 3, 2, 'plain', { order: 0.3 });
    b.furn('water_cooler', 4, 2, undefined, { order: 0.4 });
    b.spot('water', 4, 3, 'up', { dy: -3 });
  }
  b.furn('plant_small', cafe ? 5 : 1, 2, 'fern', { order: 0.2 });
  b.furn('plant_tall', 6, 2, 'palm', { order: 0.21 });
  b.furn('printer', 1, 10, undefined, { order: 0.3 });
  b.furn('floor_lamp', 1, 7, undefined, { order: 0.32 });
  b.furn('plant_tall', 14, 10, 'monstera', { order: 0.22 });

  // puffs
  // dois puffs, um de cada lado do caminho da porta sul (lx 7..9 ficam livres)
  (['red', 'yellow'] as const).forEach((c, i) => {
    b.seat('beanbag', 'beanbag', 6 + i * 4, 9, 'down', c, { order: 0.6 + i * 0.02 });
  });
  b.spot('talk', 11, 9, 'right', { group: `talk:lounge${sfx}`, dx: -1 });
  b.spot('talk', 12, 9, 'left', { group: `talk:lounge${sfx}`, dx: 1 });
  // torcida do ping-pong: atrás da mesa, de frente para a câmera
  b.spot('watch', 10, 5, 'down', { group: `watch:pingpong${sfx}`, dx: 2 });
  b.spot('watch', 12, 5, 'down', { group: `watch:pingpong${sfx}`, dx: -2 });
}

const coreCache = new Map<string, AreaLayout[]>();

/** Portas externas do núcleo que têm passarela: a sul do lounge (para A1) e a norte da copa (para A6). */
export interface CoreDoors {
  lounge: boolean;
  cafe: boolean;
}

/**
 * As quatro áreas do núcleo de um bloco: recepção e WC na coluna 2, copa e lounge na coluna 3 (no principal,
 * x 32..64). As portas do lounge e da copa só abrem com passarela (`doors`); sem ela a parede é inteira.
 * Calculadas uma vez por bloco e por combinação de portas: a mesma lista volta a cada chamada.
 */
export function coreAreas(block: BlockId, doors: CoreDoors = { lounge: false, cafe: false }): AreaLayout[] {
  const key = `${blockKey(block)}:${doors.lounge ? 1 : 0}${doors.cafe ? 1 : 0}`;
  const cached = coreCache.get(key);
  if (cached) return cached;
  const areas = [
    layoutReception(blockColumnRect(block, 2, 'south')),
    layoutRestroom(blockColumnRect(block, 2, 'north'), RESTROOM_ID, 'north'),
    layoutCafe(blockColumnRect(block, 3, 'north'), doors.cafe),
    layoutLounge(blockColumnRect(block, 3, 'south'), doors.lounge),
  ];
  coreCache.set(key, areas);
  return areas;
}
