import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  canonicalizeNodeRunInput, ContractValidationError, deserializeExperimentScene, hashNodeRunInput,
  LAB_JSON_SCHEMA, LAB_LIMITS, parseApparatusDefinition, parseExperimentScene, parseLabAction,
  parseLabContract, parseLabJson, serializeExperimentScene, serializeLabContract,
  validateExperimentScene, validateLabAction, validateLabContract,
} from '../src/index.ts';
import type { LabAction, LabActionOf, NodeRunRequest } from '../src/index.ts';
import { apparatusFixture, checkpointFixture, id, requestFixture, sceneFixture, solution } from './fixtures.ts';

describe('versioned scene boundary', () => {
  it('round-trips two independent station graphs, inventory, configuration and durable revision without aliasing', () => {
    const scene = sceneFixture();
    const loaded = deserializeExperimentScene(serializeExperimentScene(scene));
    expect(loaded).toEqual(scene);
    expect(loaded).not.toBe(scene);
    expect(loaded.apparatus[0]).not.toBe(scene.apparatus[0]);
    expect(Object.isFrozen(loaded.containerStates[id(4)]!.species)).toBe(true);
    expect(() => Reflect.set(loaded, 'revision', 100)).not.toThrow();
    expect(loaded.revision).toBe(3);
  });

  it.each([
    ['invalid UUID', (s: ExperimentInput) => { s.id = 'not-a-uuid'; }],
    ['unknown schema version', (s: ExperimentInput) => { s.schemaVersion = 2; }],
    ['negative volume', (s: ExperimentInput) => { s.containerStates[id(4)].volumeL = -1; }],
    ['negative moles', (s: ExperimentInput) => { s.containerStates[id(4)].species[0].moles = -1; }],
    ['nonfinite amount', (s: ExperimentInput) => { s.containerStates[id(4)].species[0].moles = Number.NaN; }],
    ['nonfinite position', (s: ExperimentInput) => { s.apparatus[0].transform.positionM[0] = Infinity; }],
    ['zero tick', (s: ExperimentInput) => { s.simulationConfig.timeStepS = 0; }],
    ['nonunit quaternion', (s: ExperimentInput) => { s.apparatus[0].transform.quaternion = [0, 0, 0, 0]; }],
    ['duplicate station', (s: ExperimentInput) => { s.stations.push(s.stations[0]); }],
    ['unknown container', (s: ExperimentInput) => { s.containerStates[id(90)] = s.containerStates[id(4)]; }],
    ['cross-station flow', (s: ExperimentInput) => { s.connections[0].to.instanceId = id(7); }],
    ['unknown socket endpoint', (s: ExperimentInput) => { s.connections[0].from.instanceId = id(90); }],
    ['lost units', (s: ExperimentInput) => { s.containerStates[id(4)].volumeML = 50; delete s.containerStates[id(4)].volumeL; }],
  ])('rejects %s', (_name, mutate) => {
    const input = JSON.parse(JSON.stringify(sceneFixture())) as ExperimentInput;
    mutate(input);
    expect(validateExperimentScene(input).ok).toBe(false);
  });

  it('rejects ambiguous JSON, hidden/accessor data, sparse arrays, cycles and invalid Unicode without executing getters', () => {
    const json = serializeExperimentScene(sceneFixture());
    expect(() => deserializeExperimentScene(json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))).toThrow(ContractValidationError);
    expect(() => parseLabJson('ExperimentScene', '{"id":"x","\\u0069d":"y"}')).toThrow('Duplicate JSON');
    let getterCalls = 0;
    const config = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { getterCalls++; return 1; } });
    for (const invalid of [config, { value: undefined }, { date: new Date() }, { value: [, 1] }, { value: '\uD800' },
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown]) {
      const scene = { ...sceneFixture(), viewport: invalid };
      expect(validateExperimentScene(scene).ok).toBe(false);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateExperimentScene({ ...sceneFixture(), viewport: cyclic }).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('enforces caps and returns bounded RFC9457 errors without coercion', () => {
    const input = { ...sceneFixture(), stations: Array.from({ length: LAB_LIMITS.maxStations + 1 }, (_, i) => ({ id: id(100 + i), name: 'Station' })) };
    const result = validateExperimentScene(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.code === 'LIMIT_EXCEEDED')).toBe(true);
    try {
      parseExperimentScene({ ...sceneFixture(), revision: '3' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).problem.status).toBe(422);
      expect((error as ContractValidationError).problem.errors?.[0]?.path).toBe('/revision');
    }
  });
});

