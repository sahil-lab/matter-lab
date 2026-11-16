import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { APPARATUS_DEFINITIONS } from '../../apps/web/src/lab/apparatus/registry.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  cacheDir: '.cache/vite-build',
  resolve: { alias: {
    '@matterlab/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    '@matterlab/lab-science': fileURLToPath(new URL('../lab-science/src/index.ts', import.meta.url)),
  } },
  ssr: { target: 'node', noExternal: ['@matterlab/contracts', '@matterlab/lab-science'] },
  build: {
    target: 'node22', outDir: 'dist', emptyOutDir: true,
    ssr: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
    rolldownOptions: { output: { entryFileNames: 'cli.mjs', chunkFileNames: '[name]-[hash].mjs' } },
  },
  plugins: [{
    name: 'export-authoritative-apparatus-data',
    closeBundle() {
      const directory = join(root, 'dist');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'equipment-definitions.json'), `${JSON.stringify({ schemaVersion: 1, equipment: APPARATUS_DEFINITIONS }, null, 2)}\n`);
    },
  }],
});
