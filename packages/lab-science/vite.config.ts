import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: { noExternal: [/^@matterlab\//] },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: {
        cli: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        worker: fileURLToPath(new URL('./src/worker.ts', import.meta.url)),
      },
      output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
    },
  },
});
