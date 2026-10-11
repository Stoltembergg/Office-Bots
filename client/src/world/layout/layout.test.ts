import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE, type FurnitureKind, type RoomTheme } from '../../art/api';
import { BUILDING_H, COL_W, CORRIDOR_H, CORRIDOR_Y, ROOM_H, SOUTH_Y } from '../constants';
import { assembleBuilding, type BuildingLayout } from './building';
import * as core from './core';
import { CORRIDOR_ID, corridorId } from './corridor';
import { existingBlocks, isCoreColumn, PRINCIPAL, slotAt } from './geometry';
import { annexRestroomId, hubAreas, hubId, layoutHub } from './hub';
import { layoutProjectRoom, roomVariant } from './room';
import { ENTRANCE_DEPTH, ENTRANCE_W, ENTRANCE_X, EXTERIOR_WALL, layoutExterior, slotShell, type SlotShell } from './exterior';
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

/** Prédio montado com as salas das vagas dadas (K = 2: as vagas 8..15 montam o anexo 1; s ≥ 16 é o transitório 7.5). */
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
    expect(b.areas.find((a) => a.id === core.RECEPTION_ID)!.rect).toEqual({ x: 32, y: 0, w: 16, h: 12 });
    expect(rooms[0].rect).toEqual({ x: 64, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(b.rooms).toHaveLength(1);
    expect(b.areas.map((a) => a.id)).toEqual(['core:recepcao', 'core:banheiros', 'core:copa', 'core:lounge', CORRIDOR_ID]);
    // o BuildingLayout só tem o modelo de blocos: sem cols, core nem corridor
    expect(Object.keys(b).sort()).toEqual(['areas', 'blocks', 'grid', 'rect', 'rooms', 'spots']);
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

  it('vaga 16 (transitório 7.5) cai na coluna 6: a coluna 5 fica sem sala, hi = 6 e o corredor vai até x 112', () => {
    const { b, rooms, corridor } = buildFor([0, 1, 2, 3, 16]);
    expect(b.blocks[0].columns).toEqual({ lo: 1, hi: 6 });
    expect(b.rect).toEqual({ x: 16, y: 0, w: 96, h: 29 });
    expect(corridor.rect).toEqual({ x: 16, y: CORRIDOR_Y, w: 96, h: CORRIDOR_H });
    expect(rooms[4].rect).toEqual({ x: 96, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[4].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === 5 * COL_W)).toBe(false);
    // vidro na ponta leste (x 111); o tile antes dele é corredor caminhável
    expect(b.grid.walkable(111, CORRIDOR_Y + 2)).toBe(false);
    expect(b.grid.walkable(110, CORRIDOR_Y + 2)).toBe(true);
  });

  it('vaga 16 sozinha: colunas 2–6 com as colunas 4 e 5 vazias, corredor de 80 tiles e a sala em x 96 alcançável', () => {
    const { b, rooms, corridor } = buildFor([16]);
    expect(b.blocks[0].columns).toEqual({ lo: 2, hi: 6 });
    expect(b.rect).toEqual({ x: 32, y: 0, w: 80, h: 29 });
    expect(corridor.rect).toEqual({ x: 32, y: CORRIDOR_Y, w: 80, h: CORRIDOR_H });
    expect(rooms[0].rect).toEqual({ x: 96, y: 0, w: COL_W, h: ROOM_H });
    expect(rooms[0].side).toBe('north');
    expect(rooms.some((r) => r.rect.x === 4 * COL_W || r.rect.x === 5 * COL_W)).toBe(false);
    // vidro na ponta leste (x 111); o tile antes dele é corredor caminhável
    expect(b.grid.walkable(111, CORRIDOR_Y + 2)).toBe(false);
    expect(b.grid.walkable(110, CORRIDOR_Y + 2)).toBe(true);
    // do elevador (recepção, coluna 2) até a porta da sala, atravessando duas colunas de pátio seguidas
    const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
    const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
    const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
    const door = rooms[0].door!;
    expect(reach[b.grid.key(door.x, door.y)]).toBe(1);
    // os dois trechos vazios do corredor têm os seus pontos de conversa
    for (const c of [4, 5]) expect(b.spots.filter((s) => s.group === `core:corredor:talk:${c}`)).toHaveLength(2);
  });

  it('Review Focus 4: sem anexo, a porta sul do lounge é caminhável mas o jardim abaixo fica fora da grade', () => {
    const { b } = buildFor([0]);
    expect(b.grid.walkable(56, 28)).toBe(true);
    expect(b.grid.walkable(56, 29)).toBe(false);
    expect(b.grid.inside(56, 29)).toBe(false);
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

describe('layout do prédio', () => {
  const slots = [0, 1, 2, 3, 4, 7];
  const rooms = roomsFor(slots);
  const b = assembleBuilding(existingBlocks(slots), rooms);
  const reception = b.areas.find((a) => a.id === core.RECEPTION_ID)!;
  const corridor = corridorOf(b);
  const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
  const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
  const reachable = (x: number, y: number) => reach[b.grid.key(x, y)] === 1;
  // colunas de pé 0..5 (vagas 5 → 0N, 7 → 0S a oeste; 4 → 5N a leste); 4 delas são de projeto
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
        // tile do corredor imediatamente fora da porta
        const outside = room.side === 'north' ? door.y + door.h : door.y - 1;
        expect(outside >= CORRIDOR_Y && outside < SOUTH_Y).toBe(true);
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
    for (const area of [...core.coreAreas(PRINCIPAL), ...roomsFor([0, 1, 2, 3, 4, 7])]) expect(hiddenWallItems(area), area.id).toEqual([]);
  });

  it('passagens nas faces das paredes têm batente', () => {
    const restroom = core.coreAreas(PRINCIPAL).find((a) => a.kind === 'restroom')!;
    expect(restroom.wallItems.some((w) => w.kind === 'door_frame')).toBe(true);
    // salas ao sul (porta na face norte): vagas 2 (4S), 3 (1S) e 7 (0S)
    for (const room of roomsFor([2, 3, 7])) expect(room.wallItems.some((w) => w.kind === 'door_frame'), room.id).toBe(true);
  });
});

describe('núcleo por bloco (coreAreas)', () => {
  const areas = () => core.coreAreas(PRINCIPAL);
  const byId = (id: string) => areas().find((a) => a.id === id)!;
  const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

  it('monta recepção, WC, copa e lounge nas colunas 2 e 3 do principal, com os ids de hoje', () => {
    expect(areas().map((a) => a.id)).toEqual(['core:recepcao', 'core:banheiros', 'core:copa', 'core:lounge']);
    expect(byId('core:recepcao').rect).toEqual({ x: 32, y: 0, w: 16, h: 12 });
    expect(byId('core:banheiros').rect).toEqual({ x: 32, y: 17, w: 16, h: 12 });
    expect(byId('core:copa').rect).toEqual({ x: 48, y: 0, w: 16, h: 12 });
    expect(byId('core:lounge').rect).toEqual({ x: 48, y: 17, w: 16, h: 12 });
    // os elevadores (cx 3 e 6,5 locais) acompanham a coluna
    expect(byId('core:recepcao').spots.filter((s) => s.kind === 'elevator').map((s) => s.tx)).toEqual([34, 38]);
  });

  it('as portas do WC e do lounge acompanham o retângulo da área e continuam caminháveis', () => {
    expect(byId('core:banheiros').door).toEqual({ x: 39, y: 17, w: 2, h: 2 });
    expect(byId('core:banheiros').walkable).toContainEqual({ x: 39, y: 17, w: 2, h: 2 });
    expect(byId('core:lounge').door).toEqual({ x: 55, y: 17, w: 3, h: 2 });
    expect(byId('core:lounge').walkable).toContainEqual({ x: 55, y: 17, w: 3, h: 2 });
  });

  it('porta sul do lounge (para a passarela): vão de 3 tiles na parede sul, tile da linha 28 caminhável e `exit` separado de `door`', () => {
    const lounge = byId('core:lounge');
    expect(lounge.exit).toEqual({ x: 55, y: 28, w: 3, h: 1 });
    expect(lounge.walkable).toContainEqual({ x: 55, y: 28, w: 3, h: 1 });
    expect(lounge.door).toEqual({ x: 55, y: 17, w: 3, h: 2 }); // a porta do corredor não muda
    const south = lounge.walls.find((w) => w.kind === 'south')!;
    expect(south.doorways).toEqual([{ x: 55 * TILE, w: 3 * TILE }]);
    // os puffs saem do caminho da porta (lx 7..9 livres na linha 9): ficam em lx 6 e 10
    expect(lounge.furniture.filter((f) => f.kind === 'beanbag').map((f) => f.tx)).toEqual([54, 58]);
    expect(lounge.spots.filter((s) => s.kind === 'beanbag')).toHaveLength(2);
  });

  it('as outras áreas do núcleo não têm porta externa', () => {
    for (const id of ['core:recepcao', 'core:banheiros', 'core:copa']) expect(byId(id).exit, id).toBeUndefined();
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

  it('as funções de área aceitam o retângulo antigo (x 0 e 16): nada se move antes da virada', () => {
    const reception = core.layoutReception({ x: 0, y: 0, w: 16, h: 12 });
    expect(reception.rect).toEqual({ x: 0, y: 0, w: 16, h: 12 });
    expect(reception.walkable).toEqual([{ x: 1, y: 2, w: 14, h: 10 }]);
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
    const [hub, wc] = hubAreas(A1, true);
    expect([hub.id, hub.kind, hub.rect]).toEqual(['anexo:0,1:saguao', 'hub', { x: 40, y: 41, w: 16, h: 12 }]);
    expect([wc.id, wc.kind, wc.rect]).toEqual(['anexo:0,1:wc', 'restroom', { x: 40, y: 58, w: 16, h: 12 }]);
    expect(wc.door).toEqual({ x: 47, y: 58, w: 2, h: 2 });
  });

  it('com passarela: porta externa de 3 tiles na face norte (exit, vão, batente wide3), sem janela', () => {
    const hub = layoutHub(A1, true);
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
    const hub = layoutHub(A1, false);
    expect(hub.exit).toBeUndefined();
    expect(hub.walls.find((w) => w.kind === 'face')!.doorways).toBeUndefined(); // o builder não guarda lista vazia
    expect(hub.wallItems.some((w) => w.kind === 'door_frame')).toBe(false);
    expect(hub.wallItems.filter((w) => w.kind === 'window')).toHaveLength(1);
    expect(hub.walkable.every((r) => r.y >= 43)).toBe(true);
  });

  it('aberto para o corredor ao sul como a recepção: vidro só nas pontas da linha 11, o meio livre', () => {
    const hub = layoutHub(A1, true);
    expect(hub.walkable).toContainEqual({ x: 41, y: 43, w: 14, h: 10 });
    expect(hub.walls.some((w) => w.kind === 'south')).toBe(false);
    expect(hub.furniture.filter((f) => f.kind === 'glass_partition' && f.variant === 'h' && f.ty === 52).map((f) => f.tx)).toEqual([41, 42, 43, 52, 53, 54]);
  });

  it('serviços do saguão: um café, uma água, uma pia, uma cabine, dois lugares no banco, dois de conversa; nada de lanche, geladeira, mesa ou janela', () => {
    const hub = layoutHub(A1, true);
    expect(kinds(hub, 'coffee')).toHaveLength(1);
    expect(kinds(hub, 'water')).toHaveLength(1);
    expect(kinds(hub, 'sink')).toHaveLength(1);
    expect(kinds(hub, 'stall')).toHaveLength(1);
    expect(kinds(hub, 'bench')).toHaveLength(2);
    expect(kinds(hub, 'talk')).toHaveLength(2);
    for (const k of ['snack', 'fridge', 'cafe_seat', 'window', 'elevator']) expect(kinds(hub, k), k).toHaveLength(0);
    expect(kinds(hub, 'coffee')[0].furnitureId).toBeDefined();
    expect(kinds(hub, 'stall')[0].furnitureId).toBeDefined();
    expect(kinds(hub, 'talk').map((s) => s.group)).toEqual(['talk:anexo:0,1:saguao', 'talk:anexo:0,1:saguao']);
    // o banheirinho fica atrás de vidro (divisória vertical em lx 10, linhas 2–5)
    expect(hub.furniture.filter((f) => f.kind === 'glass_partition' && f.tx === 50).map((f) => [f.ty, f.variant])).toEqual([[43, 'v'], [44, 'v'], [45, 'v'], [46, 'end']]);
  });

  it('nada fica fora do retângulo da área (saguão com e sem porta, WC)', () => {
    for (const a of [...hubAreas(A1, true), layoutHub(A1, false)]) {
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
    expect(hubAreas(A1, true)).toBe(hubAreas({ bx: 0, by: 1 }, true));
    expect(hubAreas(A1, true)).not.toBe(hubAreas(A1, false));
    expect(hubAreas(A1, false)[0].exit).toBeUndefined();
    expect(hubAreas(A1, true)[0].exit).toBeDefined();
  });
});

describe('entrada decorativa na face norte da recepção', () => {
  /** A recepção na coluna 2 do principal (x 32..48). */
  const reception = () => core.layoutReception({ x: 32, y: 0, w: 16, h: 12 });
  /** Largura em tiles de um item de parede: a porta fechada cobre 3 tiles (o footprint de `door_frame` é o da `single`). */
  const tilesOf = (w: { kind: FurnitureKind; variant?: string }) => (w.kind === 'door_frame' && w.variant === 'closed' ? 3 : FURNITURE[w.kind].footprint.w);

  it('há uma porta fechada de 3 tiles em lx 7,5..10,5, só desenho: sem vão na face, sem porta e sem mudar o walk', () => {
    const r = reception();
    const doors = r.wallItems.filter((w) => w.kind === 'door_frame');
    expect(doors).toHaveLength(1);
    expect(doors[0].variant).toBe('closed');
    expect(doors[0].on).toBe('face');
    expect(doors[0].cx).toBe((32 + 9) * TILE);
    for (const w of r.walls) if (w.kind === 'face') expect(w.doorways).toBeUndefined();
    expect(r.door).toBeUndefined();
    expect(r.walkable).toEqual([{ x: 33, y: 2, w: 14, h: 10 }]);
  });

  it('elevadores, porta, placa, relógio e quadro cabem na face sem se sobrepor', () => {
    const spans = reception()
      .wallItems.filter((w) => w.on === 'face')
      .map((w) => ({ kind: w.kind, x0: w.cx - (tilesOf(w) * TILE) / 2, x1: w.cx + (tilesOf(w) * TILE) / 2 }))
      .sort((a, b) => a.x0 - b.x0);
    expect([...spans.map((s) => s.kind)].sort()).toEqual(['clock', 'door_frame', 'elevator', 'elevator', 'painting', 'sign']);
    for (let i = 1; i < spans.length; i++) expect(spans[i].x0, `${spans[i].kind} sobre ${spans[i - 1].kind}`).toBeGreaterThanOrEqual(spans[i - 1].x1);
    // dentro da face (lx 0,5..15,5; as caps ocupam 0..0,5 e 15,5..16)
    for (const s of spans) expect(s.x0 >= 32.5 * TILE && s.x1 <= 47.5 * TILE, s.kind).toBe(true);
    // elevadores (2..4 e 5,5..7,5) e placa (10,5..13,5) onde o contrato manda; a porta logo a leste do segundo elevador
    const at = (kind: FurnitureKind) => spans.filter((s) => s.kind === kind).map((s) => [s.x0 / TILE - 32, s.x1 / TILE - 32]);
    expect(at('elevator')).toEqual([
      [2, 4],
      [5.5, 7.5],
    ]);
    expect(at('door_frame')).toEqual([[7.5, 10.5]]);
    expect(at('sign')).toEqual([[10.5, 13.5]]);
  });

  it('nenhum item da face norte fica atrás de um móvel alto', () => {
    expect(hiddenWallItems(reception())).toEqual([]);
  });
});

describe('área externa por blocos', () => {
  const PLANTS = new Set(['tree', 'pine', 'bush']);
  const hedgesOf = (slots: number[]) => layoutExterior(existingBlocks(slots)).props.filter((p) => p.kind === 'hedge' || p.kind === 'flowers');
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

  it('entrada ao norte da recepção: caminho de pedra em x 39,5..42,5 × y −4..0, totem e banco ao lado', () => {
    const ext = layoutExterior(existingBlocks([0]));
    expect(ENTRANCE_X * TILE).toBe(632);
    const path = ext.floors.filter((f) => f.kind === 'sidewalk' && f.x === ENTRANCE_X * TILE);
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({ x: 39.5 * TILE, y: -ENTRANCE_DEPTH * TILE, w: ENTRANCE_W * TILE, h: ENTRANCE_DEPTH * TILE });
    expect(path[0]).toMatchObject({ y: -4 * TILE, w: 3 * TILE, h: 4 * TILE });
    const totem = ext.props.filter((p) => p.kind === 'totem');
    expect(totem).toHaveLength(1);
    expect(totem[0]).toMatchObject({ x: 37 * TILE + 8, y: -1 * TILE });
    const bench = ext.props.filter((p) => p.kind === 'bench');
    expect(bench).toHaveLength(1);
    expect(bench[0]).toMatchObject({ x: 45 * TILE, y: -1 * TILE + 6 });
    for (const p of [...totem, ...bench]) expect(p.y >= -4 * TILE && p.y < 0, `${p.kind} fora da faixa y −4..0`).toBe(true);
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

  it('árvores e arbustos deixam livre a zona da entrada: x [34, 48)·TILE × y [−8, 0)·TILE', () => {
    for (const slots of [[], [0], [0, 1, 2, 3, 4, 5]]) {
      const ext = layoutExterior(existingBlocks(slots));
      const north = ext.props.filter((p) => PLANTS.has(p.kind) && p.y < 0);
      expect(north.length, `vagas [${slots.join(',')}]: bosque ao norte sumiu`).toBeGreaterThan(0);
      const inside = north.filter((p) => p.x >= 34 * TILE && p.x < 48 * TILE && p.y >= -8 * TILE);
      expect(inside, `vagas [${slots.join(',')}]`).toEqual([]);
    }
  });

  it('cerca viva: cobre o prédio de pé e só tem whenRoom diante das colunas de sala, nunca do miolo (Review Focus 3)', () => {
    expect(gates([])).toEqual(new Set());
    expect(gates([0])).toEqual(new Set([2]));
    expect(gates([0, 1, 2, 3, 4, 5])).toEqual(new Set([7, 3, 2, 6]));
    expect(gates([0, 1, 2, 3, 16])).toEqual(new Set([3, 2, 6, 17]));
    // extensão: de world.x a world.x + world.w − 2, de 2 em 2 tiles (colunas 1–4 → x 16..80)
    const xs = hedgesOf([0, 1]).map((p) => (p.x - TILE) / TILE);
    expect(Math.min(...xs)).toBe(16);
    expect(Math.max(...xs)).toBe(78);
    expect(xs).toHaveLength(32);
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
    // colunas de pé 1..6 com a 5 vazia (vaga 16 = coluna 6 norte, transitório 7.5)
    const blocks = existingBlocks([0, 1, 2, 3, 16]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].columns).toEqual({ lo: 1, hi: 6 });
    const shells = shellsOf([0, 1, 2, 3, 16]);
    expect(shells.map((s) => s.sh.slot)).toEqual([1, 3, 0, 2, 4, 6, 16, 17]);
    expect(shells.map((s) => s.col)).toEqual([1, 1, 4, 4, 5, 5, 6, 6]);
    expect(capsAt(shells, 16 * TILE)).toEqual([1, 3]); // oeste: só a coluna lo = 1
    expect(capsAt(shells, 7 * COL_W * TILE - 8)).toEqual([16, 17]); // leste: só a coluna hi = 6 (x 96..112, fora do envelope)
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe(s.col === 1 || s.col === 6 ? 1 : 0);
    }
    expect(shells.some((s) => s.col === 2 || s.col === 3)).toBe(false);
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

  it('pátios com as colunas 4 e 5 vazias entre o miolo e a sala da coluna 6 (vaga 16): cap leste só na coluna 6, nenhum cap a oeste porque a ponta oeste é o miolo', () => {
    // existingBlocks([16]) → colunas 2–6: 2 e 3 miolo, 4 e 5 pátio dos dois lados, a 6 tem a sala (vaga 16 = 6N, transitório 7.5) e o pátio da vaga 17 ao sul
    expect(existingBlocks([16])[0].columns).toEqual({ lo: 2, hi: 6 });
    const shells = shellsOf([16]);
    expect(shells.map((s) => s.sh.slot)).toEqual([0, 2, 4, 6, 16, 17]);
    expect(shells.map((s) => s.col)).toEqual([4, 4, 5, 5, 6, 6]);
    expect(shells[4].sh.rect).toEqual({ x: 96, y: 0, w: 16, h: 12 }); // vaga 16 = coluna 6, norte (fora do envelope)
    expect(shells[5].sh.rect).toEqual({ x: 96, y: SOUTH_Y, w: 16, h: 12 }); // vaga 17 = coluna 6, sul
    expect(capsAt(shells, 7 * COL_W * TILE - 8)).toEqual([16, 17]); // leste: só a coluna hi = 6
    expect(capsAt(shells, 32 * TILE)).toEqual([]); // a ponta oeste (lo = 2) é miolo: sem shell e sem cap
    for (const s of shells) {
      const caps = s.sh.walls.filter((w) => w.kind === 'cap').length;
      expect(caps, `vaga ${s.sh.slot} (coluna ${s.col})`).toBe(s.col === 6 ? 1 : 0);
    }
    expect(shells.some((s) => s.col === 2 || s.col === 3)).toBe(false);
    // a cerca viva abre diante das vagas sul das colunas 4, 5 e 6
    expect(gates([16])).toEqual(new Set([2, 6, 17]));
  });
});