describe('discriminated commands and apparatus contracts', () => {
  const envelope = { actionId: id(20), atSimulationS: 0, targetInstanceId: id(4), expectedRevision: 0, expectedEpoch: 0 };
  it('requires explicit preparation provenance and only accepts typed transfer payloads', () => {
    const action = parseLabAction({
      ...envelope, type: 'FILL',
      payload: { contents: solution(0.05, 'ion:sodium', 0.005), preparation: { kind: 'INITIAL', sourceId: 'test-preparation' } },
    });
    if (action.type === 'FILL') expectTypeOf(action).toEqualTypeOf<LabActionOf<'FILL'>>();
    expect(action.type).toBe('FILL');
    expect(validateLabAction({ ...envelope, type: 'FILL', payload: { contents: solution(0.05, 'ion:sodium', 0.005) } }).ok).toBe(false);
    expect(validateLabAction({ ...envelope, type: 'SET_VALVE', payload: { openingFraction: 1.01 } }).ok).toBe(false);
    expect(validateLabAction({ ...envelope, type: 'SET_VALVE', payload: { openingFraction: 0.5, volumeL: 1 } }).ok).toBe(false);
    expect(validateLabAction({ ...envelope, type: 'TRANSFER', payload: { sourceInstanceId: id(4), targetInstanceId: id(4), volumeL: 0.001, connectionId: id(8) } }).ok).toBe(false);
    expect(validateLabAction({ ...envelope, type: 'PLACE', payload: { instance: sceneFixture().apparatus[1] } }).ok).toBe(false);
    expect(validateLabAction({ ...envelope, type: 'EXECUTE_CODE', payload: {} }).ok).toBe(false);
  });

  it('preserves calibration/socket metadata and rejects corrupt visual mappings or config', () => {
    const definition = apparatusFixture();
    expect(parseApparatusDefinition(JSON.parse(JSON.stringify(definition)))).toEqual(definition);
    const invalidCurve = {
      ...definition, vesselCalibration: {
        ...definition.vesselCalibration!,
        volumeHeightCurve: [{ volumeL: 0, heightM: 0.01 }, { volumeL: 0.25, heightM: 0.01 }],
      },
    };
    expect(validateLabContract('ApparatusDefinition', invalidCurve).ok).toBe(false);
    expect(validateLabContract('ApparatusDefinition', { ...definition, capacityL: 0.5 }).ok).toBe(false);
    expect(validateLabContract('ApparatusDefinition', { ...definition, sockets: [definition.sockets[0], definition.sockets[0]] }).ok).toBe(false);
    expect(validateLabContract('ApparatusDefinition', { ...definition, defaultConfig: { labeled: 'yes' } }).ok).toBe(false);
  });
});

