import { describe, expect, it } from 'vitest';
import { createProjectSizes, type GitRunner } from './sizes';

describe('createProjectSizes', () => {
  it('conta commits e arquivos, e devolve null fora do git', async () => {
    const git: GitRunner = async (cwd, args) => (cwd === '/sem-git' ? null : args[0] === 'rev-list' ? '42\n' : 'a.ts\0b.ts\0');
    const sizes = await createProjectSizes(git)(['/app', '/sem-git']);
    expect(sizes).toEqual([
      { root: '/app', commits: 42, files: 2 },
      { root: '/sem-git', commits: null, files: null },
    ]);
  });

  it('guarda o resultado por 10 minutos', async () => {
    let calls = 0;
    let t = 0;
    const sizes = createProjectSizes(async () => (calls++, '1'), () => t);
    await sizes(['/app']);
    await sizes(['/app']);
    expect(calls).toBe(2);
    t = 11 * 60_000;
    await sizes(['/app']);
    expect(calls).toBe(4);
  });
});
