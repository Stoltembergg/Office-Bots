// Modelo de blocos (spec seção 1): envelopes, ordem dos blocos, vagas por bloco, colunas de pé, blocos
// existentes e a trava por coluna. Os números são os das tabelas do plano (00-header, "Regras numéricas").
import { describe, expect, it } from 'vitest';
import { BUILDING_H, COL_W, ROOM_H, SOUTH_Y } from '../constants';
import * as constants from '../constants';
import * as geometry from './geometry';
import {
  ANNEX_COLS,
  IMPLEMENTED_BLOCKS,
  MAIN_COLS,
  PRINCIPAL,
  ROOMS_PER_BLOCK,
  ROW_STEP,
  SLOT_ORDER,
  STREET_W,
  arrivalOf,
  blockColumnRect,
  blockCols,
  blockFor,
  blockIndex,
  blockKey,
  blockOrder,
  blockRect,
  columnAt,
  coreColumns,
  existingBlocks,
  isCoreColumn,
  isPrincipal,
  occupiedColumns,
  parentOf,
  retainColumns,
  slotAddress,
  slotAt,
  standingColumns,
  standingRect,
  worldBounds,
  type BlockId,
  type Side,
} from './geometry';

const B = (bx: number, by: number): BlockId => ({ bx, by });

describe('constantes do modelo', () => {
  it('fase 1: um bloco implementado, 8 vagas por bloco, envelopes de 6 e 5 colunas, rua de 12, passo de fileira 41', () => {
    expect(IMPLEMENTED_BLOCKS).toBe(1);
    expect(ROOMS_PER_BLOCK).toBe(8);
    expect(MAIN_COLS).toBe(6);
    expect(ANNEX_COLS).toBe(5);
    expect(STREET_W).toBe(12);
    expect(ROW_STEP).toBe(41);
    expect(BUILDING_H).toBe(29);
  });

  it('blockKey, isPrincipal, blockCols, coreColumns e isCoreColumn', () => {
    expect(blockKey(PRINCIPAL)).toBe('0,0');
    expect(blockKey(B(-2, 1))).toBe('-2,1');
    expect(isPrincipal(PRINCIPAL)).toBe(true);
    expect(isPrincipal(B(0, 1))).toBe(false);
    expect(blockCols(PRINCIPAL)).toBe(6);
    expect(blockCols(B(1, 0))).toBe(5);
    expect(coreColumns(PRINCIPAL)).toEqual([2, 3]);
    expect(coreColumns(B(0, -1))).toEqual([2]);
    expect(isCoreColumn(PRINCIPAL, 2)).toBe(true);
    expect(isCoreColumn(PRINCIPAL, 3)).toBe(true);
    expect(isCoreColumn(PRINCIPAL, 4)).toBe(false);
    expect(isCoreColumn(B(1, 0), 2)).toBe(true);
    expect(isCoreColumn(B(1, 0), 3)).toBe(false);
  });
});

describe('blockRect: envelope (spec 1.1)', () => {
  const table: [number, number, number, number][] = [
    [0, 0, 0, 96],
    [0, 1, 8, 80],
    [0, -1, 8, 80],
    [1, 0, 108, 80],
    [1, 1, 108, 80],
    [1, -1, 108, 80],
    [2, 0, 200, 80],
    [2, 1, 200, 80],
    [2, -1, 200, 80],
    [-1, 0, -92, 80],
    [-1, 1, -92, 80],
    [-1, -1, -92, 80],
    [-2, 0, -184, 80],
    [-2, 1, -184, 80],
    [-2, -1, -184, 80],
  ];
  it.each(table)('bloco (%i, %i) → x %i, w %i, y = by·41, h 29', (bx, by, x, w) => {
    expect(blockRect(B(bx, by))).toEqual({ x, y: by * 41, w, h: 29 });
  });
});

