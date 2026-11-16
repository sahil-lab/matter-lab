import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@matterlab/contracts': fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url)) } },
  build: {
    ssr: fileURLToPath(new URL('./export-catalog.ts', import.meta.url)),
    target: 'node22',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'export-catalog.mjs' } },
  },
});
