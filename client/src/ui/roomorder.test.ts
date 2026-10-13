import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveRoom, orderRooms } from './roomorder';

const KEY = 'habblaud.rooms.order';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    data,
  };
}
const install = (initial: Record<string, string> = {}) => {
  const st = memoryStorage(initial);
  vi.stubGlobal('localStorage', st);
  return st;
};

const SALAS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const idOf = (s: { id: string }) => s.id;
const ids = (list: { id: string }[]) => list.map((s) => s.id).join(',');

afterEach(() => vi.unstubAllGlobals());

describe('orderRooms', () => {
  it('SALORD-01: sem ordem guardada devolve uma cópia na mesma ordem', () => {
    install();
    const out = orderRooms(SALAS, idOf);
    expect(ids(out)).toBe('a,b,c,d');
    expect(out).not.toBe(SALAS);
  });

  it('SALORD-02: com ordem guardada ordena pelo índice do id na lista guardada', () => {
    install({ [KEY]: JSON.stringify(['c', 'a', 'b', 'd']) });
    expect(ids(orderRooms(SALAS, idOf))).toBe('c,a,b,d');
  });

  it('SALORD-03: sala fora da ordem guardada vai depois das que estão, na ordem em que veio', () => {
    install({ [KEY]: JSON.stringify(['c']) });
    expect(ids(orderRooms(SALAS, idOf))).toBe('c,a,b,d');
    vi.unstubAllGlobals();
    install({ [KEY]: JSON.stringify(['b']) });
    const entrada = [{ id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'd' }];
    expect(ids(orderRooms(entrada, idOf))).toBe('b,a,c,d');
  });

  it('SALORD-04: ids guardados que nenhuma sala tem são ignorados, sem lacuna', () => {
    install({ [KEY]: JSON.stringify(['z', 'b', 'y', 'a']) });
    expect(ids(orderRooms(SALAS, idOf))).toBe('b,a,c,d');
  });

  it('SALORD-05: lista guardada vazia devolve uma cópia na ordem original', () => {
    install({ [KEY]: '[]' });
    const out = orderRooms(SALAS, idOf);
    expect(ids(out)).toBe('a,b,c,d');
    expect(out).not.toBe(SALAS);
  });

  it('SALORD-06: deixa o array de entrada intacto, mesmo congelado', () => {
    install({ [KEY]: JSON.stringify(['d', 'c']) });
    const congelado = Object.freeze([...SALAS]);
    expect(() => orderRooms(congelado, idOf)).not.toThrow();
    expect(ids([...congelado])).toBe('a,b,c,d');
  });
});

