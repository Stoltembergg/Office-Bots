// Tamanho de cada projeto para a cidade dos projetos (GET /api/projects): commits (git rev-list --count HEAD) e
// arquivos (git ls-files). Sem shell (execFile), com prazo e cache: medir de novo só a cada CACHE_MS. Fora de um
// repositório git (ou no Docker, sem acesso à pasta), o número fica null e o prédio usa o tamanho mínimo.
import { execFile } from 'node:child_process';
import type { ProjectSize } from '../../shared/projects';

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) =>
      resolve(err ? null : out),
    );
  });

export function createProjectSizes(git: GitRunner = runGit, now: () => number = Date.now): (roots: string[]) => Promise<ProjectSize[]> {
  const cache = new Map<string, { at: number; size: Promise<ProjectSize> }>();
  const measure = async (root: string): Promise<ProjectSize> => {
    const [count, files] = await Promise.all([git(root, ['rev-list', '--count', 'HEAD']), git(root, ['ls-files', '-z'])]);
    const commits = count === null ? NaN : Number.parseInt(count.trim(), 10);
    return {
      root,
      commits: Number.isFinite(commits) ? commits : null,
      files: files === null ? null : files.split('\0').filter(Boolean).length,
    };
  };
  return (roots) =>
    Promise.all(
      roots.map((root) => {
        const hit = cache.get(root);
        if (hit && now() - hit.at < CACHE_MS) return hit.size;
        const size = measure(root);
        cache.set(root, { at: now(), size });
        return size;
      }),
    );
}
