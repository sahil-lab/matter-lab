/**
 * TEST-FIXTURE GENERATOR — not part of the product runtime.
 *
 * Nothing under `goals/`, `scoring/`, `hints/` or `notebook/` imports this file. It exists so this
 * surface's goal evaluator, scoring rubric, hint engine and notebook builder can be unit-tested
 * fast and deterministically without spawning Agent 06's real solver process for every assertion
 * (see `integration/pythonSolverClient.ts` for the real bridge, exercised by the slower
 * integration tests instead).
 *
 * `strongAcidStrongBasePh` is the standard closed-form charge/mass-balance solution for titrating
 * a strong monoprotic acid with a strong base, including water autoionization — the same model
 * Agent 06's real solver (`services/science/titration/equilibrium.py`) implements with a root
 * finder instead of this closed form; both reduce to the same answer for a strong-acid/strong-base
 * system (verified in `fixtures.test.ts` against the real solver bridge):
 *
 *   charge balance:  [H+] + [Na+] = [OH-] + [Cl-]
 *   mass balance:    [Cl-] = acid moles / total volume,  [Na+] = base moles / total volume
 *   =>               [H+] - [OH-] = Ca - Cb   (call this the "excess concentration")
 *   water:           [H+]·[OH-] = Kw
 *   =>               [H+] = (excess + sqrt(excess^2 + 4Kw)) / 2
 *
 * This reduces to pH 7 at equivalence (excess = 0, Kw = 1.0×10⁻¹⁴ at 25 °C).
 */

import type { ApparatusInstance, Connection, ContainerContents, ExperimentScene, LabActionType, LabEventRecord, Observation, SpeciesAmount, UUID } from '../contracts';
import type { EvaluationContext, TrialRecord } from '../goals';
import { HCL_SPECIES_ID, NAOH_SPECIES_ID, TITRATION_BENCHMARK } from '../titrationObjective';

/** Water's ion product at 25 °C; a standard reference value, not a fitted or invented number. */
const KW_25C = 1.0e-14;

export function strongAcidStrongBasePh(acidMolesInitial: number, baseMolarityMolPerL: number, baseVolumeDeliveredL: number, totalVolumeL: number): number {
  if (!(totalVolumeL > 0)) return 7;
  const baseMoles = baseMolarityMolPerL * baseVolumeDeliveredL;
  const excess = (acidMolesInitial - baseMoles) / totalVolumeL;
  const hydronium = (excess + Math.sqrt(excess * excess + 4 * KW_25C)) / 2;
  return -Math.log10(hydronium);
}

const STATION_ID: UUID = 'fixture-station-1';
const IDS = { bench: 'fixture-bench', stand: 'fixture-stand', clamp: 'fixture-clamp', burette: 'fixture-burette', flask: 'fixture-flask' } as const;

function makeInstance(id: UUID, kind: ApparatusInstance['kind'], definitionId: string, positionM: readonly [number, number, number], capabilities: ApparatusInstance['capabilities']): ApparatusInstance {
  return { id, kind, definitionId, transform: { positionM, quaternion: [0, 0, 0, 1] }, revision: 1, config: {}, capabilities, stationId: STATION_ID };
}

export interface FixtureOptions {
  readonly analyteVolumeL?: number;
  readonly analyteMolarityMolPerL?: number;
  readonly titrantMolarityMolPerL?: number;
  readonly overshootToL?: number;
  readonly markedVolumeL?: number;
  readonly coarseStepL?: number;
  readonly fineStepL?: number;
  readonly startSequence?: number;
  readonly startSimulationS?: number;
  readonly idPrefix?: string;
}

