// Modelo de blocos (spec seção 1): envelopes, ordem dos blocos, vagas por bloco, colunas de pé, blocos
// existentes e a trava por coluna. Os números são os das tabelas do plano (00-header, "Regras numéricas").
import { describe, expect, it } from 'vitest';
import { BUILDING_H, COL_W, ROOM_H, SOUTH_Y } from '../constants';
import * as constants from '../constants';
import * as geometry from './geometry';
import {
  ANNEX_COLS,
  BRIDGE_W,
  MAIN_COLS,
  PRINCIPAL,
  ROOMS_PER_BLOCK,
  ROW_STEP,
  SLOT_ORDER,
  STREET_W,
  arrivalOf,
  blockAt,
  blockColumnRect,
  blockCols,
  blockFor,
  blockIndex,
  blockKey,
  blockOrder,
  blockRect,
  bridgeId,
  bridgeOpenings,
  bridgeRects,
  bridgesFor,
  columnAt,
  coreColumns,
  existingBlocks,
  hubDoor,
  hubSide,
  isColumnRef,
  isCoreColumn,
  isPrincipal,
  occupiedColumns,
  occupiedRegions,
  parentOf,
  regionAt,
  regionKey,
  retainColumns,
  retainRegions,
  slotAddress,
  slotAt,
  standingColumns,
  standingKey,
  standingRect,
  worldBounds,
  type BlockId,
  type Side,
} from './geometry';

const B = (bx: number, by: number): BlockId => ({ bx, by });

