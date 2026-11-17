import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
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
      input: {
        // Agent 02's 3D-environment test harness (see apps/web/src/lab/environment), built alongside
        // the main application so `npm run build` and the e2e preview server can both reach it.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'lab-environment': fileURLToPath(new URL('./lab-environment.html', import.meta.url)),
      },
    },
  },
});
