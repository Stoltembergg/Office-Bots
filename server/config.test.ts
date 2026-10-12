import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig: HABBLAUD_PROJECT_ROOTS', () => {
  const cfg = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: '/home/eu', HABBLAUD_IN_DOCKER: '0', ...env }, []);

  it('lista separada por vírgula, com ~ expandido e sem barra final; ausente = sem filtro', () => {
    expect(cfg({}).projectRoots).toEqual([]);
    expect(cfg({ HABBLAUD_PROJECT_ROOTS: ' ~/Claude/empresa-a/ , /srv/b ,' }).projectRoots).toEqual(['/home/eu/Claude/empresa-a', '/srv/b']);
  });
});
