/**
 * Test-only helpers that assemble the Section 6 vertical slice (bench → stand → clamp → burette →
 * flask, plus stirrer and pH probe) through the same `dispatch`/`ExperimentEngine` path real
 * callers use — never by hand-constructing an `ExperimentScene` object, so these fixtures exercise
 * (and would fail with) the same validation production code runs through.
 */
import type { ExperimentScene, Transform, UUID } from '@matterlab/contracts';
import { DEFAULT_SIMULATION_TIME_STEP_S } from '@matterlab/contracts';
import { buildAttachAction, buildPlaceAction } from '../runtime/actions';
import type { ExperimentEngine } from '../runtime/engine';
import { generateUUID } from '../runtime/ids';
import {
  BENCH_DEFINITION,
  BURETTE_DEFINITION,
  CLAMP_DEFINITION,
  FLASK_DEFINITION,
  PH_PROBE_DEFINITION,
  STAND_DEFINITION,
  STIRRER_DEFINITION,
} from '../registry/verticalSliceDefinitions';

export const ORIGIN_TRANSFORM: Transform = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] };

export function buildEmptyExperimentScene(timeStepS: number = DEFAULT_SIMULATION_TIME_STEP_S): ExperimentScene {
  return {
    id: generateUUID(),
    revision: 0,
    schemaVersion: 1,
    stations: [],
    apparatus: [],
    connections: [],
    containerStates: {},
    simulationConfig: { methodId: 'fixed-tick-v1', timeStepS },
  };
}

export interface TitrationRigIds {
  readonly stationId: UUID;
  readonly benchId: UUID;
  readonly standId: UUID;
  readonly clampId: UUID;
  readonly buretteId: UUID;
  readonly flaskId: UUID;
  readonly stirrerId: UUID;
  readonly probeId: UUID;
}

/**
 * Places and connects one full titration rig in a brand new station and returns every instance id.
 * Leaves the burette and flask empty (valve closed) — callers `FILL` and `SET_VALVE` themselves so
 * each test controls its own starting concentrations.
 */
export function assembleTitrationStation(engine: ExperimentEngine, stationName = 'Station 1'): TitrationRigIds {
  const stationId = engine.createStation(stationName);
  const place = (definitionId: string): UUID => {
    const id = generateUUID();
    engine.dispatchOrThrow(buildPlaceAction(id, definitionId, stationId, ORIGIN_TRANSFORM));
    return id;
  };

  const benchId = place(BENCH_DEFINITION.id);
  const standId = place(STAND_DEFINITION.id);
  const clampId = place(CLAMP_DEFINITION.id);
  const buretteId = place(BURETTE_DEFINITION.id);
  const flaskId = place(FLASK_DEFINITION.id);
  const stirrerId = place(STIRRER_DEFINITION.id);
  const probeId = place(PH_PROBE_DEFINITION.id);

  engine.dispatchOrThrow(buildAttachAction(standId, 'foot', benchId, 'surface'));
  engine.dispatchOrThrow(buildAttachAction(clampId, 'grip', standId, 'pole'));
  engine.dispatchOrThrow(buildAttachAction(buretteId, 'barrel', clampId, 'bore'));
  engine.dispatchOrThrow(buildAttachAction(buretteId, 'tip', flaskId, 'mouth'));
  engine.dispatchOrThrow(buildAttachAction(flaskId, 'base', stirrerId, 'platform'));
  engine.dispatchOrThrow(buildAttachAction(probeId, 'grip', standId, 'pole'));
  engine.dispatchOrThrow(buildAttachAction(probeId, 'tip', flaskId, 'probePort'));

  return { stationId, benchId, standId, clampId, buretteId, flaskId, stirrerId, probeId };
}