describe('solver and immutable run boundaries', () => {
  const failure = {
    status: 'UNSUPPORTED', evidence: 'UNSUPPORTED', methodId: 'test-model', methodVersion: '1.0.0',
    sourceIds: [], warnings: [], assumptions: [], limitations: ['Test unsupported model'], diagnostics: {},
    error: { type: 'urn:matterlab:problem:unsupported-model', title: 'Unsupported', status: 422, detail: 'Test model is unsupported.', code: 'UNSUPPORTED_MODEL' },
  };
  it('preserves unsupported diagnostics but forbids fabricated pH or preparation inventory', () => {
    expect(parseLabContract('EquilibriumResult', failure)).toEqual(failure);
    expect(validateLabContract('EquilibriumResult', { ...failure, pH: { value: 7, unit: 'pH' } }).ok).toBe(false);
    expect(validateLabContract('PreparationResult', { ...failure, contents: solution(1, 'ion:sodium', 0.1) }).ok).toBe(false);
    expect(validateLabContract('EquilibriumInput', { contents: solution(0, 'ion:sodium', 0), methodId: 'test', assumptions: [] }).ok).toBe(false);
  });

  it('requires observation units and preserves source-specific delivered-volume association', () => {
    const observation = {
      type: 'PH', apparatusId: id(5), stationId: id(2), timeS: 1, quantity: { value: 7, unit: 'pH' },
      evidence: 'MODEL_CALCULATED', methodId: 'test-only-result', methodVersion: '1.0.0', sourceIds: ['test-fixture'],
      titration: { sourceInstanceId: id(4), receiverInstanceId: id(5), deliveredVolumeL: 0.025 },
    };
    expect(parseLabContract('Observation', observation)).toEqual(observation);
    expect(validateLabContract('Observation', { ...observation, quantity: { value: 7, unit: 'mL' } }).ok).toBe(false);
    expect(validateLabContract('Observation', { ...observation, titration: { ...observation.titration, receiverInstanceId: id(7) } }).ok).toBe(false);
  });

  it('round-trips a checkpoint and rejects loss of event/idempotency history', () => {
    const checkpoint = checkpointFixture();
    expect(parseLabJson('RuntimeCheckpoint', serializeLabContract('RuntimeCheckpoint', checkpoint))).toEqual(checkpoint);
    expect(validateLabContract('RuntimeCheckpoint', { ...checkpoint, snapshot: { ...checkpoint.snapshot, lastSequence: 1 } }).ok).toBe(false);
    expect(validateLabContract('RuntimeCheckpoint', { ...checkpoint, completedStepCount: 1 }).ok).toBe(false);
    expect(validateLabContract('RuntimeSnapshot', { ...checkpoint.snapshot, stationStates: {} }).ok).toBe(false);
  });
});

describe('portable canonical replay envelope', () => {
  it('allows identical retries but rejects conflicting actionId reuse before persistence', () => {
    const request = requestFixture();
    const step = request.steps[0]!;
    expect(validateLabContract('NodeRunRequest', { ...request, steps: [step, step] }).ok).toBe(true);
    if (step.kind !== 'ACTION') throw new Error('fixture');
    const changed: LabAction = { ...step.action, atSimulationS: 1 };
    expect(validateLabContract('NodeRunRequest', { ...request, steps: [step, { kind: 'ACTION', action: changed }] }).ok).toBe(false);
  });

  it('hashes canonical input, not run identity/final scene, retaining pins, limits and ordered steps', async () => {
    const request = requestFixture();
    const hash = await hashNodeRunInput(request);
    expect(hash).toBe(createHash('sha256').update(canonicalizeNodeRunInput(request), 'utf8').digest('hex'));
    expect(await hashNodeRunInput({ ...request, runId: id(90) })).toBe(hash);
    expect(await hashNodeRunInput({ ...request, methodVersion: '2.0.0' })).not.toBe(hash);
    expect(await hashNodeRunInput({ ...request, limits: { maxTicks: 10, maxActions: 20, maxObservations: 30, maxSimulationTimeS: 60 } })).not.toBe(hash);
    const advance = { kind: 'ADVANCE' as const, stationId: id(2), ticks: 1 };
    expect(await hashNodeRunInput({ ...request, steps: [...request.steps, advance] }))
      .not.toBe(await hashNodeRunInput({ ...request, steps: [advance, ...request.steps] }));
  });

  it('implements JCS key/number serialization including integer-like and supplementary Unicode keys', () => {
    const request = requestFixture();
    const input: NodeRunRequest = {
      ...request, initialScene: {
        ...request.initialScene,
        viewport: { '2': 'two', '10': 'ten', '\uE000': 'bmp', '😀': 'supplementary', values: [-0, 1e-7, 1e21] },
      },
    };
    const canonical = canonicalizeNodeRunInput(input);
    expect(canonical).toContain('"viewport":{"10":"ten","2":"two","values":[0,1e-7,1e+21],"😀":"supplementary","\uE000":"bmp"}');
    expect(canonical).not.toContain('"runId"');
  });

  it('ships the exact validator schema to backend consumers without a divergent hand-maintained copy', () => {
    const generated: unknown = JSON.parse(readFileSync(new URL('../schemas/lab-v1.schema.json', import.meta.url), 'utf8'));
    expect(generated).toEqual(LAB_JSON_SCHEMA);
  });
});

// Mutations intentionally represent untrusted wire data, not valid immutable DTOs.
type ExperimentInput = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
