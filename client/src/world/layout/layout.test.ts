import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE, type FurnitureKind, type RoomTheme } from '../../art/api';
import { BUILDING_H, COL_W, CORRIDOR_H, CORRIDOR_Y, ROOM_H, SOUTH_Y } from '../constants';
import { PathFinder } from '../path/astar';
import { layoutBridge } from './bridge';
import { assembleBuilding, type BuildingLayout } from './building';
import * as core from './core';
import { CORRIDOR_ID, corridorId } from './corridor';
import { bridgesFor, existingBlocks, inRect, isCoreColumn, PRINCIPAL, slotAt } from './geometry';
import { annexRestroomId, hubAreas, hubId, layoutHub } from './hub';
import { layoutProjectRoom, roomVariant } from './room';
import { ENTRANCE_DEPTH, ENTRANCE_W, ENTRANCE_X, EXTERIOR_WALL, layoutExterior, slotShell, type ExteriorLayout, type SlotShell, type Street } from './exterior';
import type { AreaLayout } from './types';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

function roomsFor(slots: number[]): AreaLayout[] {
  return slots.map((slot) => layoutProjectRoom({ id: `/proj/${slot}`, slot, seed: 1000 + slot * 77 }, theme));
}

/** Corredor do principal: a área fixa de id `CORRIDOR_ID` (o campo `corridor` do BuildingLayout não existe mais). */
function corridorOf(b: BuildingLayout): AreaLayout {
  return b.areas.find((a) => a.id === CORRIDOR_ID)!;
}

/** Prédio montado com as salas das vagas dadas (as vagas 8..15 montam o anexo 1; 16..23, A2 a leste; e assim por diante). */
function buildFor(slots: number[]): { rooms: AreaLayout[]; b: BuildingLayout; corridor: AreaLayout } {
  const rooms = roomsFor(slots);
  const b = assembleBuilding(existingBlocks(slots), rooms);
  return { rooms, b, corridor: corridorOf(b) };
}

