import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { validateLabContract } from '@matterlab/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import fixtures from '../fixtures/replay-v1.json';
import { getScienceCatalog, solveJson, type ScienceResponse } from '../src/index.js';
import type { ScienceWorkerScope } from '../src/worker.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
// Shared-host process startup is not the pure solver's numerical latency budget.
const childTimeoutMs = 45_000;

beforeAll(async () => {
  await build({
    root: packageRoot,
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
  });
  await import(new URL('../tools/export-catalog.mjs', import.meta.url).href);
}, 60_000);

describe('deterministic JSON entry and bounded Node CLI', () => {
  it.each([fixtures.cases[3], fixtures.cases[7], fixtures.cases[11]])('CLI matches the pure solver byte-for-byte for $id', (fixture) => {
    const input = JSON.stringify({ schemaVersion: 1, operation: 'equilibrium', input: fixture.input });
    const output = execFileSync(process.execPath, [cliPath], {
      input, encoding: 'utf8', timeout: childTimeoutMs, maxBuffer: 512_000,
    });
    expect(output).toBe(`${solveJson(input)}\n`);
  }, 60_000);

  it('handles malformed JSON, unknown operations, incompatible schema and oversized UTF-8 input explicitly', () => {
    for (const input of ['{bad', '{"schemaVersion":2,"operation":"catalog"}', '{"schemaVersion":1,"operation":"unknown"}',
      '{"schemaVersion":1,"operation":"catalog","ignored":true}', 'é'.repeat(150_000)]) {
      const result = JSON.parse(solveJson(input));
      expect(result.status).toBe('FAILED');
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result).not.toHaveProperty('pH');
    }
    const output = execFileSync(process.execPath, [cliPath], {
      input: 'x'.repeat(300_000), encoding: 'utf8', timeout: childTimeoutMs, maxBuffer: 512_000,
    });
    expect(JSON.parse(output).error.code).toBe('INVALID_INPUT');
  }, 60_000);

  it('prepares the same inventory through the JSON protocol without a second implementation', () => {
    const request = JSON.stringify({
      schemaVersion: 1, operation: 'prepare', input: { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 },
    });
    const output = execFileSync(process.execPath, [cliPath], { input: request, encoding: 'utf8', timeout: childTimeoutMs });
    expect(output.trimEnd()).toBe(solveJson(request));
    expect(JSON.parse(output).contents.species).toEqual([{ speciesId: 'ion:chloride', moles: expect.closeTo(0.0025, 14) }]);
  }, 60_000);

  it('generates backend catalogues from exactly the exported authority, with resolvable source IDs', async () => {
    const [reagents, sources] = await Promise.all([
      readFile(new URL('../dist/reagent-definitions.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../dist/source-references.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    const catalogue = getScienceCatalog();
    expect(reagents.reagents).toEqual(catalogue.reagents);
    expect(sources.sources).toEqual(catalogue.sources);
    const ids = new Set(catalogue.sources.map((source) => source.id));
    for (const record of [...catalogue.reagents, ...catalogue.indicators]) {
      expect(record.sourceIds.every((id) => ids.has(id))).toBe(true);
    }
  });
});

it('bundles and executes the same worker in a browser-only JS context without Node globals', async () => {
  const output = await build({
    configFile: false,
    root: packageRoot,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      lib: { entry: fileURLToPath(new URL('../src/worker.ts', import.meta.url)), name: 'ScienceWorker', formats: ['iife'] },
      minify: false,
    },
  });
  if (!Array.isArray(output)) throw new Error('Expected browser library build output.');
  const javascript = output[0].output.find((chunk) => chunk.type === 'chunk');
  if (!javascript || javascript.type !== 'chunk') throw new Error('Worker build produced no JavaScript.');
  const browser: { TextEncoder: typeof TextEncoder; ScienceWorker?: { installScienceWorker(scope: ScienceWorkerScope): () => void } } = { TextEncoder };
  runInNewContext(javascript.code, browser, { timeout: 5_000 });
  let listener: ((event: { data: unknown }) => void) | undefined;
  let response: ScienceResponse | undefined;
  const scope: ScienceWorkerScope = {
    addEventListener(_type, callback) { listener = callback; },
    removeEventListener(_type, callback) { if (listener === callback) listener = undefined; },
    postMessage(result) { response = result; },
  };
  const dispose = browser.ScienceWorker!.installScienceWorker(scope);
  const request = { schemaVersion: 1, operation: 'equilibrium', input: fixtures.cases[3].input };
  listener!({ data: request });
  expect(JSON.stringify(response)).toBe(solveJson(JSON.stringify(request)));
  dispose();
  expect(listener).toBeUndefined();
}, 30_000);

it('all numeric/unsupported replay results and preparations validate against the frozen shared schema', () => {
  for (const fixture of fixtures.cases) {
    const result = JSON.parse(solveJson(JSON.stringify({ schemaVersion: 1, operation: 'equilibrium', input: fixture.input })));
    const validated = validateLabContract('EquilibriumResult', result);
    expect(validated.ok, validated.ok ? fixture.id : JSON.stringify(validated.errors)).toBe(true);
  }
  for (const reagent of getScienceCatalog().reagents) {
    const result = JSON.parse(solveJson(JSON.stringify({
      schemaVersion: 1, operation: 'prepare',
      input: { reagentId: reagent.id, volumeL: 0.025, concentrationMolL: reagent.defaultConcentrationMolL },
    })));
    const validated = validateLabContract('PreparationResult', result);
    expect(validated.ok, validated.ok ? reagent.id : JSON.stringify(validated.errors)).toBe(true);
  }
});
