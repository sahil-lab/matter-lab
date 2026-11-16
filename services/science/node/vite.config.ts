import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: {
    '@matterlab/contracts/lab': fileURLToPath(new URL('../../../packages/contracts/lab/index.ts', import.meta.url)),
    '@matterlab/contracts': fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url)),
  } },
  build: {
    ssr: fileURLToPath(new URL('./validate.ts', import.meta.url)),
    target: 'node22',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'validate.mjs' } },
  },
});
