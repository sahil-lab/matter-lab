import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Port 5173 (Vite's default) is deliberately avoided so MATTER LAB never collides with other dev servers.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  preview: { host: '127.0.0.1', port: 4273, strictPort: true },
  worker: { format: 'es' },
  // RDKit's loader is a CommonJS module used only inside a worker; naming it here has it prepared up front.
  optimizeDeps: { include: ['@rdkit/rdkit'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      // `lab-editor.html` is Agent 04's standalone exerciser for apps/web/src/lab/editor/** (see
      // its own doc comment); it is not linked from the production app and ships only because it
      // is useful for the same browser tests/preview build as the main entry.
      input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), labEditor: fileURLToPath(new URL('./lab-editor.html', import.meta.url)) },
    },
  },
});