describe('blockOrder / blockIndex (spec 1.4)', () => {
  const sequence: [number, number][] = [
    [0, 0], [0, 1], [1, 0], [1, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [-1, -1],
    [2, 0], [2, 1], [-2, 0], [-2, 1], [2, -1], [-2, -1], [3, 0],
  ];

  it('blockOrder(0..15): principal, depois A1 (0,1), A2 (1,0) e assim por diante até A15 (3,0)', () => {
    sequence.forEach(([bx, by], n) => expect(blockOrder(n)).toEqual(B(bx, by)));
  });

  it('blockIndex é o inverso exato de blockOrder para n = 0..40', () => {
    for (let n = 0; n <= 40; n++) expect(blockIndex(blockOrder(n))).toBe(n);
  });

  it('os 41 primeiros blocos da ordem são todos distintos', () => {
    const keys = new Set<string>();
    for (let n = 0; n <= 40; n++) keys.add(blockKey(blockOrder(n)));
    expect(keys.size).toBe(41);
  });
});

describe('parentOf / arrivalOf (spec 1.4)', () => {
  it('o principal não tem pai; cada anexo aponta para o bloco uma casa mais perto do principal', () => {
    expect(parentOf(PRINCIPAL)).toBeNull();
    expect(parentOf(B(0, 1))).toEqual(PRINCIPAL);
    expect(parentOf(B(0, -1))).toEqual(PRINCIPAL);
    expect(parentOf(B(1, 0))).toEqual(PRINCIPAL);
    expect(parentOf(B(-1, 0))).toEqual(PRINCIPAL);
    expect(parentOf(B(2, 0))).toEqual(B(1, 0));
    expect(parentOf(B(-2, 0))).toEqual(B(-1, 0));
    expect(parentOf(B(1, 1))).toEqual(B(1, 0));
    expect(parentOf(B(-2, 1))).toEqual(B(-2, 0));
    expect(parentOf(B(1, -1))).toEqual(B(0, -1));
    expect(parentOf(B(2, -1))).toEqual(B(1, -1));
    expect(parentOf(B(-1, -1))).toEqual(B(0, -1));
  });

  it('chegada: core no principal, hub nos verticais, west/east nos laterais conforme o lado do pai', () => {
    expect(arrivalOf(PRINCIPAL)).toBe('core');
    expect(arrivalOf(B(0, 1))).toBe('hub');
    expect(arrivalOf(B(0, -1))).toBe('hub');
    expect(arrivalOf(B(1, 1))).toBe('hub');
    expect(arrivalOf(B(-2, 1))).toBe('hub');
    expect(arrivalOf(B(1, 0))).toBe('west');
    expect(arrivalOf(B(2, -1))).toBe('west');
    expect(arrivalOf(B(-1, 0))).toBe('east');
    expect(arrivalOf(B(-1, -1))).toBe('east');
  });
});

describe('vagas: slotAddress / slotAt / blockFor (spec 1.2 e 7.5)', () => {
  const k1: [number, number, Side][] = [
    [0, 4, 'north'],
    [1, 1, 'north'],
    [2, 4, 'south'],
    [3, 1, 'south'],
    [4, 5, 'north'],
    [5, 0, 'north'],
    [6, 5, 'south'],
    [7, 0, 'south'],
    [8, 6, 'north'],
    [9, 6, 'south'],
    [10, 7, 'north'],
    [11, 7, 'south'],
  ];
  it.each(k1)('k = 1: vaga %i → principal, coluna %i, %s; slotAt devolve a vaga', (slot, col, side) => {
    expect(slotAddress(slot)).toEqual({ block: PRINCIPAL, col, side });
    expect(blockFor(slot)).toEqual(PRINCIPAL);
    expect(slotAt(PRINCIPAL, col, side)).toBe(slot);
  });

  it('SLOT_ORDER tem as quatro ordens da spec 1.2', () => {
    expect(SLOT_ORDER.core).toEqual([[4, 'north'], [1, 'north'], [4, 'south'], [1, 'south'], [5, 'north'], [0, 'north'], [5, 'south'], [0, 'south']]);
    expect(SLOT_ORDER.hub).toEqual([[3, 'north'], [1, 'north'], [3, 'south'], [1, 'south'], [4, 'north'], [0, 'north'], [4, 'south'], [0, 'south']]);
    expect(SLOT_ORDER.west).toEqual([[0, 'north'], [0, 'south'], [1, 'north'], [1, 'south'], [3, 'north'], [3, 'south'], [4, 'north'], [4, 'south']]);
    expect(SLOT_ORDER.east).toEqual([[4, 'north'], [4, 'south'], [3, 'north'], [3, 'south'], [1, 'north'], [1, 'south'], [0, 'north'], [0, 'south']]);
  });

  it('k = 15: vagas 8, 16, 17 e 24 caem em A1 (0,1), A2 (1,0) e A3 (1,1)', () => {
    expect(slotAddress(8, 15)).toEqual({ block: B(0, 1), col: 3, side: 'north' });
    expect(slotAddress(16, 15)).toEqual({ block: B(1, 0), col: 0, side: 'north' });
    expect(slotAddress(17, 15)).toEqual({ block: B(1, 0), col: 0, side: 'south' });
    expect(slotAddress(24, 15)).toEqual({ block: B(1, 1), col: 3, side: 'north' });
    expect(blockFor(16, 15)).toEqual(B(1, 0));
    expect(blockFor(16)).toEqual(PRINCIPAL);
  });

  const blocks: [string, number, BlockId][] = [
    ['principal (core)', 0, PRINCIPAL],
    ['A1 (0,1), hub', 1, B(0, 1)],
    ['A2 (1,0), west', 2, B(1, 0)],
    ['A4 (−1,0), east', 4, B(-1, 0)],
  ];
  it.each(blocks)('k = 15: ida e volta das 8 vagas do bloco %s', (_name, n, block) => {
    const order = SLOT_ORDER[arrivalOf(block)];
    for (let i = 0; i < 8; i++) {
      const slot = 8 * n + i;
      const [col, side] = order[i];
      expect(slotAddress(slot, 15)).toEqual({ block, col, side });
      expect(slotAt(block, col, side, 15)).toBe(slot);
    }
  });

  it('transitório 7.5: colunas ≥ 6 do principal são as vagas a partir de 8k', () => {
    expect(slotAt(PRINCIPAL, 6, 'north')).toBe(8);
    expect(slotAt(PRINCIPAL, 7, 'south')).toBe(11);
    expect(slotAt(PRINCIPAL, 6, 'north', 15)).toBe(120);
    expect(slotAddress(120, 15)).toEqual({ block: PRINCIPAL, col: 6, side: 'north' });
  });

  it('Review Focus 3: slotAt lança Error para coluna de miolo (2 e 3 no principal, 2 no anexo)', () => {
    expect(() => slotAt(PRINCIPAL, 2, 'north')).toThrow(Error);
    expect(() => slotAt(PRINCIPAL, 3, 'south')).toThrow(Error);
    expect(() => slotAt(B(0, 1), 2, 'north', 15)).toThrow(Error);
    expect(() => slotAt(B(1, 0), 2, 'south', 15)).toThrow(Error);
  });
});

describe('blockColumnRect', () => {
  it('coluna × lado dentro do envelope do bloco, em tiles absolutos', () => {
    expect(blockColumnRect(PRINCIPAL, 4, 'north')).toEqual({ x: 64, y: 0, w: COL_W, h: ROOM_H });
    expect(blockColumnRect(PRINCIPAL, 1, 'south')).toEqual({ x: 16, y: SOUTH_Y, w: COL_W, h: ROOM_H });
    expect(blockColumnRect(PRINCIPAL, 6, 'north')).toEqual({ x: 96, y: 0, w: 16, h: 12 });
    expect(blockColumnRect(B(1, 1), 0, 'south')).toEqual({ x: 108, y: 41 + 17, w: 16, h: 12 });
    expect(blockColumnRect(B(-1, 0), 4, 'north')).toEqual({ x: -92 + 64, y: 0, w: 16, h: 12 });
  });
});

describe('standingColumns (spec 1.3)', () => {
  const principal: [number[], number, number][] = [
    [[], 2, 3],
    [[0], 2, 4],
    [[0, 1], 1, 4],
    [[0, 1, 2, 3], 1, 4],
    [[0, 1, 2, 3, 4], 1, 5],
    [[0, 1, 2, 3, 4, 5], 0, 5],
    [[8], 2, 6],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 6],
    [[5], 0, 3],
  ];
  it.each(principal)('principal, k = 1: vagas %j → {lo %i, hi %i}', (slots, lo, hi) => {
    expect(standingColumns(PRINCIPAL, slots)).toEqual({ lo, hi });
  });

  it('Review Focus 1: sala na coluna extra com a coluna 5 vazia: vagas [0,1,2,3,8] → {1, 6}', () => {
    expect(standingColumns(PRINCIPAL, [0, 1, 2, 3, 8])).toEqual({ lo: 1, hi: 6 });
  });

  it('aceita Set além de array', () => {
    expect(standingColumns(PRINCIPAL, new Set([0, 1]))).toEqual({ lo: 1, hi: 4 });
  });

  it('filho lateral puxa a ponta voltada para ele; filho vertical só o miolo', () => {
    expect(standingColumns(PRINCIPAL, [], [B(1, 0)])).toEqual({ lo: 2, hi: 5 });
    expect(standingColumns(PRINCIPAL, [], [B(-1, 0)])).toEqual({ lo: 0, hi: 3 });
    expect(standingColumns(PRINCIPAL, [0], [B(0, 1)])).toEqual({ lo: 2, hi: 4 });
  });

  it('anexo lateral inclui a ponta por onde chega (0 com o pai a oeste, 4 com o pai a leste)', () => {
    expect(standingColumns(B(1, 0), [], [], 15)).toEqual({ lo: 0, hi: 2 });
    expect(standingColumns(B(-1, 0), [], [], 15)).toEqual({ lo: 2, hi: 4 });
    expect(standingColumns(B(0, 1), [8], [], 15)).toEqual({ lo: 2, hi: 3 });
  });

  it('vagas de outros blocos não contam', () => {
    expect(standingColumns(B(1, 0), [0, 1, 8], [], 15)).toEqual({ lo: 0, hi: 2 });
  });
});

