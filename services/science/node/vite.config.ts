import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL('./validate.ts', import.meta.url)),
    target: 'node22',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'validate.mjs' } },
  },
});
