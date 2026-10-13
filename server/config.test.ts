import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig: HABBLAUD_PROJECT_ROOTS', () => {
  const cfg = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: '/home/eu', HABBLAUD_IN_DOCKER: '0', ...env }, []);

  it('lista separada por vírgula, com ~ expandido e sem barra final; ausente = sem filtro', () => {
    expect(cfg({}).projectRoots).toEqual([]);
    expect(cfg({ HABBLAUD_PROJECT_ROOTS: ' ~/Claude/empresa-a/ , /srv/b ,' }).projectRoots).toEqual(['/home/eu/Claude/empresa-a', '/srv/b']);
  });
});

describe('loadConfig: dados por escopo', () => {
  const cfg = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: '/home/eu', HABBLAUD_IN_DOCKER: '0', ...env }, []);

  it('com escopo, nomes, timelapse e Meu dia ficam numa pasta só daquele escopo (dados de outro escopo não aparecem)', () => {
    expect(cfg({}).dataDir).toBe('/home/eu/.habblaud');
    const a = cfg({ HABBLAUD_PROJECT_ROOTS: '/srv/a,/srv/b' }).dataDir;
    expect(a).toMatch(/^\/home\/eu\/.habblaud\/escopos\/[0-9a-f]{12}$/);
    // A mesma lista em outra ordem é o mesmo escopo; outra lista, outra pasta.
    expect(cfg({ HABBLAUD_PROJECT_ROOTS: '/srv/b/,/srv/a' }).dataDir).toBe(a);
    expect(cfg({ HABBLAUD_PROJECT_ROOTS: '/srv/a' }).dataDir).not.toBe(a);
    // Uma pasta com quebra de linha no nome não cai no mesmo lugar que duas pastas.
    expect(cfg({ HABBLAUD_PROJECT_ROOTS: '/srv/a\n/srv/b' }).dataDir).not.toBe(a);
  });
});