describe('standingRect', () => {
  it('recorta o envelope às colunas lo..hi', () => {
    expect(standingRect(PRINCIPAL, { lo: 2, hi: 3 })).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(standingRect(B(-1, 0), { lo: 2, hi: 4 })).toEqual({ x: -60, y: 0, w: 48, h: 29 });
  });

  it('Review Focus 1: com hi = 6 o retângulo de pé passa do envelope (x 16..112)', () => {
    const r = standingRect(PRINCIPAL, { lo: 1, hi: 6 });
    expect(r).toEqual({ x: 16, y: 0, w: 96, h: 29 });
    expect(r.x + r.w).toBe(112);
    const env = blockRect(PRINCIPAL);
    expect(r.x + r.w).toBeGreaterThan(env.x + env.w);
  });
});

describe('existingBlocks', () => {
  it('sem sala: só o principal, de pé nas colunas 2–3 (x 32..64)', () => {
    const blocks = existingBlocks([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      id: PRINCIPAL,
      envelope: { x: 0, y: 0, w: 96, h: 29 },
      columns: { lo: 2, hi: 3 },
      rect: { x: 32, y: 0, w: 32, h: 29 },
    });
  });

  it('vagas 0 e 1 (4N e 1N): colunas 1–4, rect x 16..80', () => {
    const blocks = existingBlocks([0, 1]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    expect(blocks[0].rect).toEqual({ x: 16, y: 0, w: 64, h: 29 });
  });

  it('k = 1: vagas ≥ 8 ficam no principal (um bloco só), em colunas extras a leste', () => {
    const blocks = existingBlocks(new Set([8, 9, 16]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].columns).toEqual({ lo: 2, hi: 10 });
  });

  it('k = 15: vaga 16 mantém o filho (1,0) e o pai (0,0), que ganha a coluna 5', () => {
    const blocks = existingBlocks([16], 15);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(1, 0)]);
    expect(blocks[0].columns).toEqual({ lo: 2, hi: 5 });
    expect(blocks[0].rect).toEqual({ x: 32, y: 0, w: 64, h: 29 });
    expect(blocks[1].envelope).toEqual({ x: 108, y: 0, w: 80, h: 29 });
    expect(blocks[1].columns).toEqual({ lo: 0, hi: 2 });
    expect(blocks[1].rect).toEqual({ x: 108, y: 0, w: 48, h: 29 });
  });

  it('k = 15: ancestrais entram em cadeia e a lista sai ordenada por blockIndex', () => {
    // A9 (2,0) → A2 (1,0) → principal; A1 (0,1) → principal.
    const blocks = existingBlocks([72, 8], 15);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1), B(1, 0), B(2, 0)]);
    // A2 fica de pé da ponta oeste (pai) à ponta leste (filho A9).
    expect(blocks[2].columns).toEqual({ lo: 0, hi: 4 });
  });
});

