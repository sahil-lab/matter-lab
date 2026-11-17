import { describe, expect, it } from 'vitest';
import { LAB_LIMITS } from '@matterlab/contracts';
import { createChallengeController } from './controller.ts';
import { TITRATION_CHALLENGE } from './definition.ts';
import { parseChallengeDefinition, parseLearningState, parseLearningStateJson, serializeLearningState } from './persistence.ts';
import { createEmptyHarness } from './test-fixtures.ts';
import type { LearningState } from './types.ts';

describe('versioned learning sidecar', () => {
  it('saves an independent learning attempt for every supported laboratory station', () => {
    const harness = createEmptyHarness();
    const snapshot = harness.reader.snapshot;
    const stations = Array.from({ length: LAB_LIMITS.maxStations }, (_, index) =>
      snapshot.scene.stations[index] ?? { id: harness.makeId(), name: `Station ${index + 1}` });
    harness.reader.snapshot = {
      ...snapshot,
      scene: { ...snapshot.scene, stations },
      stationStates: Object.fromEntries(stations.map((station) => [station.id, {
        stationId: station.id, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1,
      }])),
    };
    const controllers = stations.map((station) => createChallengeController({ ...harness.options, stationId: station.id, bindings: {} }));
    try {
      const state: LearningState = { schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: controllers.map((controller) => controller.exportAttempt()) };
      expect(parseLearningStateJson(serializeLearningState(state))).toEqual(state);
      expect(() => parseLearningState({ ...state, attempts: [...state.attempts, state.attempts[0]] })).toThrow(/Array length/);
    } finally {
      controllers.forEach((controller) => controller.dispose());
      harness.controller.dispose();
    }
  });

  it('round-trips an actual registry/science-backed attempt without inventing runtime actions or scores', () => {
    const harness = createEmptyHarness();
    harness.controller.setInstructionIndex(6);
    harness.controller.dismissGuide(true);
    harness.controller.requestHint('probe');
    const state: LearningState = { schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [harness.controller.exportAttempt()] };
    const serialized = serializeLearningState(state);
    const parsed = parseLearningStateJson(serialized);
    expect(parsed).toEqual(state);
    expect(Object.isFrozen(parsed.attempts[0]!.trials[0]!.frame.scene)).toBe(true);
    const restored = createChallengeController({ ...harness.options, attempt: parsed.attempts[0] });
    expect(restored.getSnapshot().evaluation.score.total).toBe(0);
    expect(restored.getSnapshot().evaluation.score.complete).toBe(false);
    expect(restored.exportAttempt().progression).toEqual(state.attempts[0]!.progression);
    restored.dispose();
    harness.controller.dispose();
  });

  it('rejects persisted score authority, duplicate keys and unknown versions rather than silently migrating them', () => {
    expect(() => parseLearningState({ schemaVersion: 2, kind: 'MATTERLAB_LEARNING_STATE', attempts: [] })).toThrow();
    expect(() => parseLearningStateJson('{"schemaVersion":1,"schemaVersion":1,"kind":"MATTERLAB_LEARNING_STATE","attempts":[]}')).toThrow(/Duplicate/);
    const { controller } = createEmptyHarness();
    const attempt = { ...controller.exportAttempt(), score: 100 };
    expect(() => parseLearningState({ schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [attempt] })).toThrow(/Unknown/);
    controller.dispose();
  });

  it('rejects fake repeated trials in the same run/station/epoch and mismatched endpoint claims', () => {
    const { controller, makeId } = createEmptyHarness();
    const attempt = controller.exportAttempt();
    const trial = attempt.trials[0]!;
    const envelope = (trials: readonly unknown[]) => ({
      schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [{ ...attempt, trials }],
    });
    expect(() => parseLearningState(envelope([trial, { ...trial, id: makeId(), status: 'interrupted' }]))).toThrow(/Duplicate identity/);
    expect(() => parseLearningState(envelope([{ ...trial, status: 'captured' }]))).toThrow(/endpoint/);
    expect(() => parseLearningState(envelope([{ ...trial, scope: { ...trial.scope, epoch: 9 } }]))).toThrow(/scope/);
    controller.dispose();
  });

  it('refuses unsafe JSON and nonfinite values before invoking getters or coercing data', () => {
    let invoked = false;
    const unsafe = { get schemaVersion() { invoked = true; return 1; }, kind: 'MATTERLAB_LEARNING_STATE', attempts: [] };
    expect(() => parseLearningState(unsafe)).toThrow(/Accessors/);
    expect(invoked).toBe(false);
    expect(() => parseLearningState({ schemaVersion: Number.NaN, kind: 'MATTERLAB_LEARNING_STATE', attempts: [] })).toThrow(/finite/);
    expect(() => parseLearningStateJson('{"schemaVersion":1,"kind":"MATTERLAB_LEARNING_STATE","attempts":[],"__proto__":{}}')).toThrow(/Unsafe/);
    const cyclic: { loop?: unknown } = {};
    cyclic.loop = cyclic;
    expect(() => parseLearningState(cyclic)).toThrow(/Cyclic/);
  });

  it('rejects cyclic or unresolved declarative goal dependencies', () => {
    const [first, ...rest] = TITRATION_CHALLENGE.goals;
    expect(() => parseChallengeDefinition({ ...TITRATION_CHALLENGE, goals: [{ ...first, requires: [first!.id] }, ...rest] })).toThrow(/acyclic/);
    expect(() => parseChallengeDefinition({ ...TITRATION_CHALLENGE, captureRequires: ['not-a-goal'] })).toThrow(/Capture/);
  });
});
