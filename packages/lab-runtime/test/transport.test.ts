import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { parseLabJson, serializeLabContract } from '@matterlab/contracts';
import type { RuntimeCheckpoint, RuntimeSnapshot } from '@matterlab/contracts';
import { apparatusRegistry } from '../../../apps/web/src/lab/apparatus/registry.ts';
import { createRuntimeWorkerHost } from '../../../apps/web/src/lab/experiments/worker-host';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from '../../../apps/web/src/lab/experiments/protocol';
import { executeNodeRun } from '../src/execution.ts';
import { dependencies, fixture, request, uuid } from './fixtures.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const aliases = {
  '@matterlab/contracts': fileURLToPath(new URL('../../contracts/src/index.ts', import.meta.url)),
  '@matterlab/lab-runtime': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  '@matterlab/lab-science': fileURLToPath(new URL('../../lab-science/src/index.ts', import.meta.url)),
};
function replayFixture() {
  const setup = fixture();
  return request(setup.scene, [
    { kind: 'CONTROL', control: { controlId: uuid(4000), type: 'RESUME', stationId: setup.ids.stationId, atSimulationS: 0, payload: {} } },
    { kind: 'ACTION', action: { actionId: uuid(4001), type: 'SET_VALVE', targetInstanceId: setup.ids.buretteId, atSimulationS: 0, payload: { openingFraction: 0.5 } } },
    { kind: 'ADVANCE', stationId: setup.ids.stationId, ticks: 2 },
  ]);
}

beforeAll(async () => {
  await build({ root, configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), configLoader: 'native', logLevel: 'silent' });
}, 60_000);

it('executes the actual bundled Node runner byte-for-byte with the pure runtime and rejects malformed stdin', async () => {
  const input = replayFixture();
  const expected = await executeNodeRun(input, dependencies);
  expect(expected.result.status).toBe('SUCCEEDED');
  const stdout = execFileSync(process.execPath, [cli], {
    cwd: root, input: serializeLabContract('NodeRunRequest', input), encoding: 'utf8',
    timeout: 45_000, maxBuffer: 8 * 1024 * 1024 + 1,
  });
  expect(stdout).toBe(`${serializeLabContract('NodeRunResponse', expected)}\n`);
  const invalid = spawnSync(process.execPath, [cli], { cwd: root, input: '{invalid', encoding: 'utf8', timeout: 45_000 });
  expect(invalid.status).toBe(64);
  expect(invalid.stdout).toBe('');
  expect(JSON.parse(invalid.stderr).code).toBe('SERIALIZATION_FAILED');
}, 60_000);

it('replays identical commands through the real worker host with matching checkpoint and immutable solve cohorts', async () => {
  const input = replayFixture();
  const expected = await executeNodeRun(input, dependencies);
  const responses: RuntimeWorkerResponse[] = [];
  const host = createRuntimeWorkerHost((response) => responses.push(response));
  await host({
    requestId: uuid(4100), type: 'INIT',
    options: { initialScene: input.initialScene, runId: input.runId, definitions: apparatusRegistry.listDefinitions() },
  });
  for (const [index, step] of input.steps.entries()) {
    const id = uuid(4101 + index);
    const command: RuntimeWorkerRequest = step.kind === 'ACTION' ? { requestId: id, type: 'ACTION', action: step.action } :
      step.kind === 'CONTROL' ? { requestId: id, type: 'CONTROL', control: step.control } :
        { requestId: id, type: 'ADVANCE', stationId: step.stationId, ticks: step.ticks };
    await host(command);
  }
  await host({ requestId: uuid(4110), type: 'CHECKPOINT' });
  expect(responses.every((response) => response.ok)).toBe(true);
  const final = responses.at(-1)!;
  if (!final.ok) throw new Error(final.error.detail);
  expect(serializeLabContract('RuntimeCheckpoint', final.value as RuntimeCheckpoint))
    .toBe(serializeLabContract('RuntimeCheckpoint', expected.checkpoint!));
  const events = responses.flatMap((response) => response.events);
  for (const event of events.filter((event) => event.type === 'OBSERVATIONS')) {
    if (event.type === 'OBSERVATIONS') expect(event.observations.every((record) => record.sequence === event.sequence)).toBe(true);
  }
}, 30_000);

it('bundles and executes the browser worker without Node globals using the same real science and registry input', async () => {
  const bundled = await build({
    configFile: false, root, logLevel: 'silent', resolve: { alias: aliases },
    build: {
      write: false, target: 'es2022', minify: false,
      lib: { entry: fileURLToPath(new URL('../../../apps/web/src/lab/experiments/runtime.worker.ts', import.meta.url)), name: 'LabWorker', formats: ['iife'] },
    },
  });
  if (!Array.isArray(bundled)) throw new Error('Expected library output.');
  const chunk = bundled[0]!.output.find((output) => output.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser worker chunk.');
  const input = replayFixture();
  const expected = await executeNodeRun(input, dependencies);
  let receive: ((response: RuntimeWorkerResponse) => void) | undefined;
  const browser: Record<string, unknown> = {
    TextEncoder, TextDecoder, crypto: globalThis.crypto,
    postMessage: (response: RuntimeWorkerResponse) => receive?.(JSON.parse(JSON.stringify(response)) as RuntimeWorkerResponse),
  };
  const context = createContext(browser);
  runInContext(chunk.code, context, { timeout: 5000 });
  const send = async (message: RuntimeWorkerRequest): Promise<RuntimeWorkerResponse> => {
    return new Promise((resolve) => {
      receive = resolve;
      const code = `onmessage({data:JSON.parse(${JSON.stringify(JSON.stringify(message))})})`;
      runInContext(code, context, { timeout: 5000 });
    });
  };
  expect((await send({
    requestId: uuid(4200), type: 'INIT',
    options: { initialScene: input.initialScene, runId: input.runId, definitions: apparatusRegistry.listDefinitions() },
  })).ok).toBe(true);
  let last: RuntimeWorkerResponse | undefined;
  for (const [index, step] of input.steps.entries()) {
    const requestId = uuid(4201 + index);
    last = await send(step.kind === 'ACTION' ? { requestId, type: 'ACTION', action: step.action } :
      step.kind === 'CONTROL' ? { requestId, type: 'CONTROL', control: step.control } :
        { requestId, type: 'ADVANCE', stationId: step.stationId, ticks: step.ticks });
    expect(last.ok).toBe(true);
  }
  const snapshot = parseLabJson('RuntimeSnapshot', JSON.stringify(last!.snapshot)) as RuntimeSnapshot;
  expect(serializeLabContract('RuntimeSnapshot', snapshot)).toBe(serializeLabContract('RuntimeSnapshot', expected.checkpoint!.snapshot));
}, 45_000);
