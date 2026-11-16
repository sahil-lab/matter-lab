import { describe, expect, it } from 'vitest';
import { createDefinitionRegistry, VERTICAL_SLICE_DEFINITIONS } from '../registry';
import { createDefaultPlugins } from '../plugins';
import {
  assembleTitrationStation,
  buildEmptyExperimentScene,
  createFakeStrongAcidStrongBaseSolverClient,
  ORIGIN_TRANSFORM,
  type TitrationRigIds,
} from '../testFixtures';
import { buildAttachAction, buildFillAction, buildPlaceAction, buildResetStationAction, buildSetValveAction } from './actions';
import { ExperimentEngine, type EngineEvent, type ExperimentEngineDeps } from './engine';
import { generateUUID } from './ids';
import { totalMoles } from './inventory';

function createDeps(): ExperimentEngineDeps {
  return {
    registry: createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS),
    solver: createFakeStrongAcidStrongBaseSolverClient(),
    plugins: createDefaultPlugins(),
  };
}

function createEngine(timeStepS = 1): ExperimentEngine {
  return new ExperimentEngine(buildEmptyExperimentScene(timeStepS), createDeps());
}

const HCL_25ML_0_1M = { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' };
const NAOH_50ML_0_1M = { volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' };

/** Fills the standard 25.00 mL / 0.100 M HCl aliquot and 0.100 M NaOH titrant (Section 6 step 3). */
function fillTitrationRig(engine: ExperimentEngine, rig: TitrationRigIds): void {
  engine.dispatchOrThrow(buildFillAction(rig.flaskId, HCL_25ML_0_1M));
  engine.dispatchOrThrow(buildFillAction(rig.buretteId, NAOH_50ML_0_1M));
}

describe('ExperimentEngine: full titration vertical slice', () => {
  it('fill, open valve, meter transfers, compute pH, update sensor, and reach equivalence at 25.00 mL with pH \u2248 7', async () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    await engine.settle();

    const initialPh = engine.getLatestObservation(rig.flaskId, 'PH');
    expect(initialPh).toBeDefined();
    expect(initialPh!.quantity.value).toBeLessThan(2); // ~0.1 M strong acid before any titrant

    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);
    const phAfterEachTick: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      engine.tick(rig.stationId);
      await engine.settle();
      phAfterEachTick.push(engine.getLatestObservation(rig.flaskId, 'PH')!.quantity.value);
    }

    // 5 ticks x 5 mL/tick (full-open 0.005 L/s x 1 s) = 25.00 mL delivered: the labelled equivalence volume.
    const scene = engine.getScene();
    expect(scene.containerStates[rig.buretteId]!.volumeL).toBeCloseTo(0.025, 9);
    expect(scene.containerStates[rig.flaskId]!.volumeL).toBeCloseTo(0.05, 9);

    for (let i = 1; i < phAfterEachTick.length; i += 1) {
      expect(phAfterEachTick[i]).toBeGreaterThan(phAfterEachTick[i - 1]!); // chemically sensible monotonic rise, not a hardcoded curve
    }
    expect(phAfterEachTick[phAfterEachTick.length - 1]).toBeCloseTo(7, 6);

    // "Every component receives the same data": the full observation ledger is the one thing a
    // plot/graph/UI would all read from, and it matches what tick-by-tick sampling saw above.
    const plottedPh = engine.getObservations(rig.flaskId).filter((o) => o.type === 'PH').map((o) => o.quantity.value);
    expect(plottedPh.slice(-5)).toEqual(phAfterEachTick);
  });

  it('conserves volume and species moles exactly (within tolerance) across many ticks', async () => {
    const engine = createEngine(0.1);
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);

    const before = engine.getScene();
    const totalVolumeBefore = before.containerStates[rig.buretteId]!.volumeL + before.containerStates[rig.flaskId]!.volumeL;
    const totalNaOHBefore = totalMoles([before.containerStates[rig.buretteId]!, before.containerStates[rig.flaskId]!], 'NaOH');

    for (let i = 0; i < 30; i += 1) engine.tick(rig.stationId);
    await engine.settle();

    const after = engine.getScene();
    const totalVolumeAfter = after.containerStates[rig.buretteId]!.volumeL + after.containerStates[rig.flaskId]!.volumeL;
    const totalNaOHAfter = totalMoles([after.containerStates[rig.buretteId]!, after.containerStates[rig.flaskId]!], 'NaOH');
    const sourceDecrease = before.containerStates[rig.buretteId]!.volumeL - after.containerStates[rig.buretteId]!.volumeL;
    const receiverIncrease = after.containerStates[rig.flaskId]!.volumeL - before.containerStates[rig.flaskId]!.volumeL;

    expect(totalVolumeAfter).toBeCloseTo(totalVolumeBefore, 9);
    expect(totalNaOHAfter).toBeCloseTo(totalNaOHBefore, 9);
    expect(sourceDecrease).toBeCloseTo(receiverIncrease, 9);
  });

  it('pausing suspends transfer; resuming continues it', async () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);
    engine.tick(rig.stationId);
    const volumeAfterOneTick = engine.getScene().containerStates[rig.buretteId]!.volumeL;

    engine.pauseStation(rig.stationId);
    const recordsWhilePaused = engine.tick(rig.stationId);
    expect(recordsWhilePaused).toEqual([]);
    expect(engine.getScene().containerStates[rig.buretteId]!.volumeL).toBeCloseTo(volumeAfterOneTick, 12);

    engine.resumeStation(rig.stationId);
    engine.tick(rig.stationId);
    expect(engine.getScene().containerStates[rig.buretteId]!.volumeL).toBeLessThan(volumeAfterOneTick);
  });

  it('a successful RESET also zeroes and pauses the station clock it scopes', () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);
    engine.tick(rig.stationId);
    engine.tick(rig.stationId);
    expect(engine.getClock(rig.stationId)!.simulationS).toBeGreaterThan(0);

    engine.dispatchOrThrow(buildResetStationAction(rig.stationId));

    const clock = engine.getClock(rig.stationId)!;
    expect(clock.status).toBe('IDLE');
    expect(clock.simulationS).toBe(0);
    expect(engine.getScene().containerStates[rig.flaskId]!.volumeL).toBe(0); // chemistry cleared too
    expect(engine.getScene().apparatus).toHaveLength(7); // rig itself survives
  });

  it('duplicate actionId is idempotent: the second dispatch is recorded as DUPLICATE and does not re-apply', () => {
    const engine = createEngine();
    const stationId = engine.createStation('Station 1');
    const action = buildPlaceAction(generateUUID(), 'bench.standard', stationId, ORIGIN_TRANSFORM, undefined, { actionId: 'fixed-action-id' });

    const first = engine.dispatch(action);
    expect(first.outcome).toBe('APPLIED');
    const revisionAfterFirst = engine.getScene().revision;
    const apparatusCountAfterFirst = engine.getScene().apparatus.length;

    const second = engine.dispatch(action);
    expect(second.outcome).toBe('DUPLICATE');
    expect(engine.getScene().revision).toBe(revisionAfterFirst);
    expect(engine.getScene().apparatus).toHaveLength(apparatusCountAfterFirst);
  });

  it('replay reproduces the same scene, event outcomes and observations', async () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);
    for (let i = 0; i < 5; i += 1) engine.tick(rig.stationId);
    await engine.settle();

    const snapshot = engine.createSnapshot();
    const replayed = await ExperimentEngine.replay(snapshot, createDeps());

    expect(replayed.getScene()).toEqual(engine.getScene());
    expect(replayed.getEventLog().map((e) => ({ type: e.action.type, outcome: e.outcome, reason: e.rejectionReason }))).toEqual(
      engine.getEventLog().map((e) => ({ type: e.action.type, outcome: e.outcome, reason: e.rejectionReason })),
    );
    expect(replayed.getObservations().map((o) => o.quantity.value)).toEqual(engine.getObservations().map((o) => o.quantity.value));
  });

  it('a snapshot survives a JSON round trip and reopening preserves the connection graph and contents', async () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    fillTitrationRig(engine, rig);
    engine.dispatchOrThrow(buildSetValveAction(rig.buretteId, 1));
    engine.resumeStation(rig.stationId);
    for (let i = 0; i < 3; i += 1) engine.tick(rig.stationId);
    await engine.settle();

    const json = JSON.parse(JSON.stringify(engine.createSnapshot()));
    const reopened = await ExperimentEngine.replay(json, createDeps());

    expect(reopened.getScene().connections).toEqual(engine.getScene().connections);
    expect(reopened.getScene().containerStates).toEqual(engine.getScene().containerStates);
    expect(reopened.getScene().apparatus).toHaveLength(engine.getScene().apparatus.length);
  });

  it('two stations run independently: pausing one does not affect the other', () => {
    const engine = createEngine();
    const rigA = assembleTitrationStation(engine, 'Station A');
    const rigB = assembleTitrationStation(engine, 'Station B');
    fillTitrationRig(engine, rigA);
    fillTitrationRig(engine, rigB);
    engine.dispatchOrThrow(buildSetValveAction(rigA.buretteId, 1));
    engine.dispatchOrThrow(buildSetValveAction(rigB.buretteId, 1));
    engine.resumeStation(rigA.stationId);
    engine.resumeStation(rigB.stationId);

    engine.pauseStation(rigA.stationId);
    engine.tick(rigA.stationId);
    engine.tick(rigB.stationId);

    expect(engine.getScene().containerStates[rigA.buretteId]!.volumeL).toBeCloseTo(0.05, 12); // untouched: paused
    expect(engine.getScene().containerStates[rigB.buretteId]!.volumeL).toBeLessThan(0.05); // ran: not paused
  });

  it('an invalid ATTACH is rejected transparently without mutating scene state', () => {
    const engine = createEngine();
    const stationId = engine.createStation('Station 1');
    const benchId = generateUUID();
    const clampId = generateUUID();
    engine.dispatchOrThrow(buildPlaceAction(benchId, 'bench.standard', stationId, ORIGIN_TRANSFORM));
    engine.dispatchOrThrow(buildPlaceAction(clampId, 'clamp.burette.standard', stationId, ORIGIN_TRANSFORM));

    expect(engine.getStationSupport(stationId).supported).toBe(false);
    const sceneBefore = engine.getScene();
    const record = engine.dispatch(buildAttachAction(benchId, 'surface', clampId, 'bore'));
    expect(record.outcome).toBe('REJECTED');
    expect(record.rejectionReason).toBeTruthy();
    expect(engine.getScene()).toBe(sceneBefore); // same object reference: nothing was touched
  });

  it('getStationSupport flips to supported once a titrant source and receiver are connected', () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    expect(engine.getStationSupport(rig.stationId).supported).toBe(true);
  });

  it('duplicateStation copies the apparatus graph and contents into a new, independent station', () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    engine.dispatchOrThrow(buildFillAction(rig.flaskId, HCL_25ML_0_1M));

    const newStationId = engine.duplicateStation(rig.stationId);
    const scene = engine.getScene();
    const newInstances = scene.apparatus.filter((a) => a.stationId === newStationId);
    expect(newInstances).toHaveLength(7);
    for (const instance of newInstances) {
      expect(scene.apparatus.some((other) => other.stationId === rig.stationId && other.id === instance.id)).toBe(false);
    }
    const newFlask = newInstances.find((i) => i.definitionId === 'flask.conical.250ml')!;
    expect(scene.containerStates[newFlask.id]!.volumeL).toBeCloseTo(0.025, 9);
    expect(scene.containerStates[rig.flaskId]!.volumeL).toBeCloseTo(0.025, 9); // original untouched
  });

  it('publishes an event stream: ACTION_RECORDED then OBSERVATION_RECORDED with the same data a consumer would read back', async () => {
    const engine = createEngine();
    const rig = assembleTitrationStation(engine, 'Station 1');
    const events: EngineEvent[] = [];
    const unsubscribe = engine.subscribe((event) => events.push(event));

    engine.dispatchOrThrow(buildFillAction(rig.flaskId, HCL_25ML_0_1M));
    await engine.settle();
    unsubscribe();

    expect(events.some((e) => e.kind === 'ACTION_RECORDED')).toBe(true);
    const observationEvent = events.find((e) => e.kind === 'OBSERVATION_RECORDED');
    expect(observationEvent).toBeDefined();
    if (observationEvent?.kind === 'OBSERVATION_RECORDED') {
      expect(observationEvent.apparatusId).toBe(rig.flaskId);
      const latest = engine.getLatestObservation(rig.flaskId, 'PH');
      expect(latest).toEqual(observationEvent.observations[observationEvent.observations.length - 1]);
    }
  });
});
