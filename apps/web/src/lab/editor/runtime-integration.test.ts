import { describe, expect, it } from 'vitest';
import { parseExperimentScene, parseLabJson, serializeLabContract } from '@matterlab/contracts/lab';
import type { ContainerContents, ExperimentScene, RuntimeSnapshot } from '@matterlab/contracts/lab';
import {
  createStandardLabRuntime, restoreLabRuntime, standardRuntimeDependencies, validateConnection,
} from '../../../../../packages/lab-runtime/src/index.ts';
import { prepareSolution, SCIENCE_METHOD_ID } from '../../../../../packages/lab-science/src/index.ts';
import { apparatusRegistry } from '../apparatus/registry';
import { createTitrationSetup } from '../apparatus/seeds';
import { createLabCameraController } from '../environment/CameraController';
import { createFloorSurface } from '../environment/coordinates';
import { createLabEditorController } from './LabEditorController';
import type { LabEditorController } from './LabEditorController';

function ids(start = 1) {
  let next = start;
  return () => `20000000-0000-4000-8000-${(next++).toString(16).padStart(12, '0')}`;
}
function preparation(reagentId: 'hcl' | 'naoh', volumeL: number) {
  const result = prepareSolution({ reagentId, volumeL, concentrationMolL: 0.1, temperatureK: 298.15, mixing: 'WELL_MIXED' });
  if (result.status !== 'SUCCEEDED') throw new Error(result.error.detail);
  return { contents: result.contents, sourceId: result.sourceIds[0] };
}
async function placed(editor: LabEditorController, definitionId: string, xM: number, zM: number): Promise<string> {
  expect(editor.beginPlacement(definitionId), editor.getSnapshot().feedback.message).toBe(true);
  const surface = editor.getSurfaces().find((item) => item.kind === 'tabletop' && item.stationId === editor.getSnapshot().activeStationId)!;
  expect(editor.previewPlacementOnSurface(surface.id, xM, zM), editor.getSnapshot().feedback.message).toBe(true);
  const applied = await editor.commitPreview();
  expect(applied, editor.getSnapshot().feedback.message).toBe(true);
  return editor.getSnapshot().selectedIds[0];
}
async function mounted(editor: LabEditorController, definitionId: string, parentId: string, socketId: string): Promise<string> {
  expect(editor.beginPlacement(definitionId)).toBe(true);
  expect(editor.previewPlacementOnSocket({ instanceId: parentId, socketId }), editor.getSnapshot().feedback.message).toBe(true);
  const applied = await editor.commitPreview();
  expect(applied, editor.getSnapshot().feedback.message).toBe(true);
  return editor.getSnapshot().selectedIds[0];
}
function totalComponents(contents: readonly ContainerContents[]): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const content of contents) for (const component of content.species) {
    amounts[component.speciesId] = (amounts[component.speciesId] ?? 0) + component.moles;
  }
  return amounts;
}
function currentPH(snapshot: RuntimeSnapshot, stationId: string, apparatusId: string) {
  return snapshot.observations.filter((record) => record.stationId === stationId &&
    record.epoch === snapshot.stationStates[stationId].epoch &&
    record.observation.apparatusId === apparatusId && record.observation.type === 'PH').at(-1)!;
}

