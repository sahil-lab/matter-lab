import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, runProcess } from './process.mjs';

function identities(tests) {
  return tests.map((test) => JSON.stringify([
    test.projectName, relative(root, test.file), test.name, test.location,
  ])).sort();
}

export function verifyPartition(all, unit, performance) {
  assert.ok(all.length > 0, 'The complete test inventory must not be empty.');
  assert.ok(unit.length > 0, 'The correctness suite must not be empty.');
  assert.ok(performance.length > 0, 'The explicit performance suite must not be empty.');
  const unitKeys = new Set(identities(unit));
  assert.ok(identities(performance).every((key) => !unitKeys.has(key)), 'Performance and correctness suites overlap.');
  assert.deepEqual(
    identities([...unit, ...performance]), identities(all),
    'The two suites must account for every collected test exactly once.',
  );
}

async function main() {
  const directory = join(root, 'qa', 'results', 'inventory');
  await mkdir(directory, { recursive: true });
  const collected = {};
  for (const [name, selectors] of [
    ['all', []],
    ['unit', ['--exclude', '**/performance.test.ts']],
    ['performance', ['performance.test.ts']],
  ]) {
    const output = join(directory, `${name}.json`);
    const result = await runProcess(process.execPath, [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'list',
      '--pool=threads', '--maxWorkers=1', '--no-file-parallelism', '--no-static-parse',
      ...selectors, `--json=${output}`,
    ], { captureOutput: true });
    assert.equal(result.code, 0, `Vitest could not collect the ${name} inventory: ${result.error ?? result.signal ?? ''}`);
    assert.doesNotMatch(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      /\[vitest-pool\].*(?:timeout|error)|Unhandled (?:Error|Rejection)/i,
      `Vitest reported a worker/collection error in ${name}, despite its exit code.`,
    );
    collected[name] = JSON.parse(await readFile(output, 'utf8'));
  }
  verifyPartition(collected.all, collected.unit, collected.performance);
  const counts = Object.fromEntries(Object.entries(collected).map(([name, tests]) => [name, tests.length]));
  await writeFile(join(directory, 'partition.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), counts, complete: true,
  }, null, 2)}\n`);
  console.log(`Test partition verified: ${counts.unit} correctness + ${counts.performance} explicit performance = ${counts.all}; none hidden or duplicated.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
