import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderRooms } from './roomorder';

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
