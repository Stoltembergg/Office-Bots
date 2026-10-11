import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE, type FurnitureKind, type RoomTheme } from '../../art/api';
import { BUILDING_H, COL_W, CORRIDOR_Y, SOUTH_Y } from '../constants';
import { assembleBuilding, coreAreas } from './building';
import { PRINCIPAL, columnsFor, legacySlotAt, slotColumn, slotRect, slotSide } from './geometry';
import { layoutProjectRoom, roomVariant } from './room';
import { layoutExterior, slotShell } from './exterior';
import * as core from './core';
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

describe('mapeamento de slots', () => {
  it('coluna = núcleo + floor(slot/2); par = norte, ímpar = sul', () => {
    expect(slotColumn(0)).toBe(2);
    expect(slotColumn(1)).toBe(2);
    expect(slotColumn(2)).toBe(3);
    expect(slotColumn(7)).toBe(5);
    expect(slotSide(0)).toBe('north');
    expect(slotSide(1)).toBe('south');
    expect(slotSide(6)).toBe('north');
    expect(legacySlotAt(3, 'south')).toBe(3);
    expect(legacySlotAt(slotColumn(9), slotSide(9))).toBe(9);
  });

  it('retângulos das salas não se sobrepõem e respeitam o corredor', () => {
    const a = slotRect(0);
    const b = slotRect(1);
    expect(a).toEqual({ x: 2 * COL_W, y: 0, w: COL_W, h: 12 });
    expect(b.y).toBe(SOUTH_Y);
    expect(a.y + a.h).toBe(CORRIDOR_Y);
    expect(b.y + b.h).toBe(BUILDING_H);
  });

  it('largura do prédio: núcleo + maior coluna usada + 1 (mínimo 1 coluna de projeto)', () => {
    expect(columnsFor([])).toBe(3);
    expect(columnsFor([0, 1])).toBe(3);
    expect(columnsFor([5])).toBe(5);
    expect(columnsFor([2, 11])).toBe(8);
  });
});

describe('layout do prédio', () => {
  const slots = [0, 1, 2, 3, 4, 7];
  const rooms = roomsFor(slots);
  const cols = columnsFor(slots);
  const b = assembleBuilding(cols, rooms);
  const reception = coreAreas().find((a) => a.id === core.RECEPTION_ID)!;
  const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
  const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
  const reachable = (x: number, y: number) => reach[b.grid.key(x, y)] === 1;

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
    for (const area of [...b.core, b.corridor, ...rooms]) {
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

  it('corredor alterna bebedouro e banco nas colunas de projeto, sem excesso de plantas', () => {
    const coolers = b.corridor.furniture.filter((f) => f.kind === 'water_cooler');
    expect(coolers.length).toBeGreaterThanOrEqual(Math.ceil((cols - 2) / 2));
    const benches = b.corridor.furniture.filter((f) => f.kind === 'bench');
    expect(benches.length).toBeGreaterThanOrEqual(Math.floor((cols - 2) / 2));
    const plants = b.corridor.furniture.filter((f) => f.kind === 'plant_tall' || f.kind === 'plant_small');
    expect(plants.length).toBeLessThanOrEqual(cols * 2);
  });

  it('a área externa e os pátios cobrem o prédio', () => {
    const ext = layoutExterior(cols);
    expect(ext.bounds.x).toBeLessThan(0);
    expect(ext.bounds.x + ext.bounds.w).toBeGreaterThan(cols * COL_W);
    const shell = slotShell(5, true);
    expect(shell.walls.length).toBeGreaterThan(0);
    expect(shell.props.every((p) => p.slot === 5)).toBe(true);
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
    for (const slot of [0, 1]) {
      for (const seed of seeds) {
        const room = layoutProjectRoom({ id: `/v/${seed}`, slot, seed }, theme);
        const b = assembleBuilding(columnsFor([slot]), [room]);
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
    for (const area of [...coreAreas(), ...roomsFor([0, 1, 2, 3, 4, 7])]) expect(hiddenWallItems(area), area.id).toEqual([]);
  });

  it('passagens nas faces das paredes têm batente', () => {
    const restroom = coreAreas().find((a) => a.kind === 'restroom')!;
    expect(restroom.wallItems.some((w) => w.kind === 'door_frame')).toBe(true);
    for (const room of roomsFor([1, 3, 7])) expect(room.wallItems.some((w) => w.kind === 'door_frame'), room.id).toBe(true);
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

  it('nada fica fora do retângulo da área (nenhum número absoluto sobrou)', () => {
    for (const a of areas()) {
      const r = a.rect;
      const px = { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
      for (const t of [...a.walkable, ...(a.blocked ?? []), ...(a.door ? [a.door] : [])]) {
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
    // compat até a Tarefa 5: o prédio de hoje continua montando o núcleo em x 0 e 16
    expect(coreAreas().map((a) => a.rect.x)).toEqual([0, 0, 16, 16]);
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
