import { describe, expect, it } from 'vitest';
import { parseProjectSizes } from './project-city';

describe('parseProjectSizes', () => {
  it('aceita só entradas com raiz; números inválidos viram null', () => {
    expect(parseProjectSizes({ projects: [{ root: 'D:\\app', commits: 12, files: -1 }, { commits: 3 }, null, { root: '/x', commits: '9' }] })).toEqual([
      { root: 'D:\\app', commits: 12, files: null },
      { root: '/x', commits: null, files: null },
    ]);
    expect(parseProjectSizes('erro')).toEqual([]);
  });
});
