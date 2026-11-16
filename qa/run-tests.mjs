import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { root, runSequential } from './process.mjs';

const mode = process.argv[2] ?? 'all';
if (!['all', 'unit', 'performance'].includes(mode)) {
  throw new Error('Usage: node qa/run-tests.mjs all|unit|performance [Vitest selectors]');
}
const extra = process.argv.slice(3);
const resultsDirectory = join(root, 'qa', 'results');
await mkdir(resultsDirectory, { recursive: true });
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');

const phases = [
  {
    name: 'unit',
    command: process.execPath,
    args: [
      vitest, 'run', '--exclude', '**/performance.test.ts', '--maxWorkers=2',
      '--reporter=default', '--reporter=json',
      `--outputFile.json=${join(resultsDirectory, 'unit-tests.json')}`, ...extra,
    ],
    options: { checkVitestDiagnostics: true },
  },
  {
    name: 'performance',
    command: process.execPath,
    args: [
      vitest, 'run', 'performance.test.ts', '--maxWorkers=1', '--no-file-parallelism',
      '--reporter=default', '--reporter=json',
      `--outputFile.json=${join(resultsDirectory, 'performance-tests.json')}`, ...extra,
    ],
    options: {
      checkVitestDiagnostics: true,
      env: {
        ...process.env,
        QUANTUM_REPORT: '1',
        QUANTUM_REPORT_DIR: join(resultsDirectory, 'performance', 'quantum'),
        UFF_WRITE_REPORT: '1',
        UFF_REPORT_DIR: join(resultsDirectory, 'performance', 'forcefield'),
      },
    },
  },
].filter((phase) => mode === 'all' || phase.name === mode);

console.log('Correctness and absolute CPU performance assertions run in separate phases; no automatic retries.');
if (mode === 'unit') console.log('CPU PERFORMANCE NOT RUN by this command. Required separately: npm run test:performance (or npm test for both).');
if (mode !== 'unit') console.log('CPU performance: one worker, one file at a time. Use an otherwise idle machine; this is NOT a GPU benchmark.');
if (extra.length) console.log(`Explicit diagnostic selectors: ${JSON.stringify(extra)}; this is not an unfiltered acceptance run.`);

const metadata = {
  schemaVersion: 1,
  mode,
  selectors: extra,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  osRelease: release(),
  architecture: process.arch,
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalProcessors: cpus().length,
  memoryBytes: totalmem(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirtyWorktree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
};
const reportPath = join(resultsDirectory, `${mode}-run.json`);
await writeFile(reportPath, `${JSON.stringify({ ...metadata, status: 'RUNNING' }, null, 2)}\n`);
const outcome = await runSequential(phases);
await writeFile(reportPath, `${JSON.stringify({
  ...metadata,
  completedAt: new Date().toISOString(),
  status: outcome.code === 0 ? 'PASSED' : 'FAILED',
  phases: outcome.results,
}, null, 2)}\n`);
for (const result of outcome.results) console.log(`${result.name}: ${result.code === 0 && !result.signal ? 'PASSED' : 'FAILED'} (exit ${result.code}${result.signal ? `, ${result.signal}` : ''})`);
console.log(`Verification record: ${reportPath}`);
process.exitCode = outcome.code;