export function buildAssembledScene(options: FixtureOptions = {}): ExperimentScene {
  const analyteVolumeL = options.analyteVolumeL ?? TITRATION_BENCHMARK.aliquotVolumeL;
  const analyteMolarity = options.analyteMolarityMolPerL ?? TITRATION_BENCHMARK.aliquotMolarity;
  const titrantMolarity = options.titrantMolarityMolPerL ?? TITRATION_BENCHMARK.titrantMolarity;

  const apparatus: ApparatusInstance[] = [
    makeInstance(IDS.bench, 'BENCH', 'bench.standard', [0, 0, 0], ['MOUNT']),
    makeInstance(IDS.stand, 'STAND', 'stand.retort.standard', [0, 0, 0], ['MOUNT']),
    makeInstance(IDS.clamp, 'CLAMP', 'clamp.burette.standard', [0, 0.6, 0], ['MOUNT', 'MOUNTABLE']),
    makeInstance(IDS.burette, 'BURETTE', 'burette.class-a.50ml', [0, 0.6, 0], ['MOUNTABLE', 'FLOW_SOURCE', 'CONTAINER', 'MEASUREMENT']),
    makeInstance(IDS.flask, 'FLASK', 'flask.conical.250ml', [0, 0.08, 0], ['CONTAINER', 'FLOW_RECEIVER']),
  ];
  const connections: Connection[] = [
    { id: 'fixture-conn-clamp-stand', from: { instanceId: IDS.clamp, socketId: 'grip' }, to: { instanceId: IDS.stand, socketId: 'pole' }, kind: 'MECHANICAL', enabled: true },
    { id: 'fixture-conn-burette-clamp', from: { instanceId: IDS.burette, socketId: 'barrel' }, to: { instanceId: IDS.clamp, socketId: 'bore' }, kind: 'MECHANICAL', enabled: true },
    { id: 'fixture-conn-burette-flask', from: { instanceId: IDS.burette, socketId: 'tip' }, to: { instanceId: IDS.flask, socketId: 'mouth' }, kind: 'FLUID', enabled: true },
  ];
  const containerStates: Record<UUID, ContainerContents> = {
    [IDS.burette]: { volumeL: 0.05, species: [{ speciesId: NAOH_SPECIES_ID, moles: titrantMolarity * 0.05 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'fixture.strong-base-ideal' },
    [IDS.flask]: { volumeL: analyteVolumeL, species: [{ speciesId: HCL_SPECIES_ID, moles: analyteMolarity * analyteVolumeL }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'fixture.strong-acid-ideal' },
  };
  return {
    id: 'fixture-scene-1',
    revision: 1,
    schemaVersion: 1,
    stations: [{ id: STATION_ID, name: 'Fixture station' }],
    apparatus,
    connections,
    containerStates,
    simulationConfig: { methodId: 'fixture.strong-acid-strong-base-ideal', timeStepS: 0.1 },
  };
}

function buildIncrements(equivalenceL: number, overshootToL: number, coarseStepL: number, fineStepL: number): number[] {
  const increments: number[] = [];
  let delivered = 0;
  const fineBand = equivalenceL * 0.15;
  let guard = 0;
  while (delivered < overshootToL - 1e-9 && guard < 10_000) {
    guard += 1;
    const remaining = overshootToL - delivered;
    const near = Math.abs(delivered - equivalenceL) <= fineBand || Math.abs(delivered + coarseStepL - equivalenceL) <= fineBand;
    const step = Math.min(remaining, near ? fineStepL : coarseStepL);
    increments.push(step);
    delivered += step;
  }
  return increments;
}

export interface FixtureEventLog {
  readonly events: LabEventRecord[];
  readonly observations: Observation[];
  readonly markedVolumeL: number;
  readonly equivalenceVolumeL: number;
  readonly nextSequence: number;
  readonly nextSimulationS: number;
}

/** Builds one complete, internally-consistent titration event log: assembly, fills, transfers, observations and an endpoint mark, shaped exactly like Agent 07's real `LabEventRecord`/`Observation`. */
export function buildTitrationEventLog(options: FixtureOptions = {}): FixtureEventLog {
  const analyteVolumeL = options.analyteVolumeL ?? TITRATION_BENCHMARK.aliquotVolumeL;
  const analyteMolarity = options.analyteMolarityMolPerL ?? TITRATION_BENCHMARK.aliquotMolarity;
  const titrantMolarity = options.titrantMolarityMolPerL ?? TITRATION_BENCHMARK.titrantMolarity;
  const equivalenceVolumeL = (analyteMolarity * analyteVolumeL) / titrantMolarity;
  const overshootToL = options.overshootToL ?? equivalenceVolumeL * 1.2;
  const markedVolumeL = options.markedVolumeL ?? equivalenceVolumeL;
  const coarseStepL = options.coarseStepL ?? 0.002;
  const fineStepL = options.fineStepL ?? 0.0003;
  const idPrefix = options.idPrefix ?? 'fixture';

  let sequence = options.startSequence ?? 0;
  let atSimulationS = options.startSimulationS ?? 0;
  const events: LabEventRecord[] = [];
  const observations: Observation[] = [];
  const acidMolesInitial = analyteMolarity * analyteVolumeL;

  const applyAction = (targetInstanceId: UUID, type: LabActionType, payload: Record<string, unknown>): void => {
    const before = sequence;
    events.push({
      sequence: sequence++,
      action: { actionId: `${idPrefix}-action-${sequence}`, atSimulationS, targetInstanceId, type, payload },
      receivedAt: new Date(0).toISOString(),
      sceneRevisionBefore: before,
      sceneRevisionAfter: before + 1,
      outcome: 'APPLIED',
    });
  };

  const fillPayload = (volumeL: number, species: readonly SpeciesAmount[]): Record<string, unknown> => ({ volumeL, species, temperatureK: 298.15, modelId: 'fixture.ideal' });

  applyAction(IDS.stand, 'PLACE', { definitionId: 'stand.retort.standard', stationId: STATION_ID, transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] }, config: {} });
  applyAction(IDS.clamp, 'PLACE', { definitionId: 'clamp.burette.standard', stationId: STATION_ID, transform: { positionM: [0, 0.6, 0], quaternion: [0, 0, 0, 1] }, config: {} });
  applyAction(IDS.clamp, 'ATTACH', { socketId: 'grip', toInstanceId: IDS.stand, toSocketId: 'pole' });
  applyAction(IDS.burette, 'PLACE', { definitionId: 'burette.class-a.50ml', stationId: STATION_ID, transform: { positionM: [0, 0.6, 0], quaternion: [0, 0, 0, 1] }, config: {} });
  applyAction(IDS.burette, 'ATTACH', { socketId: 'barrel', toInstanceId: IDS.clamp, toSocketId: 'bore' });
  applyAction(IDS.flask, 'PLACE', { definitionId: 'flask.conical.250ml', stationId: STATION_ID, transform: { positionM: [0, 0.08, 0], quaternion: [0, 0, 0, 1] }, config: {} });
  applyAction(IDS.burette, 'ATTACH', { socketId: 'tip', toInstanceId: IDS.flask, toSocketId: 'mouth' });
  applyAction(IDS.burette, 'FILL', fillPayload(0.05, [{ speciesId: NAOH_SPECIES_ID, moles: titrantMolarity * 0.05 }]));
  applyAction(IDS.flask, 'FILL', fillPayload(analyteVolumeL, [{ speciesId: HCL_SPECIES_ID, moles: acidMolesInitial }]));
  applyAction(IDS.burette, 'SET_VALVE', { valveOpening: 0.3 });

  let delivered = 0;
  for (const step of buildIncrements(equivalenceVolumeL, overshootToL, coarseStepL, fineStepL)) {
    atSimulationS += 1;
    delivered += step;
    applyAction(IDS.burette, 'TRANSFER', { toInstanceId: IDS.flask, volumeL: step });
    const totalVolumeL = analyteVolumeL + delivered;
    const ph = strongAcidStrongBasePh(acidMolesInitial, titrantMolarity, delivered, totalVolumeL);
    observations.push({
      type: 'PH',
      apparatusId: IDS.flask,
      timeS: atSimulationS,
      quantity: { value: Number(ph.toFixed(3)), unit: 'pH' },
      evidence: 'MODEL_CALCULATED',
      methodId: 'fixture.strong-acid-strong-base-ideal',
      sourceIds: ['fixture:strong-acid-strong-base'],
    });
  }

  atSimulationS += 1;
  applyAction(IDS.flask, 'CUSTOM', { kind: 'MARK_ENDPOINT', deliveredVolumeL: markedVolumeL });

  return { events, observations, markedVolumeL, equivalenceVolumeL, nextSequence: sequence, nextSimulationS: atSimulationS };
}

export function buildFixtureTrial(options: FixtureOptions & { readonly trialId?: string } = {}): TrialRecord {
  const log = buildTitrationEventLog(options);
  return {
    trialId: options.trialId ?? 'fixture-trial-1',
    startedAtSimulationS: options.startSimulationS ?? 0,
    completedAtSimulationS: log.nextSimulationS,
    events: log.events,
    observations: log.observations,
    endpoint: { deliveredVolumeL: log.markedVolumeL, markedAtSimulationS: log.nextSimulationS },
  };
}

/** A full single-trial context: assembled scene + one completed titration trial. */
export function buildFixtureContext(options: FixtureOptions = {}): EvaluationContext {
  const scene = buildAssembledScene(options);
  const trial = buildFixtureTrial(options);
  return { scene, events: trial.events, observations: trial.observations, trials: [trial], nowSimulationS: trial.completedAtSimulationS };
}

/** A Precision-mode-style context with several repeat trials, each marked at a given (possibly slightly different) volume. */
export function buildPrecisionFixtureContext(markedVolumesL: readonly number[], options: FixtureOptions = {}): EvaluationContext {
  const scene = buildAssembledScene(options);
  let sequence = 0;
  let simulationS = 0;
  const allEvents: LabEventRecord[] = [];
  const allObservations: Observation[] = [];
  const trials: TrialRecord[] = markedVolumesL.map((markedVolumeL, i) => {
    const log = buildTitrationEventLog({ ...options, markedVolumeL, startSequence: sequence, startSimulationS: simulationS, idPrefix: `fixture-t${i + 1}` });
    allEvents.push(...log.events);
    allObservations.push(...log.observations);
    const trial: TrialRecord = {
      trialId: `fixture-trial-${i + 1}`,
      startedAtSimulationS: simulationS,
      completedAtSimulationS: log.nextSimulationS,
      events: log.events,
      observations: log.observations,
      endpoint: { deliveredVolumeL: markedVolumeL, markedAtSimulationS: log.nextSimulationS },
    };
    sequence = log.nextSequence;
    simulationS = log.nextSimulationS + 1;
    return trial;
  });
  return { scene, events: allEvents, observations: allObservations, trials, nowSimulationS: simulationS };
}
