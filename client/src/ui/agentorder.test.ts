import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderAgents } from './agentorder';

const KEY = 'habblaud.tabs.order';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    data,
  };
}

/** Instala o armazenamento falso (o vitest roda em Node, sem `localStorage`). */
const install = (initial: Record<string, string> = {}) => {
  const st = memoryStorage(initial);
  vi.stubGlobal('localStorage', st);
  return st;
};

/** Guarda a ordem de projetos (`roomId` para sessões) como o navegador guardaria. */
const withOrder = (map: Record<string, unknown>) => install({ [KEY]: JSON.stringify(map) });

type Item = { id: string; sid: string };
// Ids diferentes das sessões, para provar qual dos dois cada função usa.
const ITEMS: readonly Item[] = [
  { id: 'a1', sid: 's1' },
  { id: 'a2', sid: 's2' },
  { id: 'a3', sid: 's3' },
  { id: 'a4', sid: 's4' },
];
const idOf = (i: Item) => i.id;
const sessionOf = (i: Item) => i.sid;
const ids = (list: readonly Item[]) => list.map(idOf).join(',');
const ordenar = (items: readonly Item[] = ITEMS, room = 'r') => orderAgents(room, items, sessionOf);

afterEach(() => vi.unstubAllGlobals());

describe('orderAgents', () => {
  it('AGORD-01: sem ordem guardada para o projeto devolve uma cópia na ordem original', () => {
    install();
    const vazio = ordenar();
    expect(ids(vazio)).toBe('a1,a2,a3,a4');
    expect(vazio).not.toBe(ITEMS);

    withOrder({ other: ['s4'] });
    const outro = ordenar();
    expect(ids(outro)).toBe('a1,a2,a3,a4');
    expect(outro).not.toBe(ITEMS);
  });

  it('AGORD-02: ordena pelo índice da sessão na lista guardada', () => {
    withOrder({ r: ['s3', 's1', 's2', 's4'] });
    expect(ids(ordenar())).toBe('a3,a1,a2,a4');
  });

  it('AGORD-03: sessão fora da lista guardada vai depois das que estão, na ordem em que veio', () => {
    withOrder({ r: ['s3'] });
    expect(ids(ordenar())).toBe('a3,a1,a2,a4');

    withOrder({ r: ['s2'] });
    const entrada = [ITEMS[0], ITEMS[2], ITEMS[1], ITEMS[3]];
    expect(ids(ordenar(entrada))).toBe('a2,a1,a3,a4');
  });

  it('AGORD-04: sessão guardada que nenhum item tem é ignorada, sem lacuna', () => {
    withOrder({ r: ['zz', 's2', 'yy', 's1'] });
    expect(ids(ordenar())).toBe('a2,a1,a3,a4');
  });

  it('AGORD-05: itens com a mesma sessão mantêm a ordem em que vieram', () => {
    withOrder({ r: ['s2', 's1'] });
    const itens: Item[] = [
      { id: 'x1', sid: 's1' },
      { id: 'x2', sid: 's1' },
      { id: 'y', sid: 's2' },
    ];
    expect(ids(ordenar(itens))).toBe('y,x1,x2');
  });

  it('AGORD-06: usa só a lista do projeto pedido', () => {
    withOrder({ other: ['s4', 's3'], r: ['s2'] });
    expect(ids(ordenar(ITEMS, 'r'))).toBe('a2,a1,a3,a4');
    expect(ids(ordenar(ITEMS, 'novo'))).toBe('a1,a2,a3,a4');
  });

  it('AGORD-07: lista guardada vazia devolve uma cópia na ordem original', () => {
    withOrder({ r: [] });
    const resultado = ordenar();
    expect(ids(resultado)).toBe('a1,a2,a3,a4');
    expect(resultado).not.toBe(ITEMS);
  });

  it('AGORD-08: deixa o array de entrada intacto, mesmo congelado', () => {
    withOrder({ r: ['s4', 's3', 's2', 's1'] });
    const congelado = Object.freeze([...ITEMS]);
    expect(() => ordenar(congelado)).not.toThrow();
    expect(ids(congelado)).toBe('a1,a2,a3,a4');
  });
});
