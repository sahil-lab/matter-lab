import type { ApparatusInstance, LabAction, LabActionPayloads, LabActionType, RuntimeSnapshot } from '@matterlab/contracts';
import { createAqueousExperimentPlugin, standardRuntimeDependencies, validateConnection } from '@matterlab/lab-runtime';
import { getTitrationReference, prepareSolution, SCIENCE_METHOD_ID } from '@matterlab/lab-science';
import { Vector3, Quaternion } from 'three';
import { apparatusRegistry, APPARATUS_DEFINITIONS } from './apparatus/registry';
import { createTitrationSetup } from './apparatus/seeds';
import { createChallengeController, createLearningReference, TITRATION_CHALLENGE } from './challenges';
import type { ChallengeController, ChallengeMode, LearningState } from './challenges/types';
import { createLabEditorController } from './editor';
import { createFloorSurface, createLabCameraController, DEFAULT_CAMERA_VIEW } from './environment';
import { createBrowserLabRuntime, createSimulationClock } from './experiments';
import { connectTransferPresentation, createTransferPresentation, calibratedHeightM } from './fluids';
import { LocalDraftCache, localDraft } from './persistence/drafts';
import type { SceneDraft } from './persistence/types';

export const PREPARATION = Object.freeze({ volumeL: 0.025, concentrationMolL: 0.1, temperatureK: 298.15, mixing: 'WELL_MIXED' as const });
export const REFERENCE_TITRATION = getTitrationReference({
  analyte: { ...PREPARATION, reagentId: 'hcl' }, titrantReagentId: 'naoh',
  titrantConcentrationMolL: 0.1, deliveredVolumeL: 0, indicatorId: 'phenolphthalein', endpointBaseFraction: 0.1,
});
const acid = prepareSolution({ ...PREPARATION, reagentId: 'hcl' });
const base = prepareSolution({ ...PREPARATION, reagentId: 'naoh', volumeL: 0.05 });
const learningReference = createLearningReference({
  id: 'hcl-naoh-25ml-ideal-298.15-v1', result: REFERENCE_TITRATION,
  preparations: [
    { role: 'receiver', label: '25.00 mL of 0.100 mol/L HCl', sourceId: 'hcl', result: acid },
    { role: 'burette', label: '50.00 mL of 0.100 mol/L NaOH', sourceId: 'naoh', result: base },
  ],
});
const LAST_DRAFT = 'matterlab:lab:last-draft:v1';

export function createLaboratoryDraft(empty = false): SceneDraft {
  const { scene } = createTitrationSetup(SCIENCE_METHOD_ID);
  return {
    title: empty ? 'Custom laboratory' : 'Acid-base titration',
    scene: empty ? { ...scene, apparatus: scene.apparatus.filter((instance) => instance.kind === 'BENCH'), connections: [] } : scene,
    runtimeCheckpoint: null,
  };
}

export function readLastLaboratoryDraft(): SceneDraft | null {
  const id = localStorage.getItem(LAST_DRAFT);
  return id ? new LocalDraftCache(localStorage, 'local-device').read(id) : null;
}

export function storeLaboratoryDraft(draft: SceneDraft, revision: number | null): void {
  const record = localDraft(draft, revision);
  new LocalDraftCache(localStorage, 'local-device').write(record);
  localStorage.setItem(LAST_DRAFT, record.scene.id);
}

