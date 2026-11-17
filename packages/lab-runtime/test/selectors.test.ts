import { expect, it } from 'vitest';
import { createLabRuntime } from '../src/runtime.ts';
import { createAqueousExperimentPlugin } from '../src/plugins.ts';
import { selectCurrentObservation } from '../src/selectors.ts';
import { action, dependencies, fixture, prepared } from './fixtures.ts';

it('current scientific selectors reject an old tint after a same-time successful solve without that indicator', async () => {
  const { scene, ids, runId } = fixture();
  const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
  const before = runtime.reader.getSnapshot();
  const oldPH = selectCurrentObservation(before, ids.flaskId, 'PH')!;
  const oldIndicator = selectCurrentObservation(before, ids.flaskId, 'INDICATOR')!;
  expect(oldIndicator).toBeDefined();
  const receipt = await runtime.actions.dispatch(action(runtime, 7001, ids.flaskId, 'CUSTOM', {
    pluginId: 'matterlab:container-config-v1', actionType: 'SET_CONFIG', data: { indicatorId: 'none' },
  }));
  expect(receipt.status).toBe('APPLIED');
  const after = runtime.reader.getSnapshot();
  expect(after.observations).toContainEqual(oldIndicator);
  expect(selectCurrentObservation(after, ids.flaskId, 'PH')!.sequence).toBeGreaterThan(oldPH.sequence);
  expect(selectCurrentObservation(after, ids.flaskId, 'PH')!.observation.timeS).toBe(oldPH.observation.timeS);
  expect(selectCurrentObservation(after, ids.flaskId, 'INDICATOR')).toBeUndefined();
  runtime.dispose();
});

it('current scientific selectors require a new solve after inventory changes even at the same simulation time', async () => {
  const { scene, ids, runId } = fixture();
  const base = createAqueousExperimentPlugin(dependencies.science);
  const runtime = await createLabRuntime({
    ...dependencies, initialScene: scene, runId,
    experiments: [{ ...base, getSolverRequests: (snapshot, stationId) =>
      base.getSolverRequests!(snapshot, stationId).filter((request) => request.input.contents.volumeL <= 0.025) }],
  });
  expect(selectCurrentObservation(runtime.reader.getSnapshot(), ids.flaskId, 'PH')).toBeDefined();
  await runtime.actions.dispatch(action(runtime, 7010, ids.flaskId, 'FILL', {
    contents: prepared('hcl', 0.03, 0.05), preparation: { kind: 'EXTERNAL', sourceId: 'test:outside-template-sampling' },
  }));
  const snapshot = runtime.reader.getSnapshot();
  expect(snapshot.stationStates[ids.stationId]!.simulationTimeS).toBe(0);
  expect(selectCurrentObservation(snapshot, ids.flaskId, 'VOLUME')).toBeDefined();
  expect(selectCurrentObservation(snapshot, ids.flaskId, 'PH')).toBeUndefined();
  expect(selectCurrentObservation(snapshot, ids.flaskId, 'CONCENTRATION')).toBeUndefined();
  runtime.dispose();
});
