import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Collects the numbers a validation test measured (deviations from references, timings, ...) so
 * they can be quoted in the README instead of being retyped.
 *
 * Nothing is written during a normal test run. With the environment variable QUANTUM_REPORT=1 each
 * test file writes packages/quantum/reports/<name>.json, a plain record of what it measured:
 *
 *   $env:QUANTUM_REPORT = '1'; vitest run --project quantum
 */
export function validationReporter(name: string): (key: string, data: unknown) => void {
  const records: Record<string, unknown> = {};
  const enabled = process.env.QUANTUM_REPORT === '1';
  const directory = fileURLToPath(new URL('../../reports/', import.meta.url));
  return (key, data) => {
    records[key] = data;
    if (!enabled) return;
    mkdirSync(directory, { recursive: true });
    const body = { report: name, generated: new Date().toISOString(), node: process.version, records };
    writeFileSync(`${directory}${name}.json`, `${JSON.stringify(body, null, 2)}\n`);
  };
}