describe('constantes do modelo', () => {
  it('8 vagas por bloco, envelopes de 6 e 5 colunas, rua de 12, passo de fileira 41', () => {
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

describe('vagas: slotAddress / slotAt / blockFor (spec 1.2; fase 3: sem transitório)', () => {
  const table: [number, BlockId, number, Side][] = [
    [0, PRINCIPAL, 4, 'north'],
    [1, PRINCIPAL, 1, 'north'],
    [7, PRINCIPAL, 0, 'south'],
    [8, B(0, 1), 3, 'north'],
    [9, B(0, 1), 1, 'north'],
    [10, B(0, 1), 3, 'south'],
    [11, B(0, 1), 1, 'south'],
    [12, B(0, 1), 4, 'north'],
    [13, B(0, 1), 0, 'north'],
    [14, B(0, 1), 4, 'south'],
    [15, B(0, 1), 0, 'south'],
    [16, B(1, 0), 0, 'north'],
    [17, B(1, 0), 0, 'south'],
    [24, B(1, 1), 3, 'north'],
    [32, B(-1, 0), 4, 'north'],
    [40, B(-1, 1), 3, 'north'],
    [48, B(0, -1), 3, 'north'],
    [56, B(1, -1), 0, 'north'],
    [120, B(3, 0), 0, 'north'],
  ];
  it.each(table)('vaga %i → bloco %j, coluna %i, %s; slotAt devolve a vaga', (slot, block, col, side) => {
    expect(slotAddress(slot)).toEqual({ block, col, side });
    expect(blockFor(slot)).toEqual(block);
    expect(slotAt(block, col, side)).toBe(slot);
  });

  it('slotAt lança para coluna fora do envelope (não há mais colunas extras)', () => {
    expect(() => slotAt(PRINCIPAL, 6, 'north')).toThrow(Error);
  });

  it('SLOT_ORDER tem as quatro ordens da spec 1.2', () => {
    expect(SLOT_ORDER.core).toEqual([[4, 'north'], [1, 'north'], [4, 'south'], [1, 'south'], [5, 'north'], [0, 'north'], [5, 'south'], [0, 'south']]);
    expect(SLOT_ORDER.hub).toEqual([[3, 'north'], [1, 'north'], [3, 'south'], [1, 'south'], [4, 'north'], [0, 'north'], [4, 'south'], [0, 'south']]);
    expect(SLOT_ORDER.west).toEqual([[0, 'north'], [0, 'south'], [1, 'north'], [1, 'south'], [3, 'north'], [3, 'south'], [4, 'north'], [4, 'south']]);
    expect(SLOT_ORDER.east).toEqual([[4, 'north'], [4, 'south'], [3, 'north'], [3, 'south'], [1, 'north'], [1, 'south'], [0, 'north'], [0, 'south']]);
  });

  const blocks: [string, number, BlockId][] = [
    ['principal (core)', 0, PRINCIPAL],
    ['A1 (0,1), hub', 1, B(0, 1)],
    ['A2 (1,0), west', 2, B(1, 0)],
    ['A4 (−1,0), east', 4, B(-1, 0)],
  ];
  it.each(blocks)('ida e volta das 8 vagas do bloco %s', (_name, n, block) => {
    const order = SLOT_ORDER[arrivalOf(block)];
    for (let i = 0; i < 8; i++) {
      const slot = 8 * n + i;
      const [col, side] = order[i];
      expect(slotAddress(slot)).toEqual({ block, col, side });
      expect(slotAt(block, col, side)).toBe(slot);
    }
  });

  it('Review Focus 3: slotAt lança Error para coluna de miolo (2 e 3 no principal, 2 no anexo)', () => {
    expect(() => slotAt(PRINCIPAL, 2, 'north')).toThrow(Error);
    expect(() => slotAt(PRINCIPAL, 3, 'south')).toThrow(Error);
    expect(() => slotAt(B(0, 1), 2, 'north')).toThrow(Error);
    expect(() => slotAt(B(1, 0), 2, 'south')).toThrow(Error);
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
    [[8], 2, 3],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 5],
    [[0, 1, 2, 3, 4, 5, 6, 7, 16], 0, 5],
    [[16], 2, 3],
    [[5], 0, 3],
  ];
  it.each(principal)('principal: vagas %j → {lo %i, hi %i} (vagas de outros blocos não contam)', (slots, lo, hi) => {
    expect(standingColumns(PRINCIPAL, slots)).toEqual({ lo, hi });
  });

  it('Review Focus 1 (fase 3): a vaga 16 é de A2; o principal só ganha a coluna 5 pelo filho lateral: [0,1,2,3,16] + filho (1,0) → {1, 5}', () => {
    expect(standingColumns(PRINCIPAL, [0, 1, 2, 3, 16])).toEqual({ lo: 1, hi: 4 });
    expect(standingColumns(PRINCIPAL, [0, 1, 2, 3, 16], [B(1, 0)])).toEqual({ lo: 1, hi: 5 });
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
    expect(standingColumns(B(1, 0), [])).toEqual({ lo: 0, hi: 2 });
    expect(standingColumns(B(-1, 0), [])).toEqual({ lo: 2, hi: 4 });
    expect(standingColumns(B(0, 1), [8])).toEqual({ lo: 2, hi: 3 });
  });

  it('vagas de outros blocos não contam', () => {
    expect(standingColumns(B(1, 0), [0, 1, 8])).toEqual({ lo: 0, hi: 2 });
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

  it('vaga 16 mantém o filho (1,0) e o pai (0,0), que ganha a coluna 5', () => {
    const blocks = existingBlocks([16]);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(1, 0)]);
    expect(blocks[0].columns).toEqual({ lo: 2, hi: 5 });
    expect(blocks[0].rect).toEqual({ x: 32, y: 0, w: 64, h: 29 });
    expect(blocks[1].envelope).toEqual({ x: 108, y: 0, w: 80, h: 29 });
    expect(blocks[1].columns).toEqual({ lo: 0, hi: 2 });
    expect(blocks[1].rect).toEqual({ x: 108, y: 0, w: 48, h: 29 });
  });

  it('ancestrais entram em cadeia e a lista sai ordenada por blockIndex', () => {
    // A9 (2,0) → A2 (1,0) → principal; A1 (0,1) → principal.
    const blocks = existingBlocks([72, 8]);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1), B(1, 0), B(2, 0)]);
    // A2 fica de pé da ponta oeste (pai) à ponta leste (filho A9).
    expect(blocks[2].columns).toEqual({ lo: 0, hi: 4 });
  });

  it('a vaga 8 cria o anexo 1 com o miolo e a coluna 3; o principal fica só com o miolo (ganha nada do filho hub além dele)', () => {
    const blocks = existingBlocks([8]);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1)]);
    expect(blocks[0].columns).toEqual({ lo: 2, hi: 3 });
    expect(blocks[0].rect).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(blocks[1].envelope).toEqual({ x: 8, y: 41, w: 80, h: 29 });
    expect(blocks[1].columns).toEqual({ lo: 2, hi: 3 });
    expect(blocks[1].rect).toEqual({ x: 40, y: 41, w: 32, h: 29 });
  });

  it('oito salas no principal e a nona no anexo', () => {
    const blocks = existingBlocks([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(blocks[0].columns).toEqual({ lo: 0, hi: 5 });
    expect(blocks[0].rect).toEqual({ x: 0, y: 0, w: 96, h: 29 });
    expect(blocks[1].columns).toEqual({ lo: 2, hi: 3 });
  });

  it('17 salas: anexo 1 cheio e A2 (1,0) com a coluna 0; o principal ganha a coluna 5 pelo filho lateral', () => {
    const blocks = existingBlocks(Array.from({ length: 17 }, (_, i) => i));
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1), B(1, 0)]);
    expect(blocks[0].columns).toEqual({ lo: 0, hi: 5 });
    expect(blocks[1].columns).toEqual({ lo: 0, hi: 4 });
    expect(blocks[2].columns).toEqual({ lo: 0, hi: 2 });
    expect(blocks[2].rect).toEqual({ x: 108, y: 0, w: 48, h: 29 });
  });

  it('keep: um bloco sem vaga entra (com os ancestrais) só com o miolo — Review Focus 2', () => {
    const blocks = existingBlocks([], [B(0, 1)]);
    expect(blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1)]);
    expect(blocks[1].columns).toEqual({ lo: 2, hi: 2 });
    expect(blocks[1].rect).toEqual({ x: 40, y: 41, w: 16, h: 29 });
    expect(blocks[0].columns).toEqual({ lo: 2, hi: 3 });
    // keep não repete um bloco que já veio das vagas
    expect(existingBlocks([8], [B(0, 1)])).toEqual(existingBlocks([8]));
  });

  it('standingKey: bloco e colunas de pé, na ordem dos blocos', () => {
    expect(standingKey(existingBlocks([]))).toBe('0,0:2-3');
    expect(standingKey(existingBlocks([8]))).toBe('0,0:2-3;0,1:2-3');
    expect(standingKey(existingBlocks([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe('0,0:0-5;0,1:2-3');
  });
});

describe('passarela do anexo 1 (spec 3.6): Z sobre a rua, do lounge ao saguão', () => {
  it('três trechos de 3 tiles de largura: desce do lounge (x 55..58), corre para oeste (y 33..36) e entra no saguão (x 47..50)', () => {
    expect(BRIDGE_W).toBe(3);
    expect(bridgeRects(B(0, 1))).toEqual([
      { x: 55, y: 29, w: 3, h: 4 },
      { x: 47, y: 33, w: 11, h: 3 },
      { x: 47, y: 36, w: 3, h: 5 },
    ]);
  });

  it('encosta na porta sul do lounge (linha 28) e na porta norte do saguão (linhas 41 e 42)', () => {
    expect(bridgeOpenings(B(0, 1))).toEqual([
      { x: 55, y: 28, w: 3, h: 1 },
      { x: 47, y: 41, w: 3, h: 2 },
    ]);
  });

  it('id pela chave do bloco filho; o principal não tem passarela e lança', () => {
    expect(bridgeId(B(0, 1))).toBe('passarela:0,1');
    expect(() => bridgeRects(PRINCIPAL)).toThrow(/principal/);
  });

  it('bridgesFor: uma por anexo existente, nenhuma só com o principal', () => {
    expect(bridgesFor(existingBlocks([0]))).toEqual([]);
    const bridges = bridgesFor(existingBlocks([8]));
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toEqual({
      id: 'passarela:0,1',
      child: B(0, 1),
      parent: PRINCIPAL,
      rects: bridgeRects(B(0, 1)),
      openings: bridgeOpenings(B(0, 1)),
    });
  });
});

describe('passarelas de todos os tipos (D2)', () => {
  it('Z da copa → A6 (0,−1): espelho do Z do lounge; aberturas na porta norte da copa e na saída sul do saguão de A6', () => {
    expect(bridgeRects(B(0, -1))).toEqual([
      { x: 55, y: -4, w: 3, h: 4 },
      { x: 47, y: -7, w: 11, h: 3 },
      { x: 47, y: -12, w: 3, h: 5 },
    ]);
    expect(bridgeOpenings(B(0, -1))).toEqual([
      { x: 55, y: 0, w: 3, h: 2 },
      { x: 47, y: -13, w: 3, h: 1 },
    ]);
  });

  it('vertical reta A3 (1,1): da saída sul do saguão de A2 à porta norte do saguão de A3', () => {
    expect(bridgeRects(B(1, 1))).toEqual([{ x: 147, y: 29, w: 3, h: 12 }]);
    expect(bridgeOpenings(B(1, 1))).toEqual([
      { x: 147, y: 28, w: 3, h: 1 },
      { x: 147, y: 41, w: 3, h: 2 },
    ]);
  });

  it('horizontal A2 (1,0): 12 tiles na altura do corredor, aberturas de 1 tile dentro dos dois corredores', () => {
    expect(bridgeRects(B(1, 0))).toEqual([{ x: 96, y: 13, w: 12, h: 3 }]);
    expect(bridgeOpenings(B(1, 0))).toEqual([
      { x: 95, y: 13, w: 1, h: 3 },
      { x: 108, y: 13, w: 1, h: 3 },
    ]);
  });

  it('horizontal A4 (−1,0) a oeste, A7 (1,−1) saindo de A6 (20 tiles, recuo do anexo central) e A9 (2,0)', () => {
    expect(bridgeRects(B(-1, 0))).toEqual([{ x: -12, y: 13, w: 12, h: 3 }]);
    expect(bridgeOpenings(B(-1, 0))).toEqual([
      { x: 0, y: 13, w: 1, h: 3 },
      { x: -13, y: 13, w: 1, h: 3 },
    ]);
    expect(bridgeRects(B(1, -1))).toEqual([{ x: 88, y: -28, w: 20, h: 3 }]);
    expect(bridgeRects(B(2, 0))).toEqual([{ x: 188, y: 13, w: 12, h: 3 }]);
  });

  it('bridgesFor com A2 e A3: duas passarelas, pais certos', () => {
    const blocks = existingBlocks([16, 24]);
    expect(bridgesFor(blocks).map((b) => [b.id, blockKey(b.parent)])).toEqual([
      ['passarela:1,0', '0,0'],
      ['passarela:1,1', '1,0'],
    ]);
  });
});

describe('lado e porta do saguão (D1)', () => {
  it('hubSide: norte em (0,1) e (bx,1); sul em (0,−1) e nos laterais', () => {
    expect(hubSide(B(0, 1))).toBe('north');
    expect(hubSide(B(1, 1))).toBe('north');
    expect(hubSide(B(0, -1))).toBe('south');
    expect(hubSide(B(1, 0))).toBe('south');
    expect(hubSide(B(-1, -1))).toBe('south');
  });

  it('hubDoor: pela passarela própria (hub) ou pela do filho (bx,1); laterais sem filho e fileira −1 lateral: null', () => {
    expect(hubDoor(B(1, 0), bridgesFor(existingBlocks([16])))).toBeNull();
    const b24 = bridgesFor(existingBlocks([24]));
    expect(hubDoor(B(1, 0), b24)).toBe('south');
    expect(hubDoor(B(1, 1), b24)).toBe('north');
    expect(hubDoor(B(0, 1), bridgesFor(existingBlocks([8])))).toBe('north');
    expect(hubDoor(B(0, -1), bridgesFor(existingBlocks([48])))).toBe('south');
    expect(hubDoor(B(1, -1), bridgesFor(existingBlocks([56])))).toBeNull();
  });
});

describe('regiões: bloco de pé ou passarela (spec 5)', () => {
  const blocks = existingBlocks([8]);
  const bridges = bridgesFor(blocks);

  it('blockAt usa o retângulo de pé, não o envelope', () => {
    expect(blockAt(blocks, 40, 5)?.id).toEqual(PRINCIPAL);
    expect(blockAt(blocks, 60, 45)?.id).toEqual(B(0, 1));
    expect(blockAt(blocks, 20, 5)).toBeNull(); // dentro do envelope do principal (x 0..96), fora das colunas de pé 2–3
    expect(blockAt(blocks, 56, 31)).toBeNull(); // rua
  });

  it('regionAt: bloco, passarela ou nada (rua, jardim, fora de tudo)', () => {
    expect(regionAt(blocks, bridges, 60, 45)).toEqual({ kind: 'block', block: blocks[1] });
    expect(regionAt(blocks, bridges, 56, 31)).toEqual({ kind: 'bridge', bridge: bridges[0] });
    expect(regionAt(blocks, bridges, 48, 38)).toEqual({ kind: 'bridge', bridge: bridges[0] });
    expect(regionAt(blocks, bridges, 40, 35)).toBeNull();
    expect(regionAt(blocks, bridges, 100, 5)).toBeNull();
  });

  it('regionKey distingue bloco de passarela', () => {
    expect(regionKey({ kind: 'block', block: blocks[0] })).toBe('bloco:0,0');
    expect(regionKey({ kind: 'block', block: blocks[1] })).toBe('bloco:0,1');
    expect(regionKey({ kind: 'bridge', bridge: bridges[0] })).toBe('passarela:0,1');
  });
});

describe('worldBounds', () => {
  it('sem blocos: o principal recortado às colunas 2–3', () => {
    expect(worldBounds([])).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(worldBounds([])).toEqual(existingBlocks([])[0].rect);
  });

  it('união dos retângulos de pé (anexo a oeste com x negativo)', () => {
    const blocks = existingBlocks([32]); // A4 (−1,0)
    expect(blocks[0].rect).toEqual({ x: 0, y: 0, w: 64, h: 29 });
    expect(blocks[1].rect).toEqual({ x: -60, y: 0, w: 48, h: 29 });
    expect(worldBounds(blocks)).toEqual({ x: -60, y: 0, w: 124, h: 29 });
  });

  it('união com bloco na fileira norte (A6 em y negativo)', () => {
    const blocks = existingBlocks([48]); // A6 (0,−1): vaga 48 → coluna 3 norte; o principal fica só com o miolo
    expect(blocks[0].rect).toEqual({ x: 32, y: 0, w: 32, h: 29 });
    expect(blocks[1].rect).toEqual({ x: 40, y: -41, w: 32, h: 29 });
    expect(worldBounds(blocks)).toEqual({ x: 32, y: -41, w: 40, h: 70 });
  });

  it('principal com A2: a vaga 16 abre o anexo a leste (x 108..156) e a rua entre eles entra na união', () => {
    expect(worldBounds(existingBlocks([0, 1, 2, 3, 16]))).toEqual({ x: 16, y: 0, w: 140, h: 29 });
  });

  it('com passarelas: união dos retângulos de pé e dos trechos (a passarela não alarga, mas une as fileiras)', () => {
    const blocks = existingBlocks([8]);
    expect(worldBounds(blocks)).toEqual({ x: 32, y: 0, w: 40, h: 70 });
    expect(worldBounds(blocks, bridgesFor(blocks))).toEqual({ x: 32, y: 0, w: 40, h: 70 });
    const all = existingBlocks([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(worldBounds(all, bridgesFor(all))).toEqual({ x: 0, y: 0, w: 96, h: 70 });
    // uma passarela que saísse do retângulo de pé entraria na união
    const wide = [{ ...bridgesFor(blocks)[0], rects: [{ x: 20, y: 29, w: 3, h: 12 }] }];
    expect(worldBounds(blocks, wide)).toEqual({ x: 20, y: 0, w: 52, h: 70 });
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

describe('trava por regiões (spec 7.2): colunas, blocos e passarelas', () => {
  const blocks = existingBlocks([8]); // principal {2,3} e anexo 1 {2,3}
  const bridges = bridgesFor(blocks);

  it('occupiedRegions: colunas por bloco mais uma referência por passarela com alguém', () => {
    const refs = occupiedRegions(blocks, bridges, [
      { tx: 40, ty: 5 }, // principal, coluna 2
      { tx: 60, ty: 45 }, // anexo, coluna 3
      { tx: 56, ty: 31 }, // passarela (trecho 1)
      { tx: 48, ty: 38 }, // passarela (trecho 3): a mesma referência, uma vez só
      { tx: 40, ty: 35 }, // rua: nada
    ]);
    expect(refs).toEqual([
      { block: PRINCIPAL, col: 2 },
      { block: B(0, 1), col: 3 },
      { block: B(0, 1), bridge: 'passarela:0,1' },
    ]);
    expect(refs.map(isColumnRef)).toEqual([true, true, false]);
    expect(occupiedRegions(blocks, bridges, [])).toEqual([]);
  });

  it('sem referências: igual a existingBlocks, retained false', () => {
    const out = retainRegions([8], []);
    expect(out.blocks).toEqual(existingBlocks([8]));
    expect(out.retained).toBe(false);
  });

  it('coluna: estende lo/hi do bloco (como retainColumns) e marca retained', () => {
    const out = retainRegions([0], [{ block: PRINCIPAL, col: 1 }]);
    expect(out.blocks.map((b) => b.id)).toEqual([PRINCIPAL]);
    expect(out.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    expect(out.retained).toBe(true);
  });

  it('Review Focus 2: bloco retido só pela trava (sem sala) fica com o miolo, o pai mantém o miolo e retained é true', () => {
    const out = retainRegions([], [{ block: B(0, 1), col: 3 }]);
    expect(out.blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1)]);
    expect(out.blocks[0].columns).toEqual({ lo: 2, hi: 3 });
    expect(out.blocks[1].columns).toEqual({ lo: 2, hi: 3 });
    expect(out.blocks[1].rect).toEqual({ x: 40, y: 41, w: 32, h: 29 });
    expect(out.retained).toBe(true);
  });

  it('Review Focus 1: alguém na passarela mantém o anexo (só o miolo) e o principal, mesmo sem nenhuma sala', () => {
    const out = retainRegions([0], [{ block: B(0, 1), bridge: 'passarela:0,1' }]);
    expect(out.blocks.map((b) => b.id)).toEqual([PRINCIPAL, B(0, 1)]);
    expect(out.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
    expect(out.blocks[1].columns).toEqual({ lo: 2, hi: 2 });
    expect(out.blocks[1].rect).toEqual({ x: 40, y: 41, w: 16, h: 29 });
    expect(out.retained).toBe(true);
    // a passarela desse layout existe de novo (bridgesFor é por bloco existente)
    expect(bridgesFor(out.blocks).map((b) => b.id)).toEqual(['passarela:0,1']);
  });

  it('referência a bloco que já existe pelas vagas não muda nada', () => {
    const out = retainRegions([8], [{ block: B(0, 1), bridge: 'passarela:0,1' }]);
    expect(out.blocks).toEqual(existingBlocks([8]));
    expect(out.retained).toBe(false);
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

describe('pendências da fase 1', () => {
  it('occupiedColumns: quem está na borda conta para as duas colunas (margem de 1 tile, como a trava antiga)', () => {
    const blocks = geometry.existingBlocks([0, 1, 2, 3]); // colunas 1..4
    // tile 47 é o último da coluna 2 (x 32..47); a margem alcança a coluna 3
    expect(geometry.occupiedColumns(blocks, [{ tx: 47, ty: 14 }]).map((r) => r.col).sort()).toEqual([2, 3]);
    expect(geometry.occupiedColumns(blocks, [{ tx: 40, ty: 14 }]).map((r) => r.col)).toEqual([2]);
  });
  it('slotAddress trata vaga negativa como 0', () => {
    expect(geometry.slotAddress(-3)).toEqual(geometry.slotAddress(0));
  });
});