export function stationRoles(snapshot: RuntimeSnapshot, stationId: string) {
  const instances = snapshot.scene.apparatus.filter((instance) => instance.stationId === stationId);
  const unique = (predicate: (instance: ApparatusInstance) => boolean): ApparatusInstance | undefined => {
    const candidates = instances.filter(predicate);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const burette = unique((instance) => instance.kind === 'BURETTE');
  const receivers = snapshot.scene.connections.filter((edge) => edge.kind === 'FLUID' && edge.enabled && edge.from.instanceId === burette?.id);
  const receiver = receivers.length === 1
    ? instances.find((instance) => instance.id === receivers[0]!.to.instanceId)
    : unique((instance) => instance.kind === 'FLASK');
  return { burette, receiver, probe: unique((instance) => instance.kind === 'PH_PROBE'), stirrer: unique((instance) => instance.kind === 'STIRRER') };
}

export type LaboratorySession = Awaited<ReturnType<typeof createLaboratorySession>>;

export async function createLaboratorySession(
  draft: SceneDraft,
  onProblem: (message: string) => void,
  onReplace: (draft: SceneDraft) => Promise<void>,
) {
  const runtime = await createBrowserLabRuntime({
    initialScene: draft.scene,
    runId: draft.runtimeCheckpoint?.snapshot.runId ?? crypto.randomUUID(),
    definitions: APPARATUS_DEFINITIONS,
    ...(draft.runtimeCheckpoint ? { checkpoint: draft.runtimeCheckpoint } : {}),
  });
  let disposed = false;
  const camera = createLabCameraController({
    initialView: { ...DEFAULT_CAMERA_VIEW, positionM: [1.1, 1.7, 1.85], targetM: [-0.12, 1.19, 0] },
  });
  const clock = createSimulationClock(runtime, (error) => onProblem(error.detail));
  let commandTail: Promise<void> = Promise.resolve();
  const beforeCommand = async () => {
    let unlock!: () => void;
    const prior = commandTail;
    commandTail = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    try {
      await clock.stop();
      if (disposed) throw new Error('This laboratory session has closed.');
    } catch (error) {
      unlock();
      throw error;
    }
    return () => {
      if (!disposed && Object.values(runtime.reader.getSnapshot().stationStates).some((station) => station.status === 'RUNNING')) clock.start();
      unlock();
    };
  };
  const exclusive = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const release = await beforeCommand();
    try { return await operation(); } finally { release(); }
  };
  const plugin = createAqueousExperimentPlugin(standardRuntimeDependencies(apparatusRegistry).science);
  const challenges = new Map<string, ChallengeController>();
  for (const station of draft.scene.stations) {
    const attempt = draft.learningState?.attempts.find((entry) => entry.trials.some((trial) => trial.scope.runId === runtime.reader.getSnapshot().runId && trial.scope.stationId === station.id));
    challenges.set(station.id, createChallengeController({
      reader: runtime.reader, definitions: apparatusRegistry, definition: TITRATION_CHALLENGE,
      stationId: station.id, reference: learningReference, mode: attempt?.mode ?? 'guided', attempt,
      getSupport: (snapshot, id) => plugin.getSupport(snapshot.scene, id, apparatusRegistry),
    }));
  }
  const presentation = createTransferPresentation(runtime.reader.getSnapshot());
  const unsubscribeTransfers = connectTransferPresentation(runtime.reader, presentation);
  const editor = createLabEditorController({
    runtime, definitions: apparatusRegistry, camera, surfaces: [createFloorSurface(12, 9)],
    dispatchBatch: runtime.dispatchBatch, validateConnection, beforeCommand,
    onDuplicateStation: async (scene) => {
      storeLaboratoryDraft(await captureDraft(), null);
      await onReplace({ title: `${draft.title} - expanded`, scene, runtimeCheckpoint: null });
    },
    onReplay: async () => onReplace(await captureDraft()),
  });
  if (draft.editorState && !editor.restore(draft.editorState)) onProblem(editor.getSnapshot().feedback.message);

  async function snapshotDraft(title = draft.title): Promise<SceneDraft> {
    return exclusive(() => captureDraft(title));
  }
  async function captureDraft(title = draft.title): Promise<SceneDraft> {
    const checkpoint = await runtime.getCheckpoint();
    const attempts = [...challenges.values()].map((controller) => controller.exportAttempt());
    const learningState: LearningState = { kind: 'MATTERLAB_LEARNING_STATE', schemaVersion: 1, attempts };
    return { title, scene: checkpoint.snapshot.scene, runtimeCheckpoint: checkpoint, editorState: editor.serialize(), learningState };
  }
  const action = <Type extends LabActionType>(target: string, type: Type, payload: LabActionPayloads[Type]): LabAction => {
    const snapshot = runtime.reader.getSnapshot();
    const instance = snapshot.scene.apparatus.find((candidate) => candidate.id === target);
    if (!instance) throw new Error('The selected apparatus no longer exists.');
    const station = snapshot.stationStates[instance.stationId]!;
    // Parsing in the authoritative runtime verifies this discriminated payload before any state change.
    return { actionId: crypto.randomUUID(), targetInstanceId: target, type, payload, atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch } as LabAction;
  };
  async function apply<Type extends LabActionType>(target: string, type: Type, payload: LabActionPayloads[Type]) {
    const receipt = await runtime.actions.dispatch(action(target, type, payload));
    if (receipt.status === 'REJECTED') throw new Error(receipt.error.detail);
  }
  async function pauseAll() {
    await exclusive(async () => {
      for (const station of Object.values(runtime.reader.getSnapshot().stationStates)) {
        if (station.status !== 'RUNNING') continue;
        const receipt = await runtime.actions.control({
          controlId: crypto.randomUUID(), stationId: station.stationId, type: 'PAUSE', payload: {},
          atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch,
        });
        if (receipt.status === 'REJECTED') throw new Error(receipt.error.detail);
      }
    });
  }
  if (draft.runtimeCheckpoint) await pauseAll();

  return {
    runtime, camera, clock, editor, challenges, presentation, exclusive, snapshotDraft, pauseAll,
    getSupport: (stationId: string) => plugin.getSupport(runtime.reader.getSnapshot().scene, stationId, apparatusRegistry),
    setMode(mode: ChallengeMode) { for (const controller of challenges.values()) controller.setMode(mode); },
    async prepareReference(stationId: string) {
      const { receiver, burette } = stationRoles(runtime.reader.getSnapshot(), stationId);
      if (!receiver || !burette) throw new Error('Assemble one burette and one connected receiving flask first.');
      if (acid.status !== 'SUCCEEDED' || base.status !== 'SUCCEEDED') throw new Error('The reference solution preparation is unsupported.');
      await exclusive(async () => {
        await apply(receiver.id, 'FILL', { contents: acid.contents, preparation: { kind: 'INITIAL', sourceId: 'hcl' } });
        await apply(burette.id, 'FILL', { contents: base.contents, preparation: { kind: 'INITIAL', sourceId: 'naoh' } });
      });
    },
    async immerseProbe(stationId: string) {
      await exclusive(async () => {
        const snapshot = runtime.reader.getSnapshot();
        const { receiver, probe } = stationRoles(snapshot, stationId);
        if (!receiver || !probe) throw new Error('Place one pH probe and a receiving flask in this station.');
        const contents = snapshot.scene.containerStates[receiver.id];
        const definition = apparatusRegistry.getDefinition(receiver.definitionId)!;
        const calibration = definition.vesselCalibration;
        if (!contents || !calibration || contents.volumeL <= 0) throw new Error('Prepare the receiving solution before immersing the probe.');
        const tip = apparatusRegistry.getDefinition(probe.definitionId)!.sockets.find((socket) => socket.kind === 'SENSOR')!;
        const sensor = definition.sockets.find((socket) => socket.kind === 'SENSOR')!;
        const height = calibratedHeightM(calibration, contents.volumeL);
        const lower = calibration.interiorProfile[0]!.yM;
        const rotation = new Quaternion(...receiver.transform.quaternion);
        const position = new Vector3(0.009, (lower + height) / 2, 0).applyQuaternion(rotation).add(new Vector3(...receiver.transform.positionM))
          .sub(new Vector3(...tip.localTransform.positionM).applyQuaternion(rotation));
        await apply(probe.id, 'MOVE', { transform: { positionM: [position.x, position.y, position.z], quaternion: receiver.transform.quaternion } });
        const current = runtime.reader.getSnapshot().scene;
        const existing = current.connections.find((edge) => edge.kind === 'SENSOR' && edge.enabled && edge.from.instanceId === probe.id && edge.to.instanceId === receiver.id);
        if (!existing) await apply(probe.id, 'ATTACH', { connection: {
          id: crypto.randomUUID(), kind: 'SENSOR', enabled: true,
          from: { instanceId: probe.id, socketId: tip.id }, to: { instanceId: receiver.id, socketId: sensor.id },
        } });
        await apply(probe.id, 'SET_PROBE', { containerInstanceId: receiver.id });
      });
    },
    async configureIndicator(instanceId: string, indicatorId: string) {
      await exclusive(() => apply(instanceId, 'CUSTOM', { pluginId: 'matterlab:container-config-v1', actionType: 'SET_CONFIG', data: { indicatorId } }));
    },
    async stopAndClose() {
      disposed = true;
      await clock.stop();
      editor.dispose();
      for (const controller of challenges.values()) controller.dispose();
      unsubscribeTransfers();
      presentation.dispose();
      runtime.dispose();
    },
  };
}
