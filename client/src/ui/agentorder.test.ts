import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveAgent, orderAgents } from './agentorder';

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

describe('moveAgent', () => {
  const mover = (from: string, to: string, after: boolean, room = 'r') => moveAgent(room, ITEMS, idOf, sessionOf, from, to, after);
  const guardado = (st: ReturnType<typeof memoryStorage>) => JSON.parse(st.data.get(KEY)!) as Record<string, string[]>;

  it('AGORD-09: com after falso põe from imediatamente antes de to', () => {
    const st = install();
    expect(mover('a1', 'a3', false)).toBe(true);
    expect(guardado(st).r).toEqual(['s2', 's1', 's3', 's4']);
  });

  it('AGORD-10: com after verdadeiro põe from imediatamente depois de to', () => {
    const st = install();
    expect(mover('a1', 'a3', true)).toBe(true);
    expect(guardado(st).r).toEqual(['s2', 's3', 's1', 's4']);
  });

  it('AGORD-11: antes do primeiro e depois do último vai para as pontas', () => {
    const st = install();
    expect(mover('a4', 'a1', false)).toBe(true);
    expect(guardado(st).r).toEqual(['s4', 's1', 's2', 's3']);

    const st2 = install();
    expect(mover('a1', 'a4', true)).toBe(true);
    expect(guardado(st2).r).toEqual(['s2', 's3', 's4', 's1']);
  });

  it('AGORD-12: grava em habblaud.tabs.order as sessões (não os ids) na nova ordem', () => {
    const st = install();
    expect(mover('a1', 'a2', true)).toBe(true);
    expect(st.data.get(KEY)).toBe('{"r":["s2","s1","s3","s4"]}');
  });

  it('AGORD-13: orderAgents com os mesmos itens devolve a nova ordem', () => {
    install();
    expect(mover('a1', 'a2', true)).toBe(true);
    expect(ids(ordenar())).toBe('a2,a1,a3,a4');
  });

  it('AGORD-14: mantém intactas as listas guardadas dos outros projetos', () => {
    const st = withOrder({ other: ['s9', 's8'] });
    expect(mover('a1', 'a2', true)).toBe(true);
    expect(guardado(st)).toEqual({ other: ['s9', 's8'], r: ['s2', 's1', 's3', 's4'] });
  });

  it('AGORD-15: from desconhecido devolve false sem gravar', () => {
    const st = install();
    expect(mover('zz', 'a2', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
    expect(st.data.size).toBe(0);
  });

  it('AGORD-16: to desconhecido devolve false sem gravar', () => {
    const st = install();
    expect(mover('a1', 'zz', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
    expect(st.data.size).toBe(0);
  });

  it('AGORD-17: from igual a to devolve false sem gravar', () => {
    const st = install();
    expect(mover('a2', 'a2', false)).toBe(false);
    expect(st.setItem).not.toHaveBeenCalled();
    expect(st.data.size).toBe(0);
  });
});

describe('teto de projetos lembrados', () => {
  const mover = (room: string) => moveAgent(room, ITEMS, idOf, sessionOf, 'a1', 'a2', false);
  const projetos = (st: ReturnType<typeof memoryStorage>) => Object.keys(JSON.parse(st.data.get(KEY)!) as object);
  const gravar = (st: ReturnType<typeof memoryStorage>, de: number, ate: number) => {
    for (let n = de; n <= ate; n++) mover(`p${n}`);
    return projetos(st);
  };

  it('AGORD-18: com 60 projetos gravados sobram os 50 mais recentes', () => {
    const st = install();
    const chaves = gravar(st, 0, 59);
    expect(chaves).toHaveLength(50);
    expect(chaves[0]).toBe('p10');
    expect(chaves[chaves.length - 1]).toBe('p59');
    expect(chaves).not.toContain('p9');
  });

  it('AGORD-19: com exatamente 50 projetos nenhum cai; o 51º descarta o primeiro', () => {
    const st = install();
    const cinquenta = gravar(st, 0, 49);
    expect(cinquenta).toHaveLength(50);
    expect(cinquenta).toContain('p0');

    mover('p50');
    const depois = projetos(st);
    expect(depois).toHaveLength(50);
    expect(depois).not.toContain('p0');
    expect(depois).toContain('p1');
  });

  it('AGORD-20: regravar um projeto o torna o mais recente e ele só cai depois dos mais antigos', () => {
    const st = install();
    gravar(st, 0, 49);
    mover('p0');
    mover('p50');
    const chaves = projetos(st);
    expect(chaves).toHaveLength(50);
    expect(chaves).toContain('p0');
    expect(chaves).not.toContain('p1');
  });

  it('AGORD-21: armazenamento que já tem 60 projetos fica com exatamente 50 ao gravar um novo', () => {
    const antigo: Record<string, string[]> = {};
    for (let n = 0; n < 60; n++) antigo[`q${n}`] = ['s1'];
    const st = withOrder(antigo);
    mover('novo');
    const chaves = projetos(st);
    expect(chaves).toHaveLength(50);
    expect(chaves[0]).toBe('q11');
    expect(chaves[chaves.length - 1]).toBe('novo');
  });
});