describe('montagem por blocos', () => {
  it('com uma sala (vaga 0 → coluna 4 norte) o prédio tem as colunas 2–4, como hoje com 1 sala', () => {
    const { b, rooms, corridor } = buildFor([0]);
    expect(b.blocks).toHaveLength(1);
    expect(b.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
    expect(b.rect).toEqual({ x: 32, y: 0, w: 48, h: 29 });
    expect(corridor.rect).toEqual({ x: 32, y: 12, w: 48, h: 5 });
    expect(b.areas.find((a) => a.id === core.RECEPTION_ID)!.rect).toEqual({ x: 32, y: 17, w: 16, h: 12 });
    expect(rooms[0].rect).toEqual({ x: 64, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(b.rooms).toHaveLength(1);
    expect(b.areas.map((a) => a.id)).toEqual(['core:recepcao', 'core:banheiros', 'core:copa', 'core:lounge', CORRIDOR_ID]);
    // o BuildingLayout só tem o modelo de blocos: sem cols, core nem corridor
    expect(Object.keys(b).sort()).toEqual(['areas', 'blocks', 'bridges', 'grid', 'rect', 'rooms', 'spots']);
  });

  it('sem sala: só o miolo (colunas 2–3, x 32..64) e a grade começa em x 32', () => {
    const { b } = buildFor([]);
    expect(b.blocks[0].columns).toEqual({ lo: 2, hi: 3 });
    expect(b.rect).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(b.grid.x0).toBe(32);
    expect(b.grid.y0).toBe(0);
    expect(b.grid.w).toBe(32);
    expect(b.grid.h).toBe(BUILDING_H);
    expect(b.rooms).toEqual([]);
  });

  it('vagas 0 e 1: uma sala de cada lado do miolo (colunas 1–4)', () => {
    const { b, rooms } = buildFor([0, 1]);
    expect(b.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    expect(b.rect).toEqual({ x: 16, y: 0, w: 64, h: 29 });
    expect(rooms[1].rect).toEqual({ x: 16, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[1].side).toBe('north');
  });

  it('sala só a oeste (vaga 1): colunas 1–3, corredor x 16..64 com vidro nas duas pontas, grade com origem 16 e recepção alcançável', () => {
    const { b, rooms, corridor } = buildFor([1]);
    expect(b.blocks[0].columns).toEqual({ lo: 1, hi: 3 });
    expect(b.rect).toEqual({ x: 16, y: 0, w: 48, h: 29 });
    expect(corridor.rect).toEqual({ x: 16, y: CORRIDOR_Y, w: 48, h: CORRIDOR_H });
    expect(b.grid.x0).toBe(16);
    expect(b.grid.w).toBe(48);
    // vidro em lx 0 e w − 1 em todas as linhas do corredor; só o miolo (lx 1..w − 2) é caminhável
    const glass = corridor.furniture.filter((f) => f.kind === 'glass_partition');
    for (let ly = 0; ly < CORRIDOR_H; ly++) {
      expect(glass.some((f) => f.tx === 16 && f.ty === CORRIDOR_Y + ly)).toBe(true);
      expect(glass.some((f) => f.tx === 63 && f.ty === CORRIDOR_Y + ly)).toBe(true);
    }
    expect(b.grid.walkable(16, CORRIDOR_Y + 2)).toBe(false);
    expect(b.grid.walkable(17, CORRIDOR_Y + 2)).toBe(true);
    expect(b.grid.walkable(62, CORRIDOR_Y + 2)).toBe(true);
    expect(b.grid.walkable(63, CORRIDOR_Y + 2)).toBe(false);
    // do elevador (recepção, coluna 2) até a porta e todos os spots da sala (coluna 1)
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const door = rooms[0].door!;
    expect(reach[b.grid.key(door.x, door.y)]).toBe(1);
    for (const s of rooms[0].spots) expect(reach[b.grid.key(s.tx, s.ty)], s.id).toBe(1);
  });

  it('sala só na coluna 0 (vaga 5): colunas 0–3, a coluna 1 fica vazia no meio e a sala continua alcançável', () => {
    const { b, rooms, corridor } = buildFor([5]);
    expect(b.blocks[0].columns).toEqual({ lo: 0, hi: 3 });
    expect(b.rect).toEqual({ x: 0, y: 0, w: 64, h: 29 });
    expect(b.grid.x0).toBe(0);
    expect(corridor.rect).toEqual({ x: 0, y: CORRIDOR_Y, w: 64, h: CORRIDOR_H });
    expect(rooms[0].rect).toEqual({ x: 0, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === COL_W)).toBe(false);
    // vidro na ponta oeste (x 0); o tile seguinte é corredor caminhável
    expect(b.grid.walkable(0, CORRIDOR_Y + 2)).toBe(false);
    expect(b.grid.walkable(1, CORRIDOR_Y + 2)).toBe(true);
    // do elevador (recepção, coluna 2) até a porta e todos os spots da sala, atravessando a coluna 1 vazia
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const door = rooms[0].door!;
    expect(reach[b.grid.key(door.x, door.y)]).toBe(1);
    for (const s of rooms[0].spots) expect(reach[b.grid.key(s.tx, s.ty)], s.id).toBe(1);
    // a coluna vazia tem o corredor completo: os dois pontos de conversa dela existem sem sala
    expect(b.spots.filter((s) => s.group === 'core:corredor:talk:1')).toHaveLength(2);
  });

  it('sala só na coluna 5 (vaga 4): colunas 2–5, a coluna 4 fica vazia no meio e a sala continua alcançável', () => {
    const { b, rooms, corridor } = buildFor([4]);
    expect(b.blocks[0].columns).toEqual({ lo: 2, hi: 5 });
    expect(b.rect).toEqual({ x: 32, y: 0, w: 64, h: 29 });
    expect(b.grid.x0).toBe(32);
    expect(corridor.rect).toEqual({ x: 32, y: CORRIDOR_Y, w: 64, h: CORRIDOR_H });
    expect(rooms[0].rect).toEqual({ x: 80, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === 4 * COL_W)).toBe(false);
    // vidro na ponta leste (x 95); o tile antes dele é corredor caminhável
    expect(b.grid.walkable(95, CORRIDOR_Y + 2)).toBe(false);
    expect(b.grid.walkable(94, CORRIDOR_Y + 2)).toBe(true);
    // do elevador (recepção, coluna 2) até a porta e todos os spots da sala, atravessando a coluna 4 vazia
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const door = rooms[0].door!;
    expect(reach[b.grid.key(door.x, door.y)]).toBe(1);
    for (const s of rooms[0].spots) expect(reach[b.grid.key(s.tx, s.ty)], s.id).toBe(1);
    expect(b.spots.filter((s) => s.group === 'core:corredor:talk:4')).toHaveLength(2);
  });

  it('todas as salas das vagas 0..7 são alcançáveis do elevador; ordem 4N, 1N, 4S, 1S, 5N, 0N, 5S, 0S', () => {
    const slots = [0, 1, 2, 3, 4, 5, 6, 7];
    const { b, rooms } = buildFor(slots);
    expect(b.blocks[0].columns).toEqual({ lo: 0, hi: 5 });
    expect(b.rect).toEqual({ x: 0, y: 0, w: 96, h: 29 });
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    for (const room of rooms) {
      const door = room.door!;
      expect(reach[b.grid.key(door.x, door.y)], room.id).toBe(1);
    }
    expect(rooms.map((r) => `${r.rect.x / COL_W}${r.side === 'north' ? 'N' : 'S'}`)).toEqual(['4N', '1N', '4S', '1S', '5N', '0N', '5S', '0S']);
  });

  it('vaga 16 abre A2 (1,0): o principal ganha a coluna 5 (ligação, sem sala), a sala fica na coluna 0 norte de A2 e a passarela horizontal liga os corredores', () => {
    const { b, rooms, corridor } = buildFor([0, 1, 2, 3, 16]);
    expect(b.blocks.map((blk) => [blk.id.bx, blk.id.by, blk.columns.lo, blk.columns.hi])).toEqual([
      [0, 0, 1, 5],
      [1, 0, 0, 2],
    ]);
    expect(b.rect).toEqual({ x: 16, y: 0, w: 140, h: 29 });
    expect(corridor.rect).toEqual({ x: 16, y: CORRIDOR_Y, w: 80, h: CORRIDOR_H });
    expect(rooms[4].rect).toEqual({ x: 108, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[4].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === 5 * COL_W)).toBe(false);
    // a ponta leste do corredor (x 95) é aberta e a passarela (x 96..107) é caminhável na altura do corredor
    expect(b.grid.walkable(95, CORRIDOR_Y + 2)).toBe(true);
    expect(b.grid.walkable(96, CORRIDOR_Y + 2)).toBe(true);
    expect(b.grid.walkable(96, CORRIDOR_Y)).toBe(false);
  });

  it('vaga 16 sozinha: principal nas colunas 2–5 (4 e 5 vazias), A2 nas colunas 0–2, e a sala em x 108 alcançável do elevador', () => {
    const { b, rooms, corridor } = buildFor([16]);
    expect(b.blocks.map((blk) => [blk.columns.lo, blk.columns.hi])).toEqual([
      [2, 5],
      [0, 2],
    ]);
    expect(b.rect).toEqual({ x: 32, y: 0, w: 124, h: 29 });
    expect(corridor.rect).toEqual({ x: 32, y: CORRIDOR_Y, w: 64, h: CORRIDOR_H });
    expect(rooms[0].rect).toEqual({ x: 108, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === 4 * COL_W || r.rect.x === 5 * COL_W)).toBe(false);
    // do elevador (recepção, coluna 2) até a porta da sala, atravessando duas colunas de pátio e a passarela
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const door = rooms[0].door!;
    expect(reach[b.grid.key(door.x, door.y)]).toBe(1);
    // os dois trechos vazios do corredor do principal e o corredor de A2 têm os seus pontos de conversa
    for (const c of [4, 5]) expect(b.spots.filter((s) => s.group === `core:corredor:talk:${c}`)).toHaveLength(2);
    expect(b.spots.filter((s) => s.group === 'anexo:1,0:corredor:talk:1')).toHaveLength(2);
  });

  it('Review Focus 4: sem passarela a parede sul do lounge é inteira (nenhum vão, tile da linha 28 bloqueado); com o anexo 1 abre', () => {
    const { b } = buildFor([0]);
    const lounge = b.areas.find((a) => a.id === core.LOUNGE_ID)!;
    expect(lounge.exit).toBeUndefined();
    expect(lounge.walls.find((w) => w.kind === 'south')!.doorways).toBeUndefined();
    expect(b.grid.walkable(56, 28)).toBe(false);
    expect(b.grid.inside(56, 29)).toBe(false);
    const com = buildFor([8]).b;
    expect(com.areas.find((a) => a.id === core.LOUNGE_ID)!.exit).toEqual({ x: 55, y: 28, w: 3, h: 1 });
    expect(com.grid.walkable(56, 28)).toBe(true);
  });

  it('a 9ª sala (vaga 8) monta o anexo 1 com saguão, WC e corredor, e a passarela do lounge ao saguão', () => {
    const { b, rooms } = buildFor([8]);
    expect(b.blocks.map((blk) => [blk.id.bx, blk.id.by, blk.columns.lo, blk.columns.hi])).toEqual([
      [0, 0, 2, 3],
      [0, 1, 2, 3],
    ]);
    expect(b.bridges.map((br) => br.id)).toEqual(['passarela:0,1']);
    expect(b.rect).toEqual({ x: 32, y: 0, w: 40, h: 70 });
    expect(b.areas.map((a) => a.id)).toEqual([
      'core:recepcao',
      'core:banheiros',
      'core:copa',
      'core:lounge',
      'anexo:0,1:saguao',
      'anexo:0,1:wc',
      'core:corredor',
      'anexo:0,1:corredor',
      'passarela:0,1',
    ]);
    expect(rooms[0].rect).toEqual({ x: 56, y: 41, w: 16, h: 12 }); // vaga 8 = coluna 3 norte do anexo
    expect(rooms[0].side).toBe('north');
    // o saguão tem a porta externa (há passarela)
    expect(b.areas.find((a) => a.id === 'anexo:0,1:saguao')!.exit).toEqual({ x: 47, y: 41, w: 3, h: 2 });
    // ids de spots únicos (duas áreas restroom, dois corredores)
    const ids = b.spots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a grade liga os blocos pela passarela: do elevador ao saguão, ao WC do anexo, à sala da vaga 8 e ao ponto de conversa do anexo', () => {
    const { b, rooms } = buildFor([8]);
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const at = (tx: number, ty: number) => reach[b.grid.key(tx, ty)];
    // passarela: um tile de cada trecho
    expect(at(56, 30)).toBe(1);
    expect(at(52, 34)).toBe(1);
    expect(at(48, 39)).toBe(1);
    // saguão (café), WC (cabine), sala (porta) e conversa do corredor do anexo
    const hub = b.areas.find((a) => a.id === 'anexo:0,1:saguao')!;
    const coffee = hub.spots.find((s) => s.kind === 'coffee')!;
    expect(at(coffee.tx, coffee.ty)).toBe(1);
    const wc = b.areas.find((a) => a.id === 'anexo:0,1:wc')!;
    const stall = wc.spots.find((s) => s.kind === 'stall')!;
    expect(at(stall.tx, stall.ty)).toBe(1);
    const door = rooms[0].door!;
    expect(door).toEqual({ x: 63, y: 52, w: 2, h: 1 }); // sala ao norte do corredor do anexo: porta na linha 52 (DOOR_X 7, DOOR_W 2)
    expect(at(door.x, door.y)).toBe(1);
    const talk = b.spots.filter((s) => s.group === 'anexo:0,1:corredor:talk:3');
    expect(talk).toHaveLength(2);
    expect(at(talk[0].tx, talk[0].ty)).toBe(1);
    // a rua não é caminhável
    expect(b.grid.walkable(40, 35)).toBe(false);
    expect(b.grid.walkable(60, 31)).toBe(false);
  });

  it('o caminho do lounge ao saguão passa pelo Z da passarela', () => {
    const { b } = buildFor([8]);
    const pf = new PathFinder(b.grid);
    const out: number[] = [];
    expect(pf.find(56, 27, 48, 44, out)).toBe(true);
    const tiles: [number, number][] = [];
    for (let i = 0; i < out.length; i += 2) tiles.push([out[i], out[i + 1]]);
    expect(tiles.some(([x, y]) => x >= 55 && x <= 57 && y >= 29 && y <= 32)).toBe(true);
    expect(tiles.some(([x, y]) => x >= 47 && x <= 49 && y >= 36 && y <= 40)).toBe(true);
    for (const [x, y] of tiles) expect(b.grid.walkable(x, y), `${x},${y}`).toBe(true);
  });

  it('nove salas: principal com as colunas 0–5 e o anexo com 2–3; o mundo vai de x 0 a 96 e de y 0 a 70', () => {
    const { b } = buildFor([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.blocks.map((blk) => [blk.columns.lo, blk.columns.hi])).toEqual([
      [0, 5],
      [2, 3],
    ]);
    expect(b.rect).toEqual({ x: 0, y: 0, w: 96, h: 70 });
    expect(b.bridges).toHaveLength(1);
  });

  it('corredor do anexo: colunas 2–3 em y 53..58, decorado pelo miolo do anexo (coluna 2) e pela coluna de sala (3)', () => {
    const { b } = buildFor([8]);
    const corridor = b.areas.find((a) => a.id === corridorId({ bx: 0, by: 1 }))!;
    expect(corridor.rect).toEqual({ x: 40, y: 53, w: 32, h: 5 });
    // miolo (coluna 2): palmeira em lx 2, ly 4; coluna 3 = primeira coluna de sala (k = 2, par): bebedouro em lx 3, ly 0
    expect(corridor.furniture.some((f) => f.kind === 'plant_tall' && f.variant === 'palm' && f.tx === 42 && f.ty === 57)).toBe(true);
    expect(corridor.furniture.some((f) => f.kind === 'water_cooler' && f.tx === 59 && f.ty === 53)).toBe(true);
    // o principal com só o miolo continua igual (colunas 2 e 3 decoradas como miolo)
    const main = corridorOf(b);
    expect(main.furniture.some((f) => f.kind === 'bench' && f.tx === 50 && f.ty === 12)).toBe(true);
  });

  it('os spots vêm na ordem núcleo, corredor, salas; os grupos de conversa do corredor levam o id da área', () => {
    const { b, rooms } = buildFor([0]);
    const order = b.spots.map((s) => s.areaId);
    const first = (id: string) => order.indexOf(id);
    expect(first('core:recepcao')).toBeGreaterThanOrEqual(0);
    expect(first('core:recepcao')).toBeLessThan(first('core:banheiros'));
    expect(first('core:banheiros')).toBeLessThan(first('core:copa'));
    expect(first('core:copa')).toBeLessThan(first('core:lounge'));
    expect(first('core:lounge')).toBeLessThan(first(CORRIDOR_ID));
    expect(first(CORRIDOR_ID)).toBeLessThan(first(rooms[0].id));
    expect(b.spots.filter((s) => s.group === 'core:corredor:talk:4')).toHaveLength(2);
    expect(b.spots.filter((s) => s.group === 'core:corredor:talk:2')).toHaveLength(2);
    expect(b.spots.some((s) => s.group?.startsWith('talk:corredor:'))).toBe(false);
    expect(corridorId(PRINCIPAL)).toBe(CORRIDOR_ID);
    expect(corridorId({ bx: 1, by: 0 })).toBe('anexo:1,0:corredor');
  });
});

/** Invariantes do prédio inteiro, em cinco cenários: só o principal (fase 1), A2 nascendo e os anéis com 33, 49 e 57 salas. */
const BUILDING_SCENARIOS: [string, number[]][] = [
  ['principal com 6 salas', [0, 1, 2, 3, 4, 7]],
  ['anexo 1 cheio e A2 com uma sala (17 salas)', Array.from({ length: 17 }, (_, i) => i)],
  ['A2 e A3 cheios e A4 nascendo (33 salas)', Array.from({ length: 33 }, (_, i) => i)],
  ['A6 nascendo ao norte da rua norte (49 salas)', Array.from({ length: 49 }, (_, i) => i)],
  ['A7 nascendo a partir de A6 (57 salas)', Array.from({ length: 57 }, (_, i) => i)],
];

describe.each(BUILDING_SCENARIOS)('layout do prédio: %s', (_name, slots) => {
  const rooms = roomsFor(slots);
  const b = assembleBuilding(existingBlocks(slots), rooms);
  const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
  const corridor = corridorOf(b);
  const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
  const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
  const reachable = (x: number, y: number) => reach[b.grid.key(x, y)] === 1;
  // colunas de pé do principal (0..5 com 6 salas; 0..6 com 17); 2 delas são o núcleo, as outras de projeto
  const standing = b.blocks[0].columns.hi - b.blocks[0].columns.lo + 1;
  const project = standing - 2;

  it('há dois elevadores com tiles de aproximação caminháveis', () => {
    const elevators = reception.spots.filter((s) => s.kind === 'elevator');
    expect(elevators).toHaveLength(2);
    for (const e of elevators) expect(b.grid.walkable(e.tx, e.ty)).toBe(true);
  });

  it('todos os spots são alcançáveis a partir dos elevadores', () => {
    const unreachable = b.spots.filter((s) => !reachable(s.tx, s.ty)).map((s) => s.id);
    expect(unreachable).toEqual([]);
  });

  it('as portas conectam cada sala ao corredor', () => {
    for (const room of rooms) {
      const door = room.door!;
      expect(door).toBeDefined();
      for (let x = door.x; x < door.x + door.w; x++) {
        for (let y = door.y; y < door.y + door.h; y++) expect(b.grid.walkable(x, y)).toBe(true);
        // tile do corredor (do bloco da sala) imediatamente fora da porta
        const outside = room.side === 'north' ? door.y + door.h : door.y - 1;
        expect(b.areas.some((a) => a.kind === 'corridor' && inRect(a.rect, x, outside)), `${room.id}: porta não dá num corredor`).toBe(true);
        expect(reachable(x, outside)).toBe(true);
      }
      // o interior inteiro (fora móveis) é alcançável
      const r = room.rect;
      for (let y = r.y + 2; y < r.y + 11; y++)
        for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(reachable(x, y)).toBe(true);
    }
  });

  it('cada sala tem 6 mesas, ao menos 4 lugares extras sentados, interruptor e quadro', () => {
    for (const room of rooms) {
      const desks = room.spots.filter((s) => s.kind === 'desk');
      expect(desks).toHaveLength(6);
      expect(new Set(desks.map((d) => d.rank))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      expect(desks.filter((d) => d.side === 'N')).toHaveLength(3);
      expect(room.spots.filter((s) => s.kind === 'stool' || s.kind === 'nook').length).toBeGreaterThanOrEqual(4);
      expect(room.spots.filter((s) => s.kind === 'stand').length).toBeGreaterThanOrEqual(3);
      expect(room.spots.filter((s) => s.kind === 'switch')).toHaveLength(1);
      expect(room.wallItems.some((w) => w.kind === 'whiteboard')).toBe(true);
      expect(room.wallItems.some((w) => w.kind === 'sign')).toBe(true);
      expect(room.wallItems.some((w) => w.kind === 'light_switch')).toBe(true);
      for (const d of desks) expect(room.furniture.some((f) => f.id === d.deskId)).toBe(true);
    }
  });

  it('móveis bloqueantes não se sobrepõem e ficam dentro da área', () => {
    for (const area of [...b.areas, ...rooms]) {
      const used = new Map<string, string>();
      for (const f of area.furniture) {
        const def = FURNITURE[f.kind];
        expect(def.mount).toBe('floor');
        for (let y = f.ty; y < f.ty + def.footprint.h; y++) {
          for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
            expect(x >= area.rect.x && x < area.rect.x + area.rect.w && y >= area.rect.y && y < area.rect.y + area.rect.h).toBe(true);
            const key = `${x},${y}`;
            if (def.blocks) {
              expect(used.get(key), `${f.id} sobre ${used.get(key)}`).toBeUndefined();
              used.set(key, f.id);
            }
          }
        }
      }
      for (const w of area.wallItems) expect(FURNITURE[w.kind].mount).toBe('wall');
    }
  });

  it('spots têm ids únicos', () => {
    const ids = b.spots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pontos de conversa e ping-pong vêm em pares', () => {
    const groups = new Map<string, number>();
    for (const s of b.spots) if (s.group && (s.kind === 'talk' || s.kind === 'pingpong')) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
    for (const [, n] of groups) expect(n).toBe(2);
  });

  it('nenhum group de spot se repete entre áreas (Spots.byGroup é global)', () => {
    const owner = new Map<string, string>();
    for (const s of b.spots) {
      if (!s.group) continue;
      const prev = owner.get(s.group);
      if (prev) expect(prev, s.group).toBe(s.areaId);
      owner.set(s.group, s.areaId);
    }
  });

  it('corredor alterna bebedouro e banco nas colunas de projeto, sem excesso de plantas', () => {
    const coolers = corridor.furniture.filter((f) => f.kind === 'water_cooler');
    expect(coolers.length).toBeGreaterThanOrEqual(Math.ceil(project / 2));
    const benches = corridor.furniture.filter((f) => f.kind === 'bench');
    expect(benches.length).toBeGreaterThanOrEqual(Math.floor(project / 2));
    const plants = corridor.furniture.filter((f) => f.kind === 'plant_tall' || f.kind === 'plant_small');
    expect(plants.length).toBeLessThanOrEqual(standing * 2);
  });
});

/** Móveis de chão altos que escondem o que está pendurado na parede logo atrás. */
const TALL_FLOOR = new Set<FurnitureKind>(['plant_tall', 'bookshelf', 'binder_shelf', 'fridge', 'vending_machine', 'arcade', 'water_cooler', 'floor_lamp', 'toilet_stall']);
const WALL_DECOR = new Set<FurnitureKind>(['painting', 'poster', 'window', 'tv', 'whiteboard', 'sign', 'clock', 'mirror', 'door_frame']);

/** Itens de parede decorativos com algum móvel alto encostado na frente (ids). */
function hiddenWallItems(area: AreaLayout): string[] {
  const out: string[] = [];
  for (const w of area.wallItems) {
    if (w.on !== 'face' || !WALL_DECOR.has(w.kind)) continue;
    const half = (FURNITURE[w.kind].footprint.w * TILE) / 2 - 2;
    const wy = w.baseY / TILE;
    for (const f of area.furniture) {
      if (!TALL_FLOOR.has(f.kind) || f.ty !== wy) continue;
      const fx0 = f.tx * TILE + (f.dx ?? 0);
      const fx1 = fx0 + FURNITURE[f.kind].footprint.w * TILE;
      if (fx0 < w.cx + half && fx1 > w.cx - half) out.push(`${w.id} atrás de ${f.id}`);
    }
  }
  return out;
}

describe('variações das salas de projeto', () => {
  const seeds = Array.from({ length: 90 }, (_, i) => (i * 7919 + 13) >>> 0);

  it('toda variação é válida: sem sobreposição, tudo alcançável, lugares suficientes', () => {
    // vaga 0 = coluna 4 norte (leste do miolo); vaga 3 = coluna 1 sul (oeste do miolo)
    for (const slot of [0, 3]) {
      for (const seed of seeds) {
        const room = layoutProjectRoom({ id: `/v/${seed}`, slot, seed }, theme);
        const b = assembleBuilding(existingBlocks([slot]), [room]);
        const used = new Map<string, string>();
        for (const f of room.furniture) {
          const def = FURNITURE[f.kind];
          for (let y = f.ty; y < f.ty + def.footprint.h; y++)
            for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
              expect(x >= room.rect.x + 1 && x < room.rect.x + 15 && y >= room.rect.y + 2 && y < room.rect.y + 11, `${f.id} fora do piso`).toBe(true);
              if (!def.blocks) continue;
              expect(used.get(`${x},${y}`), `${f.id} sobre ${used.get(`${x},${y}`)}`).toBeUndefined();
              used.set(`${x},${y}`, f.id);
            }
        }
        const door = room.door!;
        const reach = b.grid.reachableFrom(door.x, door.y);
        for (const sp of room.spots) expect(reach[b.grid.key(sp.tx, sp.ty)], `${sp.id} inalcançável (semente ${seed})`).toBe(1);
        const r = room.rect;
        for (let y = r.y + 2; y < r.y + 11; y++)
          for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(reach[b.grid.key(x, y)], `tile ${x},${y} isolado (semente ${seed})`).toBe(1);
        expect(room.spots.filter((sp) => sp.kind === 'desk')).toHaveLength(6);
        expect(room.spots.filter((sp) => sp.kind === 'stool' || sp.kind === 'nook').length).toBeGreaterThanOrEqual(4);
        // spots de uso não podem cair em cima de móvel que bloqueia
        for (const sp of room.spots) expect(b.grid.walkable(sp.tx, sp.ty), `${sp.id} sobre móvel`).toBe(true);
        expect(hiddenWallItems(room)).toEqual([]);
      }
    }
  });

  it('as salas não são todas iguais: espelhamento, canto de reunião e cantos variam', () => {
    const vs = seeds.map(roomVariant);
    expect(new Set(vs.map((v) => v.mirror)).size).toBe(2);
    expect(new Set(vs.map((v) => v.meeting)).size).toBe(3);
    expect(new Set(vs.map((v) => v.left)).size).toBeGreaterThan(1);
    expect(new Set(vs.map((v) => v.right)).size).toBeGreaterThan(1);
    // o piso é porcelanato (azulejo é do banheiro) com um leve tom da sala
    const room = layoutProjectRoom({ id: '/v/x', slot: 0, seed: 42 }, theme);
    expect(room.floors.every((f) => f.kind !== 'tile_white')).toBe(true);
    expect(room.floorTint).toBe(theme.carpet);
  });
});

describe('itens de parede', () => {
  it('quadros, janelas, TV, placas e espelhos não ficam atrás de móveis altos', () => {
    const A1 = { bx: 0, by: 1 };
    const areas = [...core.coreAreas(PRINCIPAL), ...hubAreas(A1, 'north'), layoutHub(A1, 'north', false), ...roomsFor([0, 1, 2, 3, 4, 7])];
    for (const area of areas) expect(hiddenWallItems(area), area.id).toEqual([]);
  });

  it('passagens nas faces das paredes têm batente', () => {
    // o WC do principal fica ao norte (porta na mureta, sem batente); a recepção, ao sul, tem a porta na face com batente
    const restroom = core.coreAreas(PRINCIPAL).find((a) => a.kind === 'restroom')!;
    expect(restroom.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    const reception = core.coreAreas(PRINCIPAL).find((a) => a.kind === 'reception')!;
    expect(reception.wallItems.some((w) => w.kind === 'door_frame')).toBe(true);
    // salas ao sul (porta na face norte): vagas 2 (4S), 3 (1S) e 7 (0S)
    for (const room of roomsFor([2, 3, 7])) expect(room.wallItems.some((w) => w.kind === 'door_frame'), room.id).toBe(true);
  });
});

describe('núcleo por bloco (coreAreas)', () => {
  const areas = () => core.coreAreas(PRINCIPAL);
  const byId = (id: string) => areas().find((a) => a.id === id)!;
  const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

  it('monta recepção (sul), WC (norte), copa e lounge nas colunas 2 e 3 do principal, com os ids de hoje (D9)', () => {
    expect(areas().map((a) => a.id)).toEqual(['core:recepcao', 'core:banheiros', 'core:copa', 'core:lounge']);
    expect(byId('core:recepcao').rect).toEqual({ x: 32, y: 17, w: 16, h: 12 });
    expect(byId('core:banheiros').rect).toEqual({ x: 32, y: 0, w: 16, h: 12 });
    expect(byId('core:copa').rect).toEqual({ x: 48, y: 0, w: 16, h: 12 });
    expect(byId('core:lounge').rect).toEqual({ x: 48, y: 17, w: 16, h: 12 });
    // os elevadores (cx 3 e 5,5 locais) acompanham a coluna
    expect(byId('core:recepcao').spots.filter((s) => s.kind === 'elevator').map((s) => s.tx)).toEqual([34, 37]);
  });

  it('as portas do WC, da recepção e do lounge acompanham o retângulo da área e continuam caminháveis', () => {
    expect(byId('core:banheiros').door).toEqual({ x: 39, y: 11, w: 2, h: 1 });
    expect(byId('core:banheiros').walkable).toContainEqual({ x: 39, y: 11, w: 2, h: 1 });
    expect(byId('core:recepcao').door).toEqual({ x: 39, y: 17, w: 2, h: 2 });
    expect(byId('core:recepcao').walkable).toContainEqual({ x: 39, y: 17, w: 2, h: 2 });
    expect(byId('core:lounge').door).toEqual({ x: 55, y: 17, w: 3, h: 2 });
    expect(byId('core:lounge').walkable).toContainEqual({ x: 55, y: 17, w: 3, h: 2 });
  });

  it('porta sul do lounge (para a passarela): vão de 3 tiles na parede sul, tile da linha 28 caminhável e `exit` separado de `door`', () => {
    const lounge = core.coreAreas(PRINCIPAL, { lounge: true, cafe: true }).find((a) => a.id === 'core:lounge')!;
    expect(lounge.exit).toEqual({ x: 55, y: 28, w: 3, h: 1 });
    expect(lounge.walkable).toContainEqual({ x: 55, y: 28, w: 3, h: 1 });
    expect(lounge.door).toEqual({ x: 55, y: 17, w: 3, h: 2 }); // a porta do corredor não muda
    const south = lounge.walls.find((w) => w.kind === 'south')!;
    expect(south.doorways).toEqual([{ x: 55 * TILE, w: 3 * TILE }]);
    // os puffs saem do caminho da porta (lx 7..9 livres na linha 9): ficam em lx 6 e 10
    expect(lounge.furniture.filter((f) => f.kind === 'beanbag').map((f) => f.tx)).toEqual([54, 58]);
    expect(lounge.spots.filter((s) => s.kind === 'beanbag')).toHaveLength(2);
  });

  it('o WC não tem porta externa; a recepção tem a entrada na parede sul (D9) e a copa a porta norte (D4)', () => {
    expect(byId('core:banheiros').exit).toBeUndefined();
    expect(core.coreAreas(PRINCIPAL, { lounge: false, cafe: true }).find((a) => a.id === 'core:copa')!.exit).toEqual({ x: 55, y: 0, w: 3, h: 2 }); // porta norte da copa (D4)
    expect(byId('core:copa').exit).toBeUndefined(); // sem passarela a parede é inteira
    expect(byId('core:lounge').exit).toBeUndefined();
    const reception = byId('core:recepcao');
    expect(reception.exit).toEqual({ x: 39, y: 28, w: 3, h: 1 });
    expect(reception.walkable).toContainEqual({ x: 39, y: 28, w: 3, h: 1 });
    expect(reception.walls.find((w) => w.kind === 'south')!.doorways).toEqual([{ x: 39 * TILE, w: 3 * TILE }]);
  });

  it('layoutRestroom ao norte (side): porta na mureta sul, face exterior sem vão', () => {
    const wc = core.layoutRestroom({ x: 32, y: 0, w: 16, h: 12 }, 'core:banheiros', 'north');
    expect(wc.door).toEqual({ x: 39, y: 11, w: 2, h: 1 });
    expect(wc.walls.find((w) => w.kind === 'south')!.doorways).toEqual([{ x: 39 * TILE, w: 2 * TILE }]);
    for (const w of wc.walls) if (w.kind === 'face') expect(w.doorways).toBeUndefined();
    expect(wc.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    expect(wc.spots.filter((s) => s.kind === 'stall')).toHaveLength(3);
  });

  it('layoutRestroom aceita outro id (WC dos anexos) e mantém o de hoje por padrão', () => {
    const wc = core.layoutRestroom({ x: 40, y: 58, w: 16, h: 12 }, 'anexo:0,1:wc');
    expect(wc.id).toBe('anexo:0,1:wc');
    expect(wc.kind).toBe('restroom');
    expect(wc.door).toEqual({ x: 47, y: 58, w: 2, h: 2 });
    expect(wc.spots.filter((s) => s.kind === 'sink')).toHaveLength(3);
    expect(wc.furniture.every((f) => f.id.startsWith('anexo:0,1:wc#'))).toBe(true);
    expect(core.layoutRestroom({ x: 32, y: 17, w: 16, h: 12 }).id).toBe('core:banheiros');
  });

  it('nada fica fora do retângulo da área (nenhum número absoluto sobrou)', () => {
    for (const a of areas()) {
      const r = a.rect;
      const px = { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
      for (const t of [...a.walkable, ...(a.blocked ?? []), ...(a.door ? [a.door] : []), ...(a.exit ? [a.exit] : [])]) {
        expect(inside(r, t.x, t.y) && inside(r, t.x + t.w - 1, t.y + t.h - 1), `${a.id} tiles ${t.x},${t.y} ${t.w}×${t.h}`).toBe(true);
      }
      for (const f of a.furniture) expect(inside(r, f.tx, f.ty), f.id).toBe(true);
      for (const s of a.spots) expect(inside(r, s.tx, s.ty), s.id).toBe(true);
      for (const w of a.wallItems) expect(w.cx >= px.x && w.cx <= px.x + px.w && w.baseY >= px.y && w.baseY <= px.y + px.h, w.id).toBe(true);
      for (const w of [...a.walls, ...a.floors, ...a.rugs]) expect(w.x >= px.x && w.x + w.w <= px.x + px.w && w.y >= px.y && w.y <= px.y + px.h, `${a.id} px ${w.x},${w.y}`).toBe(true);
    }
  });

  it('chamar de novo para o mesmo bloco devolve o mesmo array (cache por blockKey)', () => {
    expect(core.coreAreas(PRINCIPAL)).toBe(areas());
    expect(core.coreAreas({ bx: 0, by: 0 })).toBe(areas());
  });

  it('as funções de área aceitam qualquer retângulo de coluna (x 0 e 16): nada depende da posição antiga', () => {
    const reception = core.layoutReception({ x: 0, y: 0, w: 16, h: 12 });
    expect(reception.rect).toEqual({ x: 0, y: 0, w: 16, h: 12 });
    expect(reception.walkable).toEqual([
      { x: 1, y: 2, w: 14, h: 9 },
      { x: 7, y: 0, w: 2, h: 2 },
      { x: 7, y: 11, w: 3, h: 1 },
    ]);
    expect(core.layoutRestroom({ x: 0, y: 17, w: 16, h: 12 }).door).toEqual({ x: 7, y: 17, w: 2, h: 2 });
    expect(core.layoutCafe({ x: 16, y: 0, w: 16, h: 12 }).rect).toEqual({ x: 16, y: 0, w: 16, h: 12 });
    expect(core.layoutLounge({ x: 16, y: 17, w: 16, h: 12 }).door).toEqual({ x: 23, y: 17, w: 3, h: 2 });
  });
});

describe('saguão e WC do anexo (hubAreas)', () => {
  const A1 = { bx: 0, by: 1 };
  const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  const kinds = (a: AreaLayout, kind: string) => a.spots.filter((s) => s.kind === kind);

  it('ids pelo bloco; saguão (hub) na coluna 2 ao norte e WC (restroom) ao sul, nos retângulos do anexo 1', () => {
    expect(hubId(A1)).toBe('anexo:0,1:saguao');
    expect(annexRestroomId(A1)).toBe('anexo:0,1:wc');
    const [hub, wc] = hubAreas(A1, 'north');
    expect([hub.id, hub.kind, hub.rect]).toEqual(['anexo:0,1:saguao', 'hub', { x: 40, y: 41, w: 16, h: 12 }]);
    expect([wc.id, wc.kind, wc.rect]).toEqual(['anexo:0,1:wc', 'restroom', { x: 40, y: 58, w: 16, h: 12 }]);
    expect(wc.door).toEqual({ x: 47, y: 58, w: 2, h: 2 });
  });

  it('com passarela: porta externa de 3 tiles na face norte (exit, vão, batente wide3), sem janela', () => {
    const hub = layoutHub(A1, 'north', true);
    expect(hub.exit).toEqual({ x: 47, y: 41, w: 3, h: 2 });
    expect(hub.walkable).toContainEqual({ x: 47, y: 41, w: 3, h: 2 });
    expect(hub.walls.find((w) => w.kind === 'face')!.doorways).toEqual([{ x: 47 * TILE, w: 3 * TILE }]);
    const frames = hub.wallItems.filter((w) => w.kind === 'door_frame');
    expect(frames).toHaveLength(1);
    expect(frames[0].variant).toBe('wide3');
    expect(hub.wallItems.some((w) => w.kind === 'window')).toBe(false);
    expect(hub.door).toBeUndefined();
  });

  it('sem passarela (Review Focus c): face fechada com janela, nenhum tile caminhável nas linhas da porta', () => {
    const hub = layoutHub(A1, 'north', false);
    expect(hub.exit).toBeUndefined();
    expect(hub.walls.find((w) => w.kind === 'face')!.doorways).toBeUndefined(); // o builder não guarda lista vazia
    expect(hub.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    expect(hub.wallItems.filter((w) => w.kind === 'window')).toHaveLength(1);
    expect(hub.walkable.every((r) => r.y >= 43)).toBe(true);
  });

  it('aberto para o corredor ao sul como a recepção: vidro só nas pontas da linha 11, o meio livre', () => {
    const hub = layoutHub(A1, 'north', true);
    expect(hub.walkable).toContainEqual({ x: 41, y: 43, w: 14, h: 10 });
    expect(hub.walls.some((w) => w.kind === 'south')).toBe(false);
    expect(hub.furniture.filter((f) => f.kind === 'glass_partition' && f.variant === 'h' && f.ty === 52).map((f) => f.tx)).toEqual([41, 42, 43, 52, 53, 54]);
  });

  it('lounge do anexo = lounge do principal (sofá, poltronas, puffs, ping-pong, fliperamas, estante) mais o canto de café e água', () => {
    const hub = layoutHub(A1, 'north', true);
    const main = core.layoutLounge({ x: 0, y: 0, w: 16, h: 12 });
    const count = (a: AreaLayout, k: string) => kinds(a, k).length;
    for (const k of ['sofa', 'armchair', 'beanbag', 'pingpong', 'arcade', 'shelf', 'talk', 'watch']) expect(count(hub, k), k).toBe(count(main, k));
    expect(kinds(hub, 'coffee')).toHaveLength(1);
    expect(kinds(hub, 'water')).toHaveLength(1);
    expect(kinds(hub, 'coffee')[0].furnitureId).toBeDefined();
    for (const k of ['sink', 'stall', 'snack', 'fridge', 'cafe_seat', 'elevator']) expect(kinds(hub, k), k).toHaveLength(0);
    expect(count(main, 'coffee') + count(main, 'water')).toBe(0);
    // grupos próprios (não colidem com os do lounge principal)
    expect(kinds(hub, 'talk').map((s) => s.group)).toEqual(['talk:lounge:anexo:0,1:saguao', 'talk:lounge:anexo:0,1:saguao']);
    expect(hub.furniture.some((f) => f.kind === 'pingpong_table')).toBe(true);
  });

  it('nada fica fora do retângulo da área (saguão com e sem porta, WC)', () => {
    for (const a of [...hubAreas(A1, 'north'), layoutHub(A1, 'north', false)]) {
      const r = a.rect;
      const px = { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
      for (const t of [...a.walkable, ...(a.blocked ?? []), ...(a.door ? [a.door] : []), ...(a.exit ? [a.exit] : [])]) {
        expect(inside(r, t.x, t.y) && inside(r, t.x + t.w - 1, t.y + t.h - 1), `${a.id} tiles ${t.x},${t.y} ${t.w}×${t.h}`).toBe(true);
      }
      for (const f of a.furniture) expect(inside(r, f.tx, f.ty), f.id).toBe(true);
      for (const s of a.spots) expect(inside(r, s.tx, s.ty), s.id).toBe(true);
      for (const w of a.wallItems) expect(w.cx >= px.x && w.cx <= px.x + px.w && w.baseY >= px.y && w.baseY <= px.y + px.h, w.id).toBe(true);
      for (const w of [...a.walls, ...a.floors, ...a.rugs]) expect(w.x >= px.x && w.x + w.w <= px.x + px.w && w.y >= px.y && w.y <= px.y + px.h, `${a.id} px ${w.x},${w.y}`).toBe(true);
    }
  });

  it('cache por bloco e por ter ou não passarela', () => {
    expect(hubAreas(A1, 'north')).toBe(hubAreas({ bx: 0, by: 1 }, 'north'));
    expect(hubAreas(A1, 'north')).not.toBe(hubAreas(A1, null));
    expect(hubAreas(A1, null)[0].exit).toBeUndefined();
    expect(hubAreas(A1, 'north')[0].exit).toBeDefined();
  });
});

describe('saguão dos dois lados e porta da copa (fase 3, D1 e D4)', () => {
  it('A2 (1,0) sem filho: WC ao norte, saguão ao sul com a passagem larga para o corredor e parede sul fechada', () => {
    const b = assembleBuilding(existingBlocks([16]), roomsFor([16]));
    const hub = b.areas.find((a) => a.id === 'anexo:1,0:saguao')!;
    const wc = b.areas.find((a) => a.id === 'anexo:1,0:wc')!;
    expect(wc.rect).toEqual({ x: 140, y: 0, w: 16, h: 12 });
    expect(hub.rect).toEqual({ x: 140, y: 17, w: 16, h: 12 });
    expect(hub.door).toEqual({ x: 147, y: 17, w: 3, h: 2 });
    expect(hub.exit).toBeUndefined();
    expect(b.grid.walkable(148, 28)).toBe(false);
    expect(wc.door).toEqual({ x: 147, y: 11, w: 2, h: 1 });
    expect(b.grid.walkable(147, 11)).toBe(true);
    expect(wc.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    expect(hub.furniture.some((f) => f.kind === 'glass_partition' && f.variant === 'h')).toBe(false);
  });

  it('A2 com A3 (vaga 24): o saguão de A2 ganha a saída sul e a vertical reta liga ao saguão norte de A3', () => {
    const b = assembleBuilding(existingBlocks([16, 24]), roomsFor([16, 24]));
    const hub2 = b.areas.find((a) => a.id === 'anexo:1,0:saguao')!;
    const hub3 = b.areas.find((a) => a.id === 'anexo:1,1:saguao')!;
    expect(hub2.exit).toEqual({ x: 147, y: 28, w: 3, h: 1 });
    expect(hub3.exit).toEqual({ x: 147, y: 41, w: 3, h: 2 });
    expect(hub3.rect).toEqual({ x: 140, y: 41, w: 16, h: 12 });
    const reach = b.grid.reachableFrom(148, 28);
    expect(reach[b.grid.key(148, 42)]).toBe(1);
  });

  it('copa: parede norte inteira sem A6; com A6 porta norte de 3 tiles (exit), caminhável até a linha 0', () => {
    const fechada = assembleBuilding(existingBlocks([0]), roomsFor([0])).areas.find((a) => a.id === core.CAFE_ID)!;
    expect(fechada.exit).toBeUndefined();
    expect(fechada.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    const b = assembleBuilding(existingBlocks([48]), roomsFor([48]));
    const cafe = b.areas.find((a) => a.id === core.CAFE_ID)!;
    expect(cafe.exit).toEqual({ x: 55, y: 0, w: 3, h: 2 });
    expect(b.grid.walkable(56, 0)).toBe(true);
    expect(b.grid.walkable(56, -1)).toBe(true); // a passarela de A6 começa logo acima
    expect(cafe.wallItems.filter((w) => w.kind === 'window').map((w) => w.cx)).toEqual([(48 + 13.25) * TILE]);
    const frame = cafe.wallItems.find((w) => w.kind === 'door_frame')!;
    expect([frame.variant, frame.cx]).toEqual(['wide3', (48 + 8.5) * TILE]);
    for (const w of cafe.wallItems) expect(w.kind === 'door_frame' || w.cx <= (48 + 7) * TILE || w.cx >= (48 + 10) * TILE, `${w.kind} em ${w.cx}`).toBe(true);
    for (const f of cafe.furniture) expect(f.ty !== 2 || f.tx < 48 + 7 || f.tx >= 48 + 10, `${f.kind} em ${f.tx},${f.ty}`).toBe(true);
  });

  it('A6 (0,−1), vaga 48: WC ao norte, saguão ao sul com saída sul; do elevador até a sala de A6 pelo Z da copa', () => {
    const b = assembleBuilding(existingBlocks([48]), roomsFor([48]));
    const hub = b.areas.find((a) => a.id === 'anexo:0,-1:saguao')!;
    expect(hub.rect).toEqual({ x: 40, y: -24, w: 16, h: 12 });
    expect(hub.exit).toEqual({ x: 47, y: -13, w: 3, h: 1 });
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const room = b.rooms[0];
    expect(room.rect).toEqual({ x: 56, y: -41, w: 16, h: 12 }); // vaga 48 = coluna 3 norte de A6
    expect(reach[b.grid.key(room.door!.x, room.door!.y)]).toBe(1);
    for (const s of b.spots) expect(reach[b.grid.key(s.tx, s.ty)], s.id).toBe(1);
  });
});

describe('pontas do corredor (fase 3, D3)', () => {
  const seventeen = Array.from({ length: 17 }, (_, i) => i);
  it('17 salas: a ponta leste do principal e a oeste de A2 ficam abertas nas três linhas da passarela e a passarela liga os dois corredores', () => {
    const b = assembleBuilding(existingBlocks(seventeen), roomsFor(seventeen));
    const main = b.areas.find((a) => a.id === CORRIDOR_ID)!;
    const a2 = b.areas.find((a) => a.id === 'anexo:1,0:corredor')!;
    const glassAt = (c: AreaLayout, tx: number) => c.furniture.filter((f) => f.kind === 'glass_partition' && f.tx === tx).map((f) => f.ty).sort((p, q) => p - q);
    expect(glassAt(main, 95)).toEqual([12, 16]); // só os cantos
    expect(glassAt(main, 0)).toEqual([12, 13, 14, 15, 16]);
    expect(glassAt(a2, 108)).toEqual([12, 16]);
    expect(glassAt(a2, 155)).toEqual([12, 13, 14, 15, 16]);
    for (const x of [94, 95, 96, 107, 108, 109]) for (const y of [13, 14, 15]) expect(b.grid.walkable(x, y), `${x},${y}`).toBe(true);
    expect(b.grid.walkable(95, 12)).toBe(false);
    expect(b.grid.walkable(95, 16)).toBe(false);
    const reach = b.grid.reachableFrom(40, 14);
    expect(reach[b.grid.key(b.rooms[16].door!.x, b.rooms[16].door!.y)]).toBe(1);
  });

  it('sem passarela horizontal (9 salas) nada muda: vidro nas duas pontas dos dois corredores', () => {
    const b = assembleBuilding(existingBlocks([0, 1, 2, 3, 4, 5, 6, 7, 8]), roomsFor([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    for (const c of b.areas.filter((a) => a.kind === 'corridor')) {
      const r = c.rect;
      expect(c.furniture.filter((f) => f.kind === 'glass_partition' && (f.tx === r.x || f.tx === r.x + r.w - 1)), c.id).toHaveLength(2 * CORRIDOR_H);
      expect(b.grid.walkable(r.x, r.y + 2), c.id).toBe(false);
    }
  });

  it('A4 (−1,0) a oeste: a ponta oeste do principal abre e a passarela em x negativo é caminhável', () => {
    const b = assembleBuilding(existingBlocks([32]), roomsFor([32]));
    const main = b.areas.find((a) => a.id === CORRIDOR_ID)!;
    expect(main.rect.x).toBe(0);
    expect(main.furniture.filter((f) => f.kind === 'glass_partition' && f.tx === 0).map((f) => f.ty).sort((p, q) => p - q)).toEqual([12, 16]);
    const reach = b.grid.reachableFrom(40, 14);
    for (const x of [0, -1, -6, -12, -13]) expect(reach[b.grid.key(x, 14)], `x ${x}`).toBe(1);
    expect(reach[b.grid.key(b.rooms[0].door!.x, b.rooms[0].door!.y)]).toBe(1);
  });
});

describe('passarela como área (layoutBridge)', () => {
  const bridge = bridgesFor(existingBlocks([8]))[0];
  const area = layoutBridge(bridge);

  it('id da passarela, kind bridge, retângulo = caixa dos três trechos, sem paredes', () => {
    expect(area.id).toBe('passarela:0,1');
    expect(area.kind).toBe('bridge');
    expect(area.rect).toEqual({ x: 47, y: 29, w: 11, h: 12 });
    expect(area.walls).toEqual([]);
    expect(area.wallItems).toEqual([]);
    expect(area.spots).toEqual([]);
    expect(area.door).toBeUndefined();
  });

  it('piso de chapas e tiles caminháveis só nos trechos (o canto da caixa fora do Z fica vazio)', () => {
    expect(area.floors.map((f) => [f.kind, f.x / TILE, f.y / TILE, f.w / TILE, f.h / TILE])).toEqual([
      ['bridge', 55, 29, 3, 4],
      ['bridge', 47, 33, 11, 3],
      ['bridge', 47, 36, 3, 5],
    ]);
    expect(area.walkable).toEqual(bridge.rects);
  });

  it('guarda-corpo em cada borda de tile que não dá em outro trecho nem numa porta: 8 n, 8 s, 12 w, 12 e', () => {
    const rails = area.furniture.filter((f) => f.kind === 'railing');
    expect(rails).toHaveLength(40);
    const by = (v: string) => rails.filter((f) => f.variant === v);
    expect(by('n')).toHaveLength(8);
    expect(by('s')).toHaveLength(8);
    expect(by('w')).toHaveLength(12);
    expect(by('e')).toHaveLength(12);
    // as pontas encostam nas portas: nada de guarda-corpo ao norte da linha 29 nem ao sul da linha 40
    expect(by('n').some((f) => f.ty === 29)).toBe(false);
    expect(by('s').some((f) => f.ty === 40)).toBe(false);
    // o trecho do meio: norte em x 47..54 (os tiles 55..57 dão no trecho de cima), sul em x 50..57
    expect(by('n').map((f) => f.tx).sort((a, b) => a - b)).toEqual([47, 48, 49, 50, 51, 52, 53, 54]);
    expect(by('s').map((f) => f.tx).sort((a, b) => a - b)).toEqual([50, 51, 52, 53, 54, 55, 56, 57]);
    expect(area.furniture.every((f) => f.kind === 'railing')).toBe(true);
    // as variantes laterais são desenhadas no centro do tile e levadas à borda por `dx` (contrato de `railing` em common.ts)
    expect(by('w').every((f) => f.dx === -8)).toBe(true);
    expect(by('e').every((f) => f.dx === 8)).toBe(true);
    expect([...by('n'), ...by('s')].every((f) => f.dx === undefined)).toBe(true);
  });

  it('cache por id', () => {
    expect(layoutBridge(bridge)).toBe(area);
  });
});

describe('recepção ao sul do corredor com a entrada do prédio na parede sul (D9)', () => {
  /** A recepção na coluna 2 sul do principal (x 32..48, y 17..29). */
  const reception = () => core.layoutReception({ x: 32, y: 17, w: 16, h: 12 });
  const tilesOf = (w: { kind: FurnitureKind }) => FURNITURE[w.kind].footprint.w;

  it('porta do corredor na face (lx 7..9, com batente) e entrada de 3 tiles na parede sul, as duas caminháveis', () => {
    const r = reception();
    const doors = r.wallItems.filter((w) => w.kind === 'door_frame');
    expect(doors).toHaveLength(1);
    expect(doors[0].variant).toBeUndefined();
    expect(doors[0].cx).toBe((32 + 8) * TILE);
    expect(r.walls.find((w) => w.kind === 'face')!.doorways).toEqual([{ x: 39 * TILE, w: 2 * TILE }]);
    expect(r.walls.find((w) => w.kind === 'south')!.doorways).toEqual([{ x: 39 * TILE, w: 3 * TILE }]);
    expect(r.door).toEqual({ x: 39, y: 17, w: 2, h: 2 });
    expect(r.exit).toEqual({ x: 39, y: 28, w: 3, h: 1 });
    expect(r.walkable).toEqual([
      { x: 33, y: 19, w: 14, h: 9 },
      { x: 39, y: 17, w: 2, h: 2 },
      { x: 39, y: 28, w: 3, h: 1 },
    ]);
    // nada aberto para o corredor além da porta: sem divisórias de vidro
    expect(r.furniture.some((f) => f.kind === 'glass_partition')).toBe(false);
  });

  it('elevadores, porta, relógio, placa e quadro cabem na face sem se sobrepor; a porta não encosta nos elevadores', () => {
    const spans = reception()
      .wallItems.filter((w) => w.on === 'face')
      .map((w) => ({ kind: w.kind, x0: w.cx - (tilesOf(w) * TILE) / 2, x1: w.cx + (tilesOf(w) * TILE) / 2 }))
      .sort((a, b) => a.x0 - b.x0);
    expect([...spans.map((s) => s.kind)].sort()).toEqual(['clock', 'door_frame', 'elevator', 'elevator', 'painting', 'sign']);
    for (let i = 1; i < spans.length; i++) expect(spans[i].x0, `${spans[i].kind} sobre ${spans[i - 1].kind}`).toBeGreaterThanOrEqual(spans[i - 1].x1);
    // dentro da face (lx 0,5..15,5; as caps ocupam 0..0,5 e 15,5..16)
    for (const s of spans) expect(s.x0 >= 32.5 * TILE && s.x1 <= 47.5 * TILE, s.kind).toBe(true);
    const at = (kind: FurnitureKind) => spans.filter((s) => s.kind === kind).map((s) => [s.x0 / TILE - 32, s.x1 / TILE - 32]);
    expect(at('elevator')).toEqual([
      [2, 4],
      [4.5, 6.5],
    ]);
    expect(at('door_frame')).toEqual([[7, 9]]);
    expect(at('sign')).toEqual([[10.5, 13.5]]);
  });

  it('nenhum item da face fica atrás de um móvel alto', () => {
    expect(hiddenWallItems(reception())).toEqual([]);
  });

  it('da entrada até os elevadores e o corredor há caminho pela grade do prédio', () => {
    const b = assembleBuilding(existingBlocks([]), []);
    const reach = b.grid.reachableFrom(40, 28);
    expect(reach[b.grid.key(34, 19)]).toBe(1); // tile de aproximação do primeiro elevador
    expect(reach[b.grid.key(40, 14)]).toBe(1); // corredor
    expect(b.grid.inside(40, 29)).toBe(false); // a calçada fica fora da grade
  });
});

describe('área externa por blocos', () => {
  const PLANTS = new Set(['tree', 'pine', 'bush']);
  const isHedge = (p: { kind: string }) => p.kind === 'hedge' || p.kind === 'flowers';
  const hedgesOf = (slots: number[]) => layoutExterior(existingBlocks(slots)).props.filter((p) => isHedge(p) && p.y === (BUILDING_H + 1) * TILE + 10);
  /** Vagas que a cerca viva deixa abertas (whenRoom), conferindo de passagem que nenhuma fica diante do miolo. */
  const gates = (slots: number[]) => {
    const hedges = hedgesOf(slots);
    for (const p of hedges) {
      const col = Math.floor((p.x - TILE) / TILE / COL_W);
      if (p.whenRoom !== undefined) expect(col === 2 || col === 3, `whenRoom ${p.whenRoom} diante da coluna ${col}`).toBe(false);
      if (col === 2 || col === 3) expect(p.whenRoom, `cerca diante da coluna ${col} com whenRoom`).toBeUndefined();
    }
    return new Set(hedges.map((p) => p.whenRoom).filter((s): s is number => s !== undefined));
  };
  /** O mesmo laço de Renderer.buildBase (contrato do cabeçalho): um pátio por lado em cada coluna de pé fora do miolo, cap só nas pontas lo/hi. */
  const shellsOf = (slots: number[]) => {
    const shells: { col: number; sh: SlotShell }[] = [];
    for (const blk of existingBlocks(slots)) {
      for (let c = blk.columns.lo; c <= blk.columns.hi; c++) {
        if (isCoreColumn(blk.id, c)) continue;
        for (const side of ['north', 'south'] as const) {
          shells.push({ col: c, sh: slotShell(slotAt(blk.id, c, side), { west: c === blk.columns.lo, east: c === blk.columns.hi }) });
        }
      }
    }
    return shells;
  };
  /** Vagas cujo pátio tem um cap em x (px). */
  const capsAt = (shells: { col: number; sh: SlotShell }[], x: number) => shells.filter((s) => s.sh.walls.some((w) => w.kind === 'cap' && w.x === x)).map((s) => s.sh.slot);

  it('bounds = retângulo de pé do prédio mais as margens externas', () => {
    // existingBlocks([0]) → colunas 2–4 (x 32..80); existingBlocks([0, 1]) → colunas 1–4 (x 16..80)
    expect(layoutExterior(existingBlocks([0])).bounds).toEqual({ x: 12, y: -16, w: 88, h: 69 });
    expect(layoutExterior(existingBlocks([0, 1])).bounds).toEqual({ x: -4, y: -16, w: 104, h: 69 });
  });

  it('grama cobre os bounds e a rua ao sul atravessa toda a largura', () => {
    const ext = layoutExterior(existingBlocks([0, 1]));
    const b = ext.bounds;
    expect(b).toEqual({ x: -4, y: -16, w: 104, h: 69 });
    expect(ext.floors[0]).toMatchObject({ kind: 'grass', x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE });
    const street = ext.floors.filter((f) => f.kind === 'street');
    expect(street).toHaveLength(1);
    expect(street[0]).toMatchObject({ x: b.x * TILE, y: (BUILDING_H + 4) * TILE, w: b.w * TILE, h: 5 * TILE });
    expect(ext.streetY).toBe((BUILDING_H + 4) * TILE);
    expect(ext.streetH).toBe(5 * TILE);
    expect(ext.lanes).toHaveLength(2);
  });

  it('entrada ao sul da recepção (D9): caminho de pedra em x 39..42 × y 29..31 até a calçada, totem e banco na calçada', () => {
    const ext = layoutExterior(existingBlocks([0]));
    expect(ENTRANCE_X).toBe(39);
    const path = ext.floors.filter((f) => f.kind === 'sidewalk' && f.x === ENTRANCE_X * TILE);
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({ x: 39 * TILE, y: BUILDING_H * TILE, w: ENTRANCE_W * TILE, h: ENTRANCE_DEPTH * TILE });
    expect(path[0]).toMatchObject({ w: 3 * TILE, h: 2 * TILE });
    const totem = ext.props.filter((p) => p.kind === 'totem');
    expect(totem).toHaveLength(1);
    expect(totem[0]).toMatchObject({ x: 36 * TILE + 8, y: (BUILDING_H + 2) * TILE + 4 });
    const bench = ext.props.filter((p) => p.kind === 'bench');
    expect(bench).toHaveLength(1);
    expect(bench[0]).toMatchObject({ x: 46 * TILE, y: (BUILDING_H + 2) * TILE + 4 });
    // nada da entrada sobrou ao norte do prédio
    expect(ext.floors.some((f) => f.kind === 'sidewalk' && f.y < 0)).toBe(false);
    expect(ext.props.some((p) => (p.kind === 'totem' || p.kind === 'bench') && p.y < 0)).toBe(false);
  });

  it('a cerca viva do principal abre diante do caminho de pedra (peças 38 e 40 saem; 36 e 42 ficam)', () => {
    const xs = hedgesOf([0]).map((p) => p.x / TILE - 1);
    expect(xs).toContain(36);
    expect(xs).toContain(42);
    expect(xs).not.toContain(38);
    expect(xs).not.toContain(40);
  });

  it('a entrada oeste sai: nenhuma calçada, totem ou banco a oeste do prédio', () => {
    // colunas 1–4: o prédio começa em x 16 e os bounds em x −4, logo tudo a oeste de x 16 é jardim
    const ext = layoutExterior(existingBlocks([0, 1]));
    for (const f of ext.floors.filter((f) => f.kind === 'sidewalk')) {
      expect(f.w === ext.bounds.w * TILE || f.x === ENTRANCE_X * TILE, `calçada avulsa em x ${f.x / TILE}, y ${f.y / TILE}`).toBe(true);
    }
    expect(ext.props.filter((p) => (p.kind === 'totem' || p.kind === 'bench') && p.x < 16 * TILE)).toEqual([]);
    expect(ext.props.filter((p) => p.kind === 'paving')).toEqual([]);
  });

  it('o bosque ao norte cobre toda a largura (não há mais zona livre de entrada ao norte)', () => {
    for (const slots of [[], [0], [0, 1, 2, 3, 4, 5]]) {
      const ext = layoutExterior(existingBlocks(slots));
      const north = ext.props.filter((p) => PLANTS.has(p.kind) && p.y < 0);
      expect(north.length, `vagas [${slots.join(',')}]: bosque ao norte sumiu`).toBeGreaterThan(0);
      expect(north.some((p) => p.x >= 34 * TILE && p.x < 48 * TILE && p.y >= -8 * TILE), `vagas [${slots.join(',')}]`).toBe(true);
    }
  });

  it('cerca viva: cobre o prédio de pé e só tem whenRoom diante das colunas de sala, nunca do miolo (Review Focus 3)', () => {
    expect(gates([])).toEqual(new Set());
    expect(gates([0])).toEqual(new Set([2]));
    expect(gates([0, 1, 2, 3, 4, 5])).toEqual(new Set([7, 3, 2, 6]));
    // a vaga 16 abre A2 (fileira 0, mesma cerca sul): entram as vagas 17 (coluna 0 sul) e 19 (coluna 1 sul) de A2
    expect(gates([0, 1, 2, 3, 16])).toEqual(new Set([3, 2, 6, 17, 19]));
    // extensão: de world.x a world.x + world.w − 2, de 2 em 2 tiles (colunas 1–4 → x 16..80), menos as duas peças
    // diante da entrada (x 39..41 → peças 38 e 40)
    const xs = hedgesOf([0, 1]).map((p) => (p.x - TILE) / TILE);
    expect(Math.min(...xs)).toBe(16);
    expect(Math.max(...xs)).toBe(78);
    expect(xs).toHaveLength(30);
    expect(xs.includes(38) || xs.includes(40)).toBe(false);
    expect(isCoreColumn(PRINCIPAL, 2) && isCoreColumn(PRINCIPAL, 3) && !isCoreColumn(PRINCIPAL, 4)).toBe(true);
  });

  it('pátio: cap a leste só com ends.east e a oeste só com ends.west, com o mesmo y/h (Review Focus 1)', () => {
    // vaga 0 = coluna 4, norte (x 64..80)
    const east = slotShell(0, { west: false, east: true });
    expect(east.slot).toBe(0);
    expect(east.rect).toEqual({ x: 64, y: 0, w: 16, h: 12 });
    expect(east.walls.map((w) => w.kind)).toEqual(['face', 'cap']);
    expect(east.walls[1]).toEqual({ kind: 'cap', x: 64 * TILE + 16 * TILE - 8, y: (CORRIDOR_Y - 2) * TILE, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    expect(east.windows.map((w) => w.id)).toEqual(['shell:0:janela0', 'shell:0:janela1', 'shell:0:janela2']);
    // vaga 1 = coluna 1, norte (x 16..32)
    const west = slotShell(1, { west: true, east: false });
    expect(west.rect).toEqual({ x: 16, y: 0, w: 16, h: 12 });
    expect(west.walls.map((w) => w.kind)).toEqual(['face', 'cap']);
    expect(west.walls[1]).toEqual({ kind: 'cap', x: 16 * TILE, y: (CORRIDOR_Y - 2) * TILE, w: TILE / 2, h: 2 * TILE, style: EXTERIOR_WALL });
    // vaga 3 = coluna 1, sul (x 16..32, y 17..29): as duas pontas
    const both = slotShell(3, { west: true, east: true });
    expect(both.rect).toEqual({ x: 16, y: SOUTH_Y, w: 16, h: 12 });
    expect(both.walls.map((w) => w.kind)).toEqual(['south', 'cap', 'cap']);
    const caps = both.walls.filter((w) => w.kind === 'cap');
    expect(caps.map((w) => w.x).sort((a, b) => a - b)).toEqual([16 * TILE, 32 * TILE - 8]);
    for (const w of caps) if (w.kind === 'cap') expect({ y: w.y, w: w.w, h: w.h }).toEqual({ y: SOUTH_Y * TILE, w: TILE / 2, h: TILE });
    // vaga 2 = coluna 4, sul, sem ponta: sem cap; props do pátio pertencem à vaga
    const none = slotShell(2, { west: false, east: false });
    expect(none.walls.map((w) => w.kind)).toEqual(['south']);
    expect(none.props.length).toBeGreaterThan(0);
    expect(none.props.every((p) => p.slot === 2)).toBe(true);
    expect(none.props.some((p) => p.kind === 'paving' && p.x === 64 * TILE + 7 * TILE && p.y === BUILDING_H * TILE)).toBe(true);
  });

  it('pátios do prédio: um por coluna de pé fora do miolo; cap leste só em hi, oeste só em lo (Review Focus 1 e 3)', () => {
    // principal nas colunas 1..5 (a 5 vazia, só ligação) e A2 (1,0) nas colunas 0..2 (vaga 16 = coluna 0 norte; a 2 é o saguão)
    const blocks = existingBlocks([0, 1, 2, 3, 16]);
    expect(blocks.map((b) => [b.columns.lo, b.columns.hi])).toEqual([
      [1, 5],
      [0, 2],
    ]);
    const shells = shellsOf([0, 1, 2, 3, 16]);
    expect(shells.map((s) => s.sh.slot)).toEqual([1, 3, 0, 2, 4, 6, 16, 17, 18, 19]);
    expect(shells.map((s) => s.col)).toEqual([1, 1, 4, 4, 5, 5, 0, 0, 1, 1]);
    expect(capsAt(shells, 16 * TILE)).toEqual([1, 3]); // principal, oeste: só a coluna lo = 1
    expect(capsAt(shells, 6 * COL_W * TILE - 8)).toEqual([4, 6]); // principal, leste: só a coluna hi = 5
    expect(capsAt(shells, 108 * TILE)).toEqual([16, 17]); // A2, oeste: só a coluna lo = 0 (x 108); a ponta leste (hi = 2) é o saguão
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe([1, 3, 4, 6, 16, 17].includes(s.sh.slot) ? 1 : 0);
    }
    expect(shells.some((s) => s.sh.slot < 16 && (s.col === 2 || s.col === 3))).toBe(false);
    expect(shells.some((s) => s.sh.slot >= 16 && s.col === 2)).toBe(false);
  });

  it('pátios com a coluna 1 vazia entre a sala da coluna 0 e o miolo (vaga 5): cap oeste só na coluna 0, nenhum cap a leste porque a ponta leste é o miolo', () => {
    // existingBlocks([5]) → colunas 0–3: a 0 tem a sala (vaga 5 = 0N), a 1 é pátio dos dois lados, a 2 e a 3 são miolo.
    // O laço gera o shell também para a vaga 5, que tem sala: quem decide desenhá-lo é o frame (roomInSlot), como hoje.
    expect(existingBlocks([5])[0].columns).toEqual({ lo: 0, hi: 3 });
    const shells = shellsOf([5]);
    expect(shells.map((s) => s.sh.slot)).toEqual([5, 7, 1, 3]);
    expect(shells.map((s) => s.col)).toEqual([0, 0, 1, 1]);
    expect(shells[0].sh.rect).toEqual({ x: 0, y: 0, w: 16, h: 12 }); // vaga 5 = coluna 0, norte
    expect(shells[1].sh.rect).toEqual({ x: 0, y: SOUTH_Y, w: 16, h: 12 }); // vaga 7 = coluna 0, sul
    expect(capsAt(shells, 0)).toEqual([5, 7]); // oeste: só a coluna lo = 0 (x0 = 0)
    expect(capsAt(shells, 4 * COL_W * TILE - 8)).toEqual([]); // a ponta leste (hi = 3) é miolo: o laço a pula, sem shell e sem cap
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe(s.col === 0 ? 1 : 0);
    }
    expect(shells.some((s) => s.col === 2 || s.col === 3)).toBe(false);
    // a cerca viva só abre diante das vagas sul das colunas 0 e 1
    expect(gates([5])).toEqual(new Set([7, 3]));
  });

  it('espelho a leste: sala só na coluna 5 (vaga 4) com a coluna 4 vazia no meio: cap leste só na coluna 5, nenhum cap a oeste', () => {
    // existingBlocks([4]) → colunas 2–5: 2 e 3 miolo, a 4 é pátio dos dois lados, a 5 tem a sala (vaga 4 = 5N) e o pátio da vaga 6 ao sul
    expect(existingBlocks([4])[0].columns).toEqual({ lo: 2, hi: 5 });
    const shells = shellsOf([4]);
    expect(shells.map((s) => s.sh.slot)).toEqual([0, 2, 4, 6]);
    expect(shells.map((s) => s.col)).toEqual([4, 4, 5, 5]);
    expect(shells[2].sh.rect).toEqual({ x: 80, y: 0, w: 16, h: 12 }); // vaga 4 = coluna 5, norte
    expect(capsAt(shells, 5 * COL_W * TILE + COL_W * TILE - TILE / 2)).toEqual([4, 6]); // leste: só a coluna hi = 5 (x = 1528)
    expect(capsAt(shells, 32 * TILE)).toEqual([]); // a ponta oeste (lo = 2) é miolo: sem shell e sem cap
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe(s.col === 5 ? 1 : 0);
    }
    expect(gates([4])).toEqual(new Set([2, 6]));
  });

  it('pátios com as colunas 4 e 5 vazias entre o miolo e A2 (vaga 16): cap leste do principal na coluna 5, nenhum a oeste (miolo); A2 com cap só a oeste', () => {
    // existingBlocks([16]) → principal nas colunas 2–5 (2 e 3 miolo, 4 e 5 pátio dos dois lados, a 5 só pela ligação) e
    // A2 nas colunas 0–2 (a 0 tem a sala, vaga 16 = 0N, e o pátio da 17 ao sul; a 1 é pátio dos dois lados; a 2 é o saguão)
    expect(existingBlocks([16]).map((b) => [b.columns.lo, b.columns.hi])).toEqual([
      [2, 5],
      [0, 2],
    ]);
    const shells = shellsOf([16]);
    expect(shells.map((s) => s.sh.slot)).toEqual([0, 2, 4, 6, 16, 17, 18, 19]);
    expect(shells.map((s) => s.col)).toEqual([4, 4, 5, 5, 0, 0, 1, 1]);
    expect(shells[4].sh.rect).toEqual({ x: 108, y: 0, w: 16, h: 12 }); // vaga 16 = coluna 0 de A2, norte
    expect(shells[5].sh.rect).toEqual({ x: 108, y: SOUTH_Y, w: 16, h: 12 }); // vaga 17 = coluna 0 de A2, sul
    expect(capsAt(shells, 6 * COL_W * TILE - 8)).toEqual([4, 6]); // principal, leste: só a coluna hi = 5
    expect(capsAt(shells, 32 * TILE)).toEqual([]); // a ponta oeste do principal (lo = 2) é miolo: sem shell e sem cap
    expect(capsAt(shells, 108 * TILE)).toEqual([16, 17]); // A2, oeste: só a coluna lo = 0
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe([4, 6, 16, 17].includes(s.sh.slot) ? 1 : 0);
    }
    // a cerca viva abre diante das vagas sul das colunas 4 e 5 do principal e das colunas 0 e 1 de A2
    expect(gates([16])).toEqual(new Set([2, 6, 17, 19]));
  });

  it('com o anexo 1: a rua continua ao sul do principal (y 33..38) e os bounds abraçam os dois blocos e a passarela', () => {
    const ext = layoutExterior(existingBlocks([8]));
    expect(ext.bounds).toEqual({ x: 12, y: -16, w: 80, h: 110 });
    const street = ext.floors.filter((f) => f.kind === 'street');
    expect(street).toHaveLength(1);
    expect(street[0]).toMatchObject({ y: (BUILDING_H + 4) * TILE, h: 5 * TILE });
    expect(ext.floors.filter((f) => f.kind === 'sidewalk').map((f) => f.y / TILE).sort((a, b) => a - b)).toEqual([29, 31, 38]);
    expect(ext.streetY).toBe((BUILDING_H + 4) * TILE);
    // os postes ficam numa grade fixa do mundo (de 6 em 6 tiles), então os que existem com e sem o anexo estão nas
    // mesmas posições; nenhum junto à entrada
    const lamps = (slots: number[]) => layoutExterior(existingBlocks(slots)).props.filter((p) => p.kind === 'lamp').map((p) => [p.x, p.y]);
    const withAnnex = lamps([8]);
    const north = withAnnex.filter(([, y]) => y === (BUILDING_H + 3) * TILE + 6);
    expect(north.length).toBeGreaterThan(5);
    expect(north.every(([x]) => (x / TILE) % 6 === 2)).toBe(true);
    expect(north.some(([x]) => x / TILE >= ENTRANCE_X - 4 && x / TILE < ENTRANCE_X + ENTRANCE_W + 5)).toBe(false);
    expect(lamps([0]).filter(([x, y]) => withAnnex.some(([ax, ay]) => ax === x && ay === y))).toEqual(lamps([0]).filter(([x]) => withAnnex.some(([ax]) => ax === x)));
  });

  it('Review Focus 5: nenhum prop externo cai sob a passarela nem dentro do retângulo de pé do anexo', () => {
    const half: Partial<Record<string, number>> = { tree: 18, pine: 14 };
    for (const n of [9, 13, 24]) {
      const blocks = existingBlocks(Array.from({ length: n }, (_, i) => i));
      const bridges = bridgesFor(blocks);
      const ext = layoutExterior(blocks, bridges);
      const annex = blocks[1].rect;
      const ax0 = annex.x * TILE;
      const ax1 = (annex.x + annex.w) * TILE;
      for (const p of ext.props) {
        const tx = Math.floor(p.x / TILE);
        const ty = Math.floor(p.y / TILE);
        expect(tx >= annex.x && tx < annex.x + annex.w && ty >= annex.y && ty < annex.y + annex.h, `${p.kind} em ${tx},${ty} dentro do anexo`).toBe(false);
        for (const r of bridges[0].rects) expect(tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h, `${p.kind} em ${tx},${ty} sob a passarela`).toBe(false);
        // a copa (meia-largura do sprite) não entra na faixa do anexo quando a base está na altura dele
        const h = half[p.kind] ?? 0;
        if (h && ty >= annex.y && ty < annex.y + annex.h) expect(p.x + h > ax0 && p.x - h < ax1, `${p.kind} em ${p.x},${p.y} cobre a parede do anexo (${n} salas)`).toBe(false);
      }
    }
    // regressão da cena atual do principal sozinho (entrada ao sul, D9; árvores por posição, D5): contagem e digest dos
    // props com 1, 4 e 8 salas; qualquer mudança que tire ou mova um prop do principal quebra aqui e exige re-pinar
    const digest = (ps: readonly { x: number; y: number }[]) => ps.reduce((d, p) => (d * 31 + p.x * 7 + p.y) % 1_000_003, 0);
    for (const [n, count, dg] of [
      [1, 311, 504912],
      [4, 353, -466083],
      [8, 446, -831433],
    ] as const) {
      const ps = layoutExterior(existingBlocks(Array.from({ length: n }, (_, i) => i))).props;
      expect([ps.length, digest(ps)], `${n} salas`).toEqual([count, dg]);
    }
  });

  it('cerca viva ao norte do anexo 1 (y 40): cobre o retângulo de pé menos as peças sob a passarela, abre só diante da coluna da sala', () => {
    const ext = layoutExterior(existingBlocks([8]));
    const north = ext.props.filter((p) => isHedge(p) && p.y === 40 * TILE + 10);
    expect(north).toHaveLength(14); // x 40..70 de 2 em 2 (16 peças) menos as duas sob a passarela (x 46 e 48)
    const xs = north.map((p) => (p.x - TILE) / TILE);
    expect(Math.min(...xs)).toBe(40);
    expect(Math.max(...xs)).toBe(70);
    expect(xs).not.toContain(46);
    expect(xs).not.toContain(48);
    expect(new Set(north.map((p) => p.whenRoom).filter((s): s is number => s !== undefined))).toEqual(new Set([8]));
    // diante do miolo do anexo (coluna local 2, x 40..56) nada abre
    for (const p of north) if ((p.x - TILE) / TILE < 56) expect(p.whenRoom, `cerca em x ${(p.x - TILE) / TILE}`).toBeUndefined();
    // a cerca sul do principal cobre o miolo de pé (x 32..62) menos as duas peças sob a saída da passarela (x 54 e 56 → tiles 55 e 57)
    expect(hedgesOf([8]).map((p) => (p.x - TILE) / TILE)).toEqual([32, 34, 36, 42, 44, 46, 48, 50, 52, 58, 60, 62]);
    expect(gates([8])).toEqual(new Set());
  });

  it('pátios da fileira 1: lado e y relativos à vaga; o pátio sul do anexo não tem caminho nem paving para a rua', () => {
    const n = slotShell(8, { west: false, east: true });
    expect(n.side).toBe('north');
    expect(n.rect).toEqual({ x: 56, y: 41, w: 16, h: 12 });
    expect(n.walls.find((w) => w.kind === 'face')).toMatchObject({ x: 56 * TILE, y: (41 + ROOM_H - 2) * TILE });
    expect(n.windows.every((w) => w.baseY === (41 + ROOM_H) * TILE)).toBe(true);
    expect(n.walls.filter((w) => w.kind === 'cap')).toHaveLength(1);
    const s = slotShell(10, { west: false, east: false });
    expect(s.side).toBe('south');
    expect(s.rect).toEqual({ x: 56, y: 58, w: 16, h: 12 });
    expect(s.walls.find((w) => w.kind === 'south')).toMatchObject({ x: 56 * TILE, y: 58 * TILE });
    expect(s.props.some((p) => p.kind === 'paving')).toBe(false);
    expect(s.floors.filter((f) => f.kind === 'sidewalk')).toHaveLength(1); // só a borda do deck
    // o principal não muda: pátio norte da vaga 0 e sul da vaga 2 como antes
    expect(slotShell(0, { west: false, east: false }).walls.find((w) => w.kind === 'face')).toMatchObject({ y: (CORRIDOR_Y - 2) * TILE });
    expect(slotShell(0, { west: false, east: false }).side).toBe('north');
    expect(slotShell(2, { west: false, east: false }).props.some((p) => p.kind === 'paving' && p.y === BUILDING_H * TILE)).toBe(true);
  });
});

describe('exterior da fase 3 (D5): ruas, props por posição, cercas e pátios por lado com rua', () => {
  const slots = (n: number) => Array.from({ length: n }, (_, i) => i);
  const ext = (n: number) => {
    const b = existingBlocks(slots(n));
    return { b, e: layoutExterior(b, bridgesFor(b)) };
  };
  /** Faixa de calçada + asfalto de uma rua (tiles): h → linhas 2..10 do rect; v → colunas 1..9. */
  const paved = (s: Street): { x: number; y: number; w: number; h: number } =>
    s.axis === 'h' ? { x: s.rect.x, y: s.rect.y + 2, w: s.rect.w, h: 9 } : { x: s.rect.x + 1, y: s.rect.y, w: 9, h: s.rect.h };

  it('ruas: só a principal com 9 salas; A2 traz a norte–sul em x 96; A4 a de x −12; A6 a rua norte', () => {
    const e9 = ext(9).e;
    expect(e9.streets.map((s) => [s.axis, s.rect.x, s.rect.y, s.rect.w, s.rect.h, s.cars])).toEqual([['h', e9.bounds.x, 29, e9.bounds.w, 12, true]]);
    const e17 = ext(17).e;
    expect(e17.streets.filter((s) => s.axis === 'v').map((s) => [s.rect.x, s.rect.w, s.cars])).toEqual([[96, 12, false]]);
    expect(e17.streets.find((s) => s.axis === 'v')!.rect).toMatchObject({ y: e17.bounds.y, h: e17.bounds.h });
    const e33 = ext(33).e;
    expect(e33.streets.filter((s) => s.axis === 'v').map((s) => s.rect.x).sort((a, b) => a - b)).toEqual([-12, 96]);
    const e49 = ext(49).e;
    expect(e49.streets.filter((s) => s.axis === 'h').map((s) => [s.rect.y, s.cars])).toEqual([
      [29, true],
      [-12, false],
    ]);
    // pisos: calçadas e asfalto de cada rua, calçadas antes do asfalto (cruzamentos limpos)
    const kinds = e49.floors.map((f) => f.kind);
    expect(kinds.lastIndexOf('sidewalk' as const) > kinds.indexOf('street')).toBe(true); // o caminho de pedra da entrada vem por último
    expect(kinds.indexOf('street')).toBeGreaterThan(kinds.indexOf('sidewalk'));
    expect(e49.floors.filter((f) => f.kind === 'street')).toHaveLength(e49.streets.length);
  });

  it('Review Focus 4: nenhum prop em rua, calçada, bloco ou passarela com 17, 33 e 49 salas (menos o mobiliário da calçada); carros só na principal', () => {
    const sidewalkFurniture = new Set(['lamp', 'bench', 'totem', 'traffic_light', 'stop_sign']);
    for (const n of [17, 33, 49]) {
      const { b, e } = ext(n);
      const bridges = bridgesFor(b);
      for (const p of e.props) {
        const tx = Math.floor(p.x / TILE);
        const ty = Math.floor(p.y / TILE);
        const onStreet = e.streets.some((s) => inRect(paved(s), tx, ty));
        expect(onStreet && !sidewalkFurniture.has(p.kind), `${p.kind} em ${tx},${ty} na rua (${n} salas)`).toBe(false);
        // nem o mobiliário da calçada entra no asfalto (h: linhas 4..8; v: colunas 3..7)
        const asphalt = (s: Street) => (s.axis === 'h' ? { x: s.rect.x, y: s.rect.y + 4, w: s.rect.w, h: 5 } : { x: s.rect.x + 3, y: s.rect.y, w: 5, h: s.rect.h });
        expect(e.streets.some((s) => inRect(asphalt(s), tx, ty)), `${p.kind} em ${tx},${ty} no asfalto (${n} salas)`).toBe(false);
        expect(b.some((blk) => inRect(blk.rect, tx, ty)), `${p.kind} em ${tx},${ty} dentro de bloco (${n} salas)`).toBe(false);
        expect(bridges.some((br) => br.rects.some((r) => inRect(r, tx, ty))), `${p.kind} em ${tx},${ty} sob passarela (${n} salas)`).toBe(false);
      }
      expect(e.lanes).toHaveLength(2);
      expect(e.streets.filter((s) => s.cars)).toHaveLength(1);
    }
  });

  it('árvores por posição: as que existem com 9 salas continuam no mesmo lugar com 17 (a oeste da rua nova)', () => {
    const trees = (e: ExteriorLayout) => e.props.filter((p) => p.kind === 'tree' || p.kind === 'pine' || p.kind === 'bush');
    const a = trees(ext(9).e);
    const set = new Set(trees(ext(17).e).map((p) => `${p.x},${p.y}`));
    const kept = a.filter((p) => p.x < 90 * TILE);
    expect(kept.length).toBeGreaterThan(20);
    for (const p of kept) expect(set.has(`${p.x},${p.y}`), `${p.kind} em ${p.x},${p.y}`).toBe(true);
  });

  it('cerca viva por lado com rua: principal ao sul e, com A6, também ao norte (menos sob a passarela); A6 ao sul; nada ao norte sem a rua norte', () => {
    const hedges = (e: ExteriorLayout, y: number) => e.props.filter((p) => (p.kind === 'hedge' || p.kind === 'flowers') && p.y === y).map((p) => p.x / TILE - 1).sort((a, b) => a - b);
    const { b: b49, e: e49 } = ext(49);
    expect(hedges(e49, (BUILDING_H + 1) * TILE + 10).length).toBeGreaterThan(0); // sul do principal
    const north = hedges(e49, -TILE + 10);
    expect(north.length).toBeGreaterThan(0);
    const bridgeA6 = bridgesFor(b49).find((br) => br.child.by === -1)!;
    for (const x of north) expect(bridgeA6.rects.some((r) => inRect(r, x, -1)) || bridgeA6.rects.some((r) => inRect(r, x + 1, -1)), `cerca em x ${x} sob a passarela de A6`).toBe(false);
    expect(hedges(e49, (-41 + BUILDING_H + 1) * TILE + 10).length).toBeGreaterThan(0); // sul de A6 (y −11)
    expect(hedges(ext(9).e, -TILE + 10)).toEqual([]);
    expect(hedges(ext(17).e, -TILE + 10)).toEqual([]);
  });

  it('postes na calçada norte da rua principal e na calçada sul da rua norte; nenhum nas norte–sul', () => {
    for (const n of [33, 49]) {
      const { e } = ext(n);
      const lamps = e.props.filter((p) => p.kind === 'lamp');
      for (const s of e.streets.filter((s) => s.axis === 'v')) {
        const asphalt = { x: s.rect.x + 3, y: s.rect.y, w: 5, h: s.rect.h };
        for (const l of lamps) expect(inRect(asphalt, Math.floor(l.x / TILE), Math.floor(l.y / TILE)), `poste em ${l.x},${l.y} no asfalto (${n} salas)`).toBe(false);
      }
    }
    const rows = new Set(ext(49).e.props.filter((p) => p.kind === 'lamp').map((p) => p.y));
    expect(rows.has((29 + 3) * TILE + 6) && rows.has(-3 * TILE + 6)).toBe(true);
  });

  it('pátios: caminho de pedra e paving só do lado com rua (D5)', () => {
    expect(slotShell(2, { west: false, east: false, street: true }).props.some((p) => p.kind === 'paving')).toBe(true);
    expect(slotShell(2, { west: false, east: false, street: false }).props.some((p) => p.kind === 'paving')).toBe(false);
    expect(slotShell(2, { west: false, east: false, street: false }).floors.filter((f) => f.kind === 'sidewalk')).toHaveLength(1); // só a borda do deck
    expect(slotShell(0, { west: false, east: false, street: true }).props.some((p) => p.kind === 'paving' && p.y === -2 * TILE)).toBe(true); // vaga norte com a rua norte
    expect(slotShell(0, { west: false, east: false, street: false }).props.some((p) => p.kind === 'paving')).toBe(false);
    // sem `street`, vale a regra antiga: só o sul do principal
    expect(slotShell(2, { west: false, east: false }).props.some((p) => p.kind === 'paving')).toBe(true);
    expect(slotShell(0, { west: false, east: false }).props.some((p) => p.kind === 'paving')).toBe(false);
  });
});

describe('cruzamentos de cidade: faixas, PARE e placas', () => {
  const ext = (slots: number[]) => layoutExterior(existingBlocks(slots));

  it('sem rua norte–sul não há cruzamento nem placa', () => {
    const e = ext([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(e.intersections).toEqual([]);
    expect(e.props.some((p) => p.kind === 'stop_sign')).toBe(false);
  });

  it('um cruzamento de 5×5 tiles por par rua norte–sul × rua leste–oeste, no asfalto das duas', () => {
    const e = ext([16]);
    const v = e.streets.filter((s) => s.axis === 'v');
    const h = e.streets.filter((s) => s.axis === 'h');
    expect(e.intersections).toHaveLength(v.length * h.length);
    for (const i of e.intersections) {
      expect([i.w, i.h]).toEqual([5, 5]);
      expect(v.some((s) => i.x === s.rect.x + 3)).toBe(true);
      expect(h.some((s) => i.y === s.rect.y + 4)).toBe(true);
    }
  });

  it('duas placas de PARE por cruzamento, na calçada da rua norte–sul (oeste ao norte, leste ao sul), nunca no asfalto', () => {
    const e = ext([16, 32]);
    const signs = e.props.filter((p) => p.kind === 'stop_sign');
    expect(signs).toHaveLength(e.intersections.length * 2);
    for (const i of e.intersections) {
      const vx = i.x - 3;
      const hy = i.y - 4;
      const norte = signs.find((p) => Math.floor(p.x / TILE) === vx + 2 && Math.floor(p.y / TILE) === hy + 1);
      const sul = signs.find((p) => Math.floor(p.x / TILE) === vx + 9 && Math.floor(p.y / TILE) === hy + 11);
      expect(norte, `norte em ${i.x},${i.y}`).toBeDefined();
      expect(sul, `sul em ${i.x},${i.y}`).toBeDefined();
    }
  });
});
