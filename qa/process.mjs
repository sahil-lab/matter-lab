import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const { captureOutput = false, checkVitestDiagnostics = false, ...spawnOptions } = options;
    let stdout = '';
    let stderr = '';
    let diagnosticTail = '';
    let diagnosticFailure = false;
    const pipeOutput = captureOutput || checkVitestDiagnostics;
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: pipeOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      ...spawnOptions,
    });
    const inspectDiagnostics = (chunk) => {
      if (!checkVitestDiagnostics) return;
      const text = `${diagnosticTail}${chunk}`;
      diagnosticFailure ||= /\[vitest-pool\].*(?:timeout|error)|Unhandled (?:Error|Rejection)/i.test(text);
      diagnosticTail = text.slice(-2048);
    };
    if (pipeOutput) {
      child.stdout?.on('data', (chunk) => {
        if (captureOutput) stdout += chunk;
        inspectDiagnostics(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        if (captureOutput) stderr += chunk;
        inspectDiagnostics(chunk);
        process.stderr.write(chunk);
      });
    }
    child.once('error', (error) => resolve({ code: 1, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolve({
      code: diagnosticFailure ? 1 : code ?? 1,
      signal,
      ...(checkVitestDiagnostics ? { reportedCode: code, diagnosticFailure } : {}),
      ...(captureOutput ? { stdout, stderr } : {}),
    }));
  });
}

export async function runSequential(phases, execute = runProcess) {
  const results = [];
  for (const phase of phases) {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const outcome = await execute(phase.command, phase.args, phase.options);
    results.push({
      name: phase.name,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - start,
      ...outcome,
    });
    if (outcome.error) console.error(`${phase.name}: ${outcome.error}`);
  }
  return { code: results.every((result) => result.code === 0 && !result.signal) ? 0 : 1, results };
}