describe('worldBounds', () => {
  it('sem blocos: o principal recortado às colunas 2–3', () => {
    expect(worldBounds([])).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(worldBounds([])).toEqual(existingBlocks([])[0].rect);
  });

  it('união dos retângulos de pé (k = 15, anexo a oeste com x negativo)', () => {
    const blocks = existingBlocks([32], 15); // A4 (−1,0)
    expect(blocks[0].rect).toEqual({ x: 0, y: 0, w: 64, h: 29 });
    expect(blocks[1].rect).toEqual({ x: -60, y: 0, w: 48, h: 29 });
    expect(worldBounds(blocks)).toEqual({ x: -60, y: 0, w: 124, h: 29 });
  });

  it('união com bloco na fileira norte (k = 15, A6 em y negativo)', () => {
    const blocks = existingBlocks([48], 15); // A6 (0,−1): vaga 48 → coluna 3 norte; o principal fica só com o miolo
    expect(blocks[0].rect).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(blocks[1].rect).toEqual({ x: 40, y: -41, w: 32, h: 29 });
    expect(worldBounds(blocks)).toEqual({ x: 32, y: -41, w: 40, h: 70 });
  });

  it('k = 1: é o retângulo de pé do principal, inclusive além do envelope', () => {
    expect(worldBounds(existingBlocks([0, 1, 2, 3, 8]))).toEqual({ x: 16, y: 0, w: 96, h: 29 });
  });
});

