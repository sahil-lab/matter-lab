import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectBuild } from './check-build.mjs';
import { verifyPartition } from './check-test-partition.mjs';
import { root, runProcess, runSequential } from './process.mjs';

test('a failed correctness phase does not hide the performance phase or turn the command green', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const outcome = await runSequential([
    { name: 'unit', command: 'unit', args: [] },
    { name: 'performance', command: 'performance', args: [] },
  ], async (command) => {
    calls.push(command);
    maximumActive = Math.max(maximumActive, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { code: command === 'unit' ? 7 : 0, signal: null };
  });
  assert.deepEqual(calls, ['unit', 'performance']);
  assert.equal(maximumActive, 1);
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.results.map((result) => result.code), [7, 0]);
});

test('child failure and launch failure remain nonzero outcomes', async () => {
  const exited = await runProcess(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.equal(exited.code, 7);
  const missing = await runProcess(join(root, 'qa', 'nonexistent-executable'), [], { stdio: 'ignore' });
  assert.equal(missing.code, 1);
  assert.match(missing.error, /ENOENT/);
});

test('a Vitest worker timeout cannot report success just because the child exits zero', async () => {
  const result = await runProcess(process.execPath, [
    '-e', 'console.error("[vitest-pool]: Timeout terminating worker (intentional harness fixture)");',
  ], { checkVitestDiagnostics: true });
  assert.equal(result.reportedCode, 0);
  assert.equal(result.diagnosticFailure, true);
  assert.equal(result.code, 1);
});

test('test inventory catches a silently omitted or duplicated performance test', () => {
  const correctness = { projectName: 'core', file: join(root, 'unit.test.ts'), name: 'correctness' };
  const timing = { projectName: 'quantum', file: join(root, 'performance.test.ts'), name: 'timing' };
  verifyPartition([correctness, timing], [correctness], [timing]);
  assert.throws(() => verifyPartition([correctness, timing], [correctness], []), /must not be empty/);
  assert.throws(() => verifyPartition([correctness, timing], [correctness, timing], [timing]), /overlap/);
  assert.throws(() => verifyPartition([correctness, timing, { ...timing, name: 'another timing' }], [correctness], [timing]), /every collected test/);
});

test('release verification rejects a leaked test hook and a missing referenced asset', async () => {
  const directory = join(root, 'qa', 'results', `fixture-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, 'index.html'), '<script type="module" src="/entry.js"></script>');
    await writeFile(join(directory, 'entry.js'), 'console.log("production");');
    await writeFile(join(directory, 'rdkit.wasm'), Buffer.from('0061736d01000000', 'hex'));
    assert.equal((await inspectBuild(directory)).productionTestHooksAbsent, true);
    await writeFile(join(directory, 'entry.js'), 'window.__MATTERLAB__ = {};');
    await assert.rejects(() => inspectBuild(directory), /exposes the molecular test hook/);
    await rm(join(directory, 'entry.js'));
    await assert.rejects(() => inspectBuild(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
