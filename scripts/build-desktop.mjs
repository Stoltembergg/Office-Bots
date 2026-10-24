import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const dev = process.argv.includes('--dev');
await mkdir('dist/desktop', { recursive: true });

await Promise.all([
  build({
    entryPoints: ['desktop/main.ts'],
    outfile: 'dist/desktop/main.mjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    external: ['electron'],
    sourcemap: true,
    define: { OFFICE_BOTS_DEV: String(dev) },
  }),
  build({
    entryPoints: ['desktop/preload.ts'],
    outfile: 'dist/desktop/preload.cjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['desktop/forge.config.ts'],
    outfile: 'dist/desktop/forge.config.mjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
  }),
]);
