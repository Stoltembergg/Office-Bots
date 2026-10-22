import { describe, expect, it } from 'vitest';
import { colsOf, floorsOf, streetBuildings, streetWidth } from './street';

describe('floorsOf', () => {
  it('cresce com o log dos commits, entre 3 e 16 andares', () => {
    expect(floorsOf(null, 3, 0)).toBe(3);
    expect(floorsOf(10, 3, 0)).toBe(5);
    expect(floorsOf(100, 3, 0)).toBe(10);
    expect(floorsOf(1_000_000, 3, 0)).toBe(16);
  });

  it('sempre cabe uma janela por sessão', () => {
    expect(floorsOf(null, 3, 20)).toBe(7);
  });
});

describe('streetBuildings', () => {
  it('usa o tamanho medido; sem git, os arquivos dão a altura', () => {
    const [app, docs, unknown] = streetBuildings(
      [
        { root: 'D:\\app', name: 'app', district: 'D:', roomIds: ['a'], sessions: ['working'] },
        { root: 'D:\\docs', name: 'docs', district: 'D:', roomIds: ['b'], sessions: [] },
        { root: 'D:\\x', name: 'x', district: 'D:', roomIds: ['c'], sessions: [] },
      ],
      [
        { root: 'd:\\APP', commits: 100, files: 1000 },
        { root: 'D:\\docs', commits: null, files: 10 },
      ],
    );
    expect([app.floors, app.cols, app.windows]).toEqual([10, colsOf(1000), ['working']]);
    expect(docs.floors).toBe(5);
    expect([unknown.floors, unknown.commits]).toEqual([3, null]);
    expect(streetWidth([app, docs, unknown])).toBe(480);
  });
});