describe('columnAt', () => {
  const block = existingBlocks([0, 1])[0]; // colunas 1–4

  it('devolve a coluna de pé que contém o tile', () => {
    expect(columnAt(block, 16, 0)).toBe(1);
    expect(columnAt(block, 40, 12)).toBe(2);
    expect(columnAt(block, 79, 28)).toBe(4);
  });

  it('null fora das colunas de pé ou fora da altura do bloco', () => {
    expect(columnAt(block, 15, 5)).toBeNull();
    expect(columnAt(block, 80, 5)).toBeNull();
    expect(columnAt(block, 40, -1)).toBeNull();
    expect(columnAt(block, 40, 29)).toBeNull();
  });
});

describe('occupiedColumns', () => {
  it('uma referência por (bloco, coluna), sem repetição; tiles fora de todo bloco são ignorados', () => {
    const blocks = existingBlocks([0, 1]);
    const refs = occupiedColumns(blocks, [
      { tx: 20, ty: 13 },
      { tx: 25, ty: 14 },
      { tx: 70, ty: 3 },
      { tx: 200, ty: 3 },
      { tx: 40, ty: -5 },
    ]);
    expect(refs).toEqual([
      { block: PRINCIPAL, col: 1 },
      { block: PRINCIPAL, col: 4 },
    ]);
  });

  it('vazio quando não há ninguém', () => {
    expect(occupiedColumns(existingBlocks([]), [])).toEqual([]);
  });
});

describe('retainColumns', () => {
  const base = existingBlocks([0]); // colunas 2–4

  it('mantém a coluna ocupada além das salas presentes e recalcula o rect (retained = true)', () => {
    const kept = retainColumns(base, [{ block: PRINCIPAL, col: 5 }]);
    expect(kept.retained).toBe(true);
    expect(kept.blocks[0].columns).toEqual({ lo: 2, hi: 5 });
    expect(kept.blocks[0].rect).toEqual({ x: 32, y: 0, w: 64, h: 29 });
  });

  it('estende também para oeste', () => {
    const kept = retainColumns(base, [{ block: PRINCIPAL, col: 0 }]);
    expect(kept.retained).toBe(true);
    expect(kept.blocks[0].columns).toEqual({ lo: 0, hi: 4 });
    expect(kept.blocks[0].rect).toEqual({ x: 0, y: 0, w: 80, h: 29 });
  });

  it('coluna já de pé: nada muda (retained = false)', () => {
    const same = retainColumns(base, [{ block: PRINCIPAL, col: 3 }]);
    expect(same.retained).toBe(false);
    expect(same.blocks).toEqual(base);
  });

  it('referência a bloco ausente é ignorada', () => {
    const out = retainColumns(base, [{ block: B(1, 0), col: 0 }]);
    expect(out.retained).toBe(false);
    expect(out.blocks).toEqual(base);
  });

  it('não muta a entrada e devolve objetos novos', () => {
    const kept = retainColumns(base, [{ block: PRINCIPAL, col: 5 }]);
    expect(base[0].columns).toEqual({ lo: 2, hi: 4 });
    expect(base[0].rect).toEqual({ x: 32, y: 0, w: 48, h: 29 });
    expect(kept.blocks).not.toBe(base);
    expect(kept.blocks[0]).not.toBe(base[0]);
    expect(kept.blocks[0].columns).not.toBe(base[0].columns);
  });
});

describe('superfície pública depois da remoção do legado (Tarefa 10)', () => {
  const LEGACY = ['slotColumn', 'slotSide', 'cellRect', 'slotRect', 'legacySlotAt', 'columnsFor', 'corridorRect', 'buildingRect'];

  it('geometry.ts não exporta mais as funções da fita; slotAt, rectPx e inRect continuam', () => {
    const names = Object.keys(geometry);
    for (const name of LEGACY) expect(names).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(['slotAt', 'blockColumnRect', 'existingBlocks', 'worldBounds', 'rectPx', 'inRect']));
  });

  it('constants.ts não exporta mais CORE_COLS; as medidas locais do bloco continuam', () => {
    const names = Object.keys(constants);
    expect(names).not.toContain('CORE_COLS');
    expect(names).toEqual(expect.arrayContaining(['COL_W', 'ROOM_H', 'CORRIDOR_H', 'NORTH_Y', 'CORRIDOR_Y', 'SOUTH_Y', 'BUILDING_H', 'TILE']));
  });
});