describe('moveRoom', () => {
  const ORDEM = ['a', 'b', 'c', 'd'];
  const guardado = (st: ReturnType<typeof memoryStorage>) => st.data.get(KEY);

  it('SALORD-07: põe a sala imediatamente antes da alvo e devolve true', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'a', 'c', false)).toBe(true);
    expect(guardado(st)).toBe('["b","a","c","d"]');
  });

  it('SALORD-08: com after põe a sala imediatamente depois da alvo e devolve true', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'a', 'c', true)).toBe(true);
    expect(guardado(st)).toBe('["b","c","a","d"]');
  });

  it('SALORD-09: antes da primeira ou depois da última põe nos extremos', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'd', 'a', false)).toBe(true);
    expect(guardado(st)).toBe('["d","a","b","c"]');
    expect(moveRoom(ORDEM, 'a', 'd', true)).toBe(true);
    expect(guardado(st)).toBe('["b","c","d","a"]');
  });

  it('SALORD-10: grava em habblaud.rooms.order um array JSON com a nova ordem', () => {
    const st = install();
    moveRoom(ORDEM, 'a', 'c', true);
    expect(st.setItem).toHaveBeenCalledTimes(1);
    expect(st.setItem).toHaveBeenCalledWith(KEY, '["b","c","a","d"]');
    expect(Array.isArray(JSON.parse(guardado(st) ?? ''))).toBe(true);
  });

  it('SALORD-11: salas guardadas que não estão em shown vão depois, na ordem em que estavam', () => {
    const st = install({ [KEY]: '["b","c","a","d","x","y"]' });
    expect(moveRoom(['p', 'q', 'r'], 'r', 'p', false)).toBe(true);
    expect(guardado(st)).toBe('["r","p","q","b","c","a","d","x","y"]');
  });

  it('SALORD-12: id guardado que também está em shown é gravado uma só vez', () => {
    const st = install({ [KEY]: '["b","c","a","d"]' });
    expect(moveRoom(ORDEM, 'a', 'c', true)).toBe(true);
    const out = JSON.parse(guardado(st) ?? '') as string[];
    expect(out).toHaveLength(4);
    expect(out).toEqual(['b', 'c', 'a', 'd']);
  });

  it('SALORD-13: orderRooms depois de moveRoom devolve a nova ordem', () => {
    install();
    moveRoom(ORDEM, 'a', 'c', true);
    expect(ids(orderRooms(SALAS, idOf))).toBe('b,c,a,d');
  });

  it('SALORD-14: from igual a to devolve false sem gravar', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'b', 'b', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
  });

  it('SALORD-15: from desconhecida devolve false sem gravar', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'z', 'b', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
  });

  it('SALORD-16: to desconhecida devolve false sem gravar', () => {
    const st = install();
    expect(moveRoom(ORDEM, 'a', 'z', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
  });

  it('SALORD-17: deixa shown intacto, mesmo congelado', () => {
    install();
    const congelado = Object.freeze([...ORDEM]);
    expect(moveRoom(congelado, 'a', 'c', true)).toBe(true);
    expect([...congelado]).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('teto de salas lembradas', () => {
  const fora = (n: number) => Array.from({ length: n }, (_, i) => 'o' + i);
  const lido = (st: ReturnType<typeof memoryStorage>) => JSON.parse(st.data.get(KEY) ?? '[]') as string[];

  it('SALORD-18: com 100 guardadas fora da lista grava 100 e perde as últimas guardadas', () => {
    const st = install({ [KEY]: JSON.stringify(fora(100)) });
    expect(moveRoom(['n1', 'n2'], 'n2', 'n1', false)).toBe(true);
    const out = lido(st);
    expect(out).toHaveLength(100);
    expect(out.slice(0, 4)).toEqual(['n2', 'n1', 'o0', 'o1']);
    expect(out[99]).toBe('o97');
    expect(out).not.toContain('o98');
    expect(out).not.toContain('o99');
  });

  it('SALORD-19: total de 100 grava tudo; total de 101 grava 100 e descarta a última guardada', () => {
    const shown = ['n1', 'n2', 'n3'];
    const st100 = install({ [KEY]: JSON.stringify(fora(97)) });
    expect(moveRoom(shown, 'n3', 'n1', false)).toBe(true);
    const exato = lido(st100);
    expect(exato).toHaveLength(100);
    expect(exato[99]).toBe('o96');

    vi.unstubAllGlobals();
    const st101 = install({ [KEY]: JSON.stringify(fora(98)) });
    expect(moveRoom(shown, 'n3', 'n1', false)).toBe(true);
    const acima = lido(st101);
    expect(acima).toHaveLength(100);
    expect(acima[99]).toBe('o96');
    expect(acima).not.toContain('o97');
  });
});

describe('armazenamento inválido ou indisponível (salas)', () => {
  const quebrado = (quais: { get?: boolean; set?: boolean }) => {
    const st = install();
    if (quais.get) st.getItem.mockImplementation(() => { throw new Error('bloqueado'); });
    if (quais.set) st.setItem.mockImplementation(() => { throw new Error('cota cheia'); });
    return st;
  };

  it('SALORD-20: JSON inválido guardado vira ordem original e moveRoom regrava JSON válido', () => {
    const st = install({ [KEY]: '{oops' });
    expect(ids(orderRooms(SALAS, idOf))).toBe('a,b,c,d');
    expect(moveRoom(['a', 'b', 'c', 'd'], 'a', 'c', true)).toBe(true);
    const gravado = JSON.parse(st.data.get(KEY) ?? '') as unknown;
    expect(gravado).toEqual(['b', 'c', 'a', 'd']);
  });

  it('SALORD-21: JSON válido que não é array é tratado como sem ordem', () => {
    for (const valor of ['null', '5', '"x"', 'true', '{"a":["b"]}']) {
      install({ [KEY]: valor });
      expect(ids(orderRooms(SALAS, idOf)), valor).toBe('a,b,c,d');
      vi.unstubAllGlobals();
    }
  });

  it('SALORD-22: elementos que não são string são descartados e só as strings valem', () => {
    const st = install({ [KEY]: '["c", 1, null, {"x":1}, "a", false]' });
    expect(ids(orderRooms(SALAS, idOf))).toBe('c,a,b,d');
    // o que é regravado também só tem strings
    expect(moveRoom(['p', 'q'], 'q', 'p', false)).toBe(true);
    expect(JSON.parse(st.data.get(KEY) ?? '')).toEqual(['q', 'p', 'c', 'a']);
  });

  it('SALORD-23: getItem que lança não derruba orderRooms nem moveRoom', () => {
    quebrado({ get: true });
    expect(ids(orderRooms(SALAS, idOf))).toBe('a,b,c,d');
    expect(moveRoom(['a', 'b', 'c', 'd'], 'a', 'c', true)).toBe(true);
    vi.unstubAllGlobals();
    quebrado({ get: true, set: true });
    expect(ids(orderRooms(SALAS, idOf))).toBe('a,b,c,d');
    expect(moveRoom(['a', 'b', 'c', 'd'], 'a', 'c', true)).toBe(true);
  });

  it('SALORD-24: setItem que lança não derruba moveRoom e a ordem original segue valendo', () => {
    const st = quebrado({ set: true });
    expect(moveRoom(['a', 'b', 'c', 'd'], 'a', 'c', true)).toBe(true);
    expect(st.setItem).toHaveBeenCalled();
    expect(ids(orderRooms(SALAS, idOf))).toBe('a,b,c,d');
  });

  it('SALORD-25: sem localStorage orderRooms devolve a ordem original e moveRoom devolve true', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(ids(orderRooms(SALAS, idOf))).toBe('a,b,c,d');
    expect(moveRoom(['a', 'b', 'c', 'd'], 'a', 'c', true)).toBe(true);
  });
});
