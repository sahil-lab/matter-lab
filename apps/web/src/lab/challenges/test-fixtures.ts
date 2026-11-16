import type { LabRuntimeEvent, LabRuntimeReader, ModelSupport, RuntimeSnapshot } from '@matterlab/contracts';
import { getTitrationReference, prepareSolution, SCIENCE_METHOD_ID } from '@matterlab/lab-science';
import { apparatusRegistry } from '../apparatus/registry.ts';
import { createTitrationSetup } from '../apparatus/seeds.ts';
import { createChallengeController } from './controller.ts';
import { TITRATION_CHALLENGE } from './definition.ts';
import { createLearningReference } from './reference.ts';
import type { ChallengeMode } from './types.ts';

export function idFactory(start = 1): () => string {
  let id = start;
  return () => `00000000-0000-4000-8000-${(id++).toString(16).padStart(12, '0')}`;
}

export function preparedReference() {
  const aliquot = prepareSolution({ reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 });
  const titrant = prepareSolution({ reagentId: 'naoh', volumeL: 0.05, concentrationMolL: 0.1 });
  const truth = getTitrationReference({
    analyte: { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 },
    titrantReagentId: 'naoh', titrantConcentrationMolL: 0.1, deliveredVolumeL: 0,
  });
  if (aliquot.status !== 'SUCCEEDED' || titrant.status !== 'SUCCEEDED' || truth.status !== 'SUCCEEDED') throw new Error('Science fixture was not supported.');
  const reference = createLearningReference({
    id: 'hcl-naoh-known-aliquot', result: truth,
    preparations: [
      { role: 'receiver', label: '25.00 mL known HCl aliquot', sourceId: 'hcl', result: aliquot },
      { role: 'burette', label: '50.00 mL known NaOH titrant', sourceId: 'naoh', result: titrant },
    ],
  });
  return { reference, aliquot, titrant, truth };
}

export class TestReader implements LabRuntimeReader {
  snapshot: RuntimeSnapshot;
  readonly listeners = new Set<(snapshot: RuntimeSnapshot, event: LabRuntimeEvent) => void>();
  constructor(snapshot: RuntimeSnapshot) { this.snapshot = snapshot; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: (snapshot: RuntimeSnapshot, event: LabRuntimeEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(snapshot: RuntimeSnapshot, event: LabRuntimeEvent): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener(snapshot, event));
  }
}

export function createEmptyHarness(mode: ChallengeMode = 'guided') {
  const makeId = idFactory();
  const { scene, ids } = createTitrationSetup(SCIENCE_METHOD_ID, makeId);
  const snapshot: RuntimeSnapshot = {
    schemaVersion: 1, runId: makeId(), revision: 0, scene,
    stationStates: Object.fromEntries(scene.stations.map((station) => [station.id, {
      stationId: station.id, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1,
    }])),
    apparatusStates: {}, transferTotals: [], observations: [], lastSequence: 0,
  };
  const reader = new TestReader(snapshot);
  const { reference, aliquot, titrant, truth } = preparedReference();
  const support: ModelSupport = { status: 'SUPPORTED', reasons: [], methodId: SCIENCE_METHOD_ID };
  const options = {
    reader, definitions: apparatusRegistry, definition: TITRATION_CHALLENGE, stationId: ids.stationId, reference,
    bindings: { stand: ids.standId, clamp: ids.clampId, burette: ids.buretteId, receiver: ids.flaskId, probe: ids.probeId },
    createId: makeId, now: () => '2026-11-16T12:00:00.000Z', getSupport: () => support, mode,
  };
  return { reader, controller: createChallengeController(options), options, ids, makeId, reference, aliquot, titrant, truth };
}
