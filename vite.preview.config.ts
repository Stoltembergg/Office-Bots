import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./client'),
  publicDir: false,
  build: {
    outDir: r('./dist/preview'),
    emptyOutDir: true,
    rollupOptions: { input: { index: r('./client/preview.html') } },
  },
});