describe('real editor → Agent07 runtime → Agent06 chemistry integration (CPU, no browser)', () => {
  it('assembles from empty workbenches, undoes/replays an atomic mount, fills through actions, titrates to equivalence and reopens deterministically', async () => {
    const createId = ids();
    const { scene: seed, ids: seedIds } = createTitrationSetup(SCIENCE_METHOD_ID, createId);
    const initialScene = parseExperimentScene({
      ...seed, apparatus: seed.apparatus.filter((instance) => instance.kind === 'BENCH'), connections: [],
      // The runtime suite covers 250 × 0.1 s; keep this editor replay regression compact.
      simulationConfig: { ...seed.simulationConfig, timeStepS: 1 },
    });
    const runtime = await createStandardLabRuntime({ initialScene, runId: createId(), definitions: apparatusRegistry });
    let inFlightTick: Promise<unknown> = Promise.resolve();
    const editor = createLabEditorController({
      runtime, definitions: apparatusRegistry, validateConnection, camera: createLabCameraController({ reducedMotion: true }),
      surfaces: [createFloorSurface(9, 7)], dispatchBatch: (actions) => runtime.dispatchBatch(actions), idFactory: createId,
      beforeCommand: async () => { await inFlightTick; },
    });
    try {
      const stand = await placed(editor, 'retort-stand', -0.45, 0);
      const clamp = await mounted(editor, 'burette-clamp', stand, 'clamp-mount');
      expect(await editor.undo(), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.reader.getSnapshot().scene.apparatus.some((instance) => instance.id === clamp)).toBe(false);
      expect(await editor.redo(), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.reader.getSnapshot().scene.apparatus.some((instance) => instance.id === clamp)).toBe(true);
      const burette = await mounted(editor, 'burette-50ml', clamp, 'barrel-grip');
      const stirrer = await placed(editor, 'magnetic-stirrer', -0.13, 0);
      const flask = await mounted(editor, 'conical-flask-250ml', stirrer, 'platform');
      expect(await editor.connect({ instanceId: burette, socketId: 'outlet' }, { instanceId: flask, socketId: 'inlet' }),
        editor.getSnapshot().feedback.message).toBe(true);
      expect(await editor.connect({ instanceId: stirrer, socketId: 'stir-control' }, { instanceId: flask, socketId: 'stir-control' }),
        editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.getModelSupport(seedIds.stationId).status).toBe('UNSUPPORTED');
      const acid = preparation('hcl', 0.025);
      const base = preparation('naoh', 0.05);
      expect(await editor.fill(flask, acid.contents, acid.sourceId), editor.getSnapshot().feedback.message).toBe(true);
      expect(await editor.fill(burette, base.contents, base.sourceId), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.getModelSupport(seedIds.stationId).status).toBe('SUPPORTED');
      expect(editor.getSnapshot().canUndo).toBe(false);
      const initialInventory = [acid.contents, base.contents];
      const beforeComponents = totalComponents(initialInventory);
      const blankBefore = runtime.reader.getSnapshot().stationStates[seedIds.blankStationId];
      expect(await editor.startStirrer(stirrer, true, 8), editor.getSnapshot().feedback.message).toBe(true);
      editor.previewValve(burette, 1);
      expect(await editor.commitPreview(), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.reader.getSnapshot().apparatusStates[burette].valveOpeningFraction).toBe(1);
      expect(await editor.controlStation('RESUME'), editor.getSnapshot().feedback.message).toBe(true);
      inFlightTick = runtime.advanceStation(seedIds.stationId, 1);
      expect(await editor.setValve(burette, 0), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.reader.getSnapshot().stationStates[seedIds.stationId].simulationTimeS).toBe(1);
      expect(runtime.reader.getSnapshot().apparatusStates[burette].valveOpeningFraction).toBe(0);
      expect(await editor.setValve(burette, 1)).toBe(true);
      await runtime.advanceStation(seedIds.stationId, 24);
      expect(await editor.controlStation('PAUSE')).toBe(true);
      const snapshot = runtime.reader.getSnapshot();
      const source = snapshot.scene.containerStates[burette];
      const receiver = snapshot.scene.containerStates[flask];
      expect(source.volumeL).toBeCloseTo(0.025, 12);
      expect(receiver.volumeL).toBeCloseTo(0.05, 12);
      expect(source.volumeL + receiver.volumeL).toBeCloseTo(0.075, 12);
      const afterComponents = totalComponents([source, receiver]);
      expect(Object.keys(afterComponents).sort()).toEqual(Object.keys(beforeComponents).sort());
      for (const [speciesId, amount] of Object.entries(beforeComponents)) expect(afterComponents[speciesId]).toBeCloseTo(amount, 12);
      const ph = currentPH(snapshot, seedIds.stationId, flask);
      expect(ph.observation.quantity.unit).toBe('pH');
      expect(ph.observation.quantity.value).toBeCloseTo(7, 5);
      expect(ph.observation.evidence).toBe('MODEL_CALCULATED');
      expect(ph.observation.methodId).toBe(SCIENCE_METHOD_ID);
      expect(ph.observation.sourceIds.length).toBeGreaterThan(0);
      expect(snapshot.stationStates[seedIds.blankStationId]).toEqual(blankBefore);
      expect(await editor.undo()).toBe(false);

      const metadata = editor.serialize();
      const checkpoint = await runtime.getCheckpoint();
      const reopened = await restoreLabRuntime(parseLabJson('RuntimeCheckpoint', serializeLabContract('RuntimeCheckpoint', checkpoint)),
        standardRuntimeDependencies(apparatusRegistry));
      const reopenedEditor = createLabEditorController({
        runtime: reopened, definitions: apparatusRegistry, validateConnection, camera: createLabCameraController(),
        surfaces: [createFloorSurface(9, 7)], dispatchBatch: (actions) => reopened.dispatchBatch(actions), idFactory: createId,
      });
      try {
        expect(serializeLabContract('RuntimeSnapshot', reopened.reader.getSnapshot())).toBe(serializeLabContract('RuntimeSnapshot', snapshot));
        expect(reopenedEditor.restore(metadata)).toBe(true);
        expect(reopenedEditor.getSnapshot().selectedIds).toEqual(editor.getSnapshot().selectedIds);
        const epoch = reopened.reader.getSnapshot().stationStates[seedIds.stationId].epoch;
        expect(await reopenedEditor.resetStation(), reopenedEditor.getSnapshot().feedback.message).toBe(true);
        const reset = reopened.reader.getSnapshot();
        expect(reset.stationStates[seedIds.stationId].epoch).toBe(epoch + 1);
        expect(reset.scene.apparatus.filter((instance) => instance.stationId === seedIds.stationId)).toHaveLength(1);
        expect(reset.scene.containerStates[flask]).toBeUndefined();
        expect(reset.observations.some((record) => record.id === ph.id)).toBe(true);
      } finally { reopenedEditor.dispose(); reopened.dispose(); }
    } finally { editor.dispose(); runtime.dispose(); }
  }, 60_000);

  it('duplicates a full station into available room space and edits/runs both experiment inventories independently', async () => {
    const createId = ids(20_000);
    const { scene, ids: originalIds } = createTitrationSetup(SCIENCE_METHOD_ID, createId);
    const sourceRuntime = await createStandardLabRuntime({ initialScene: scene, runId: createId(), definitions: apparatusRegistry });
    let proposal: ExperimentScene | undefined;
    const sourceEditor = createLabEditorController({
      runtime: sourceRuntime, definitions: apparatusRegistry, validateConnection, camera: createLabCameraController(), surfaces: [createFloorSurface(9, 7)],
      dispatchBatch: (actions) => sourceRuntime.dispatchBatch(actions), idFactory: createId,
      onDuplicateStation: (next) => { proposal = next; },
    });
    try {
      expect(await sourceEditor.duplicateStation(), sourceEditor.getSnapshot().feedback.message).toBe(true);
      expect(sourceRuntime.reader.getSnapshot().scene.stations).toHaveLength(2);
    } finally { sourceEditor.dispose(); sourceRuntime.dispose(); }
    const duplicateId = proposal!.stations[2].id;
    const duplicated = proposal!.apparatus.filter((instance) => instance.stationId === duplicateId);
    const duplicateBurette = duplicated.find((instance) => instance.kind === 'BURETTE')!;
    const duplicateFlask = duplicated.find((instance) => instance.kind === 'FLASK')!;
    const duplicateBottle = duplicated.find((instance) => instance.definitionId === 'reagent-bottle-250ml')!;
    const duplicateBench = duplicated.find((instance) => instance.kind === 'BENCH')!;
    expect(Math.abs(duplicateBench.transform.positionM[0]) + 1.2).toBeLessThanOrEqual(4.5);
    expect(proposal!.containerStates[duplicateFlask.id]).toBeUndefined();
    const runtime = await createStandardLabRuntime({ initialScene: proposal!, runId: createId(), definitions: apparatusRegistry });
    const editor = createLabEditorController({
      runtime, definitions: apparatusRegistry, validateConnection, camera: createLabCameraController(), surfaces: [createFloorSurface(9, 7)],
      dispatchBatch: (actions) => runtime.dispatchBatch(actions), idFactory: createId,
    });
    try {
      const originalBottle = runtime.reader.getSnapshot().scene.apparatus.find((instance) => instance.id === originalIds.bottleId)!;
      editor.select([duplicateBottle.id]);
      expect(await editor.translateSelection([0.05, 0, 0]), editor.getSnapshot().feedback.message).toBe(true);
      expect(runtime.reader.getSnapshot().scene.apparatus.find((instance) => instance.id === originalIds.bottleId)).toEqual(originalBottle);
      const acid = preparation('hcl', 0.025);
      const base = preparation('naoh', 0.05);
      for (const [source, receiver] of [[originalIds.buretteId, originalIds.flaskId], [duplicateBurette.id, duplicateFlask.id]]) {
        expect(await editor.fill(source, base.contents, base.sourceId)).toBe(true);
        expect(await editor.fill(receiver, acid.contents, acid.sourceId)).toBe(true);
      }
      expect(await editor.setValve(originalIds.buretteId, 0.25)).toBe(true);
      expect(await editor.setValve(duplicateBurette.id, 0.5)).toBe(true);
      editor.setActiveStation(originalIds.stationId);
      expect(await editor.controlStation('RESUME')).toBe(true);
      await runtime.advanceStation(originalIds.stationId, 20);
      const first = runtime.reader.getSnapshot();
      expect(first.scene.containerStates[originalIds.flaskId].volumeL).toBeCloseTo(0.0255, 12);
      expect(first.scene.containerStates[duplicateFlask.id].volumeL).toBe(0.025);
      expect(first.stationStates[duplicateId].simulationTimeS).toBe(0);
      editor.setActiveStation(duplicateId);
      expect(await editor.controlStation('RESUME')).toBe(true);
      await runtime.advanceStation(duplicateId, 20);
      const second = runtime.reader.getSnapshot();
      expect(second.scene.containerStates[duplicateFlask.id].volumeL).toBeCloseTo(0.026, 12);
      expect(second.scene.containerStates[originalIds.flaskId]).toEqual(first.scene.containerStates[originalIds.flaskId]);
      expect(second.stationStates[originalIds.stationId].simulationTimeS).toBe(first.stationStates[originalIds.stationId].simulationTimeS);
      expect(currentPH(second, duplicateId, duplicateFlask.id).observation.evidence).toBe('MODEL_CALCULATED');
      expect(currentPH(second, originalIds.stationId, originalIds.flaskId).id).toBe(currentPH(first, originalIds.stationId, originalIds.flaskId).id);
    } finally { editor.dispose(); runtime.dispose(); }
  }, 20_000);
});
