import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { titrationSolverDevMiddleware } from './src/lab/challenges/integration/titrationSolverDevMiddleware';

// Port 5173 (Vite's default) is deliberately avoided so MATTER LAB never collides with other dev servers.
export default defineConfig({
  plugins: [react(), titrationSolverDevMiddleware()],
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  preview: { host: '127.0.0.1', port: 4273, strictPort: true },
  worker: { format: 'es' },
  // RDKit's loader is a CommonJS module used only inside a worker; naming it here has it prepared up front.
  optimizeDeps: { include: ['@rdkit/rdkit'] },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1600 },
});
