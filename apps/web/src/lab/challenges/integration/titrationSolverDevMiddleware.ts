/**
 * Dev-only Vite middleware exposing `/__agent08__/titration-solve`: a thin HTTP wrapper around
 * `agent08_titration_solver_bridge.py` (Agent 06's real titration solver), so the browser-side
 * `httpSolverClient.ts` can reach the same real chemistry `pythonSolverClient.ts` calls directly in
 * Node (vitest, and this file). Node-only (uses `node:child_process`); only ever imported from
 * `vite.config.ts`, never from browser application code, so it is never bundled for the browser.
 *
 * Does not exist in a production build or deployment — Agent 09's real
 * `/api/v1/lab/scenes/{id}/runs` endpoint is the intended replacement there.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { TITRATION_SOLVE_DEV_ROUTE } from './httpSolverClient';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/web/src/lab/challenges/integration -> repo root is six levels up.
const REPO_ROOT = path.resolve(HERE, '../../../../../../');
const SCIENCE_DIR = path.join(REPO_ROOT, 'services', 'science');
const BRIDGE_SCRIPT_PATH = path.join(SCIENCE_DIR, 'agent08_titration_solver_bridge.py');

export function titrationSolverDevMiddleware(): Plugin {
  return {
    name: 'agent08-titration-solver-dev-middleware',
    configureServer(server) {
      server.middlewares.use(TITRATION_SOLVE_DEV_ROUTE, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Only POST is supported.' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const requestBody = Buffer.concat(chunks).toString('utf-8');
          const pythonExecutable = process.env.AGENT08_PYTHON ?? 'python';
          const child = spawn(pythonExecutable, [BRIDGE_SCRIPT_PATH], { cwd: SCIENCE_DIR });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
          child.on('error', (error) => {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          });
          child.on('close', (code) => {
            res.setHeader('Content-Type', 'application/json');
            if (code !== 0 && !stdout) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: stderr || `solver bridge process exited with code ${String(code)}` }));
              return;
            }
            res.statusCode = 200;
            res.end(stdout);
          });
          child.stdin.write(requestBody);
          child.stdin.end();
        });
      });
    },
  };
}
