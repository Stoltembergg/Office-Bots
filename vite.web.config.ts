import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./client'),
  resolve: { alias: [{ find: /^\.\/locales\/all$/, replacement: r('./shared/locales/none.ts') }] },
  publicDir: false,
  build: {
    outDir: r('./dist/office'),
    emptyOutDir: true,
    rollupOptions: { input: { office: r('./client/office.html') } },
  },
});
