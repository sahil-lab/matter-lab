import type { LabAction, ReplayStep } from './actions.ts';
import type { ApparatusDefinition, ConfigField, ConfigSchema, VesselCalibration } from './apparatus.ts';
import type { BoundsM, JsonValue, Transform, ValidationIssue } from './common.ts';
import type { JsonSchema } from './json-schema.ts';
import type { LabRuntimeEvent, NodeRunRequest, NodeRunResponse, RuntimeCheckpoint, RuntimeSnapshot } from './runtime.ts';
import type { Connection, ContainerContents, ExperimentScene } from './scene.ts';
import type { CumulativeTransfer, EquilibriumInput, Observation, ObservationRecord } from './science.ts';
import { canonicalJson, checkSchema, issue, pointer } from './schema-validation.ts';

const sameNumber = (left: number, right: number): boolean =>
  Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));

function unique(values: readonly string[], path: string, errors: ValidationIssue[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issue(errors, pointer(path, index), `Duplicate identifier ${value}.`, 'DUPLICATE_ID');
    seen.add(value);
  });
}
function contents(value: ContainerContents, path: string, errors: ValidationIssue[]): void {
  unique(value.species.map((species) => JSON.stringify([species.speciesId, species.sourceId ?? null])),
    pointer(path, 'species'), errors);
  if (value.volumeL === 0 && value.species.some((species) => species.moles > 0)) {
    issue(errors, path, 'An empty liquid container cannot contain positive dissolved inventory.');
  }
}
function connection(value: Connection, path: string, errors: ValidationIssue[]): void {
  if (value.from.instanceId === value.to.instanceId) issue(errors, path, 'An apparatus cannot connect to itself.', 'INCOMPATIBLE_SOCKET');
}
function scene(value: ExperimentScene, path: string, errors: ValidationIssue[]): void {
  unique([value.id, ...value.stations.map((station) => station.id),
    ...value.apparatus.map((apparatus) => apparatus.id), ...value.connections.map((edge) => edge.id)], path, errors);
  const stations = new Set(value.stations.map((station) => station.id));
  const apparatus = new Map(value.apparatus.map((instance) => [instance.id, instance]));
  value.apparatus.forEach((instance, index) => {
    if (!stations.has(instance.stationId)) issue(errors, `${path}/apparatus/${index}/stationId`, 'Station does not exist.', 'MISSING_REFERENCE');
  });
  const endpoints = new Set<string>();
  value.connections.forEach((edge, index) => {
    const at = `${path}/connections/${index}`;
    const from = apparatus.get(edge.from.instanceId);
    const to = apparatus.get(edge.to.instanceId);
    if (!from || !to) issue(errors, at, 'Connection endpoint does not exist.', 'MISSING_REFERENCE');
    else if (from.stationId !== to.stationId) issue(errors, at, 'Stations cannot exchange inventory or apparatus connections.', 'CROSS_STATION_CONNECTION');
    const endpointPair = [
      `${edge.from.instanceId}:${edge.from.socketId}`, `${edge.to.instanceId}:${edge.to.socketId}`,
    ].sort();
    const key = JSON.stringify([edge.kind, ...endpointPair]);
    if (endpoints.has(key)) issue(errors, at, 'Duplicate connection between these sockets.', 'DUPLICATE_ID');
    endpoints.add(key);
  });
  for (const id of Object.keys(value.containerStates)) {
    const instance = apparatus.get(id);
    if (!instance) issue(errors, pointer(`${path}/containerStates`, id), 'Container apparatus does not exist.', 'MISSING_REFERENCE');
    else if (!instance.capabilities.includes('CONTAINER')) {
      issue(errors, pointer(`${path}/containerStates`, id), 'Inventory requires the CONTAINER capability.');
    }
  }
}
function calibration(value: VesselCalibration, path: string, errors: ValidationIssue[]): void {
  const profile = value.interiorProfile;
  const curve = value.volumeHeightCurve;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i]!.yM <= profile[i - 1]!.yM) issue(errors, `${path}/interiorProfile/${i}`, 'Profile heights must strictly increase.', 'INVALID_CALIBRATION');
  }
  for (let i = 1; i < curve.length; i++) {
    if (curve[i]!.volumeL <= curve[i - 1]!.volumeL || curve[i]!.heightM <= curve[i - 1]!.heightM) {
      issue(errors, `${path}/volumeHeightCurve/${i}`, 'Calibration volumes and heights must strictly increase.', 'INVALID_CALIBRATION');
    }
  }
  if (first.volumeL !== 0 || !sameNumber(last.volumeL, value.capacityL) ||
      !sameNumber(last.heightM, value.maxFillHeightM) ||
      first.heightM < profile[0]!.yM || last.heightM > profile[profile.length - 1]!.yM) {
    issue(errors, path, 'Calibration must cover zero to capacity, end at max fill height and stay inside the profile.', 'INVALID_CALIBRATION');
  }
  const marks = value.graduations;
  if (marks) {
    const ratio = marks.majorStepL / marks.minorStepL;
    if (marks.majorStepL < marks.minorStepL || marks.majorStepL > value.capacityL ||
        !sameNumber(ratio, Math.round(ratio))) {
      issue(errors, `${path}/graduations`, 'Major steps must be integral multiples of minor steps within capacity.', 'INVALID_CALIBRATION');
    }
    if (Math.min(marks.startHeightM, marks.endHeightM) < first.heightM ||
        Math.max(marks.startHeightM, marks.endHeightM) > last.heightM ||
        (marks.direction === 'UP' ? marks.endHeightM <= marks.startHeightM : marks.endHeightM >= marks.startHeightM)) {
      issue(errors, `${path}/graduations`, 'Graduation extent or direction contradicts the calibrated heights.', 'INVALID_CALIBRATION');
    }
  }
}
function configField(value: ConfigField, path: string, errors: ValidationIssue[]): void {
  if (value.type === 'number' && value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    issue(errors, path, 'Config minimum exceeds its maximum.');
  }
  if (value.default !== undefined) checkSchema(value, value.default, `${path}/default`, errors);
}
function configSchema(value: ConfigSchema, path: string, errors: ValidationIssue[]): void {
  value.required.forEach((key) => {
    if (!Object.hasOwn(value.properties, key)) issue(errors, `${path}/required`, `Required config key ${key} is not declared.`);
  });
}
function apparatusDefinition(value: ApparatusDefinition, path: string, errors: ValidationIssue[]): void {
  unique(value.sockets.map((socket) => socket.id), `${path}/sockets`, errors);
  unique(value.controls.map((control) => control.id), `${path}/controls`, errors);
  if (value.capabilities.includes('CONTAINER') && value.capacityL === undefined) {
    issue(errors, `${path}/capacityL`, 'Container definitions must declare capacity.');
  }
  if (value.vesselCalibration &&
      (value.capacityL === undefined || !sameNumber(value.capacityL, value.vesselCalibration.capacityL))) {
    issue(errors, `${path}/vesselCalibration/capacityL`, 'Calibration capacity must match the definition.', 'INVALID_CALIBRATION');
  }
  if (value.flowModel && !value.capabilities.includes('FLOW_SOURCE')) {
    issue(errors, `${path}/flowModel`, 'A flow model requires FLOW_SOURCE capability.');
  }
  if (value.visual?.kind === 'GLTF' && !value.visual.uri) issue(errors, `${path}/visual/uri`, 'GLTF assets require a URI.');
  checkSchema(value.configSchema as JsonSchema, value.defaultConfig, `${path}/defaultConfig`, errors);
}
function action(value: LabAction, path: string, errors: ValidationIssue[]): void {
  switch (value.type) {
    case 'PLACE':
      if (value.targetInstanceId !== value.payload.instance.id) issue(errors, `${path}/targetInstanceId`, 'PLACE must target its new instance ID.', 'INVALID_ACTION');
      break;
    case 'ATTACH':
      if (![value.payload.connection.from.instanceId, value.payload.connection.to.instanceId].includes(value.targetInstanceId)) {
        issue(errors, `${path}/targetInstanceId`, 'ATTACH must target one of its endpoints.', 'INVALID_ACTION');
      }
      break;
    case 'FILL':
      if (value.payload.contents.volumeL <= 0) issue(errors, `${path}/payload/contents/volumeL`, 'FILL preparation must contain a positive volume.', 'INVALID_ACTION');
      break;
    case 'TRANSFER':
      if (value.targetInstanceId !== value.payload.sourceInstanceId ||
          value.payload.sourceInstanceId === value.payload.targetInstanceId) {
        issue(errors, `${path}/payload`, 'TRANSFER targets its source and requires a distinct receiver.', 'INVALID_ACTION');
      }
      break;
    case 'START_STIRRER':
      if (value.payload.enabled && value.payload.frequencyHz <= 0) {
        issue(errors, `${path}/payload/frequencyHz`, 'An enabled stirrer requires a positive frequency.', 'INVALID_ACTION');
      }
      break;
  }
}
function transfer(value: CumulativeTransfer, path: string, errors: ValidationIssue[]): void {
  if (value.sourceInstanceId === value.receiverInstanceId) issue(errors, path, 'Cumulative transfer requires distinct source and receiver.');
}
function observation(value: Observation, path: string, errors: ValidationIssue[]): void {
  if (value.evidence === 'REFERENCE_MEASURED' && value.sourceIds.length === 0) {
    issue(errors, `${path}/sourceIds`, 'Measured reference observations require a cited source.');
  }
  if (value.titration && value.apparatusId && value.apparatusId !== value.titration.receiverInstanceId) {
    issue(errors, `${path}/titration/receiverInstanceId`, 'Titration context must identify the observed receiver.');
  }
}
function observationRecord(value: ObservationRecord, path: string, errors: ValidationIssue[]): void {
  if (value.observation.stationId && value.stationId !== value.observation.stationId) {
    issue(errors, `${path}/observation/stationId`, 'Observation station disagrees with the ledger record.');
  }
}
function snapshot(value: RuntimeSnapshot, path: string, errors: ValidationIssue[]): void {
  const stations = new Set(value.scene.stations.map((station) => station.id));
  const apparatus = new Map(value.scene.apparatus.map((instance) => [instance.id, instance]));
  if (stations.size !== Object.keys(value.stationStates).length) issue(errors, `${path}/stationStates`, 'Each scene station needs exactly one runtime state.');
  for (const [id, state] of Object.entries(value.stationStates)) {
    if (!stations.has(id) || state.stationId !== id) issue(errors, pointer(`${path}/stationStates`, id), 'Station state has a missing or inconsistent reference.', 'MISSING_REFERENCE');
  }
  for (const [id, state] of Object.entries(value.apparatusStates)) {
    const instance = apparatus.get(id);
    if (!instance) {
      issue(errors, pointer(`${path}/apparatusStates`, id), 'Runtime apparatus does not exist.', 'MISSING_REFERENCE');
      continue;
    }
    if ((state.valveOpeningFraction !== undefined || state.deliveredVolumeL !== undefined) && !instance.capabilities.includes('FLOW_SOURCE')) {
      issue(errors, pointer(`${path}/apparatusStates`, id), 'Valve/delivered state requires FLOW_SOURCE.');
    }
    if (state.stirring && !instance.capabilities.includes('STIRRING')) issue(errors, pointer(`${path}/apparatusStates`, id), 'Stirring state requires STIRRING.');
    if (state.probe) {
      const target = state.probe.containerInstanceId === null ? undefined : apparatus.get(state.probe.containerInstanceId);
      if (!instance.capabilities.includes('PH_SENSOR') ||
          (state.probe.containerInstanceId !== null &&
           (!target?.capabilities.includes('CONTAINER') || target.stationId !== instance.stationId))) {
        issue(errors, pointer(`${path}/apparatusStates`, id), 'Probe must reference a same-station container and have PH_SENSOR capability.');
      }
    }
  }
  unique(value.transferTotals.map((total) => `${total.sourceInstanceId}:${total.receiverInstanceId}`), `${path}/transferTotals`, errors);
  value.transferTotals.forEach((total, index) => {
    const from = apparatus.get(total.sourceInstanceId);
    const to = apparatus.get(total.receiverInstanceId);
    if (!from || !to || from.stationId !== to.stationId ||
        !from.capabilities.includes('CONTAINER') || !to.capabilities.includes('CONTAINER')) {
      issue(errors, `${path}/transferTotals/${index}`, 'Transfer tally requires same-station containers.', 'MISSING_REFERENCE');
    }
  });
  unique(value.observations.map((record) => record.id), `${path}/observations`, errors);
  value.observations.forEach((record, index) => {
    const station = value.stationStates[record.stationId];
    if (record.runId !== value.runId || !station || record.epoch > station.epoch || record.sequence > value.lastSequence) {
      issue(errors, `${path}/observations/${index}`, 'Observation references a different run, unknown station or future epoch/sequence.');
    }
  });
}
function event(value: LabRuntimeEvent, path: string, errors: ValidationIssue[]): void {
  if (value.type === 'ACTION' || value.type === 'CONTROL') {
    const receipt = value.receipt;
    const matchesId = value.type === 'ACTION'
      ? value.action.actionId === value.receipt.actionId
      : value.control.controlId === value.receipt.controlId;
    if (!matchesId || receipt.sequence !== value.sequence || receipt.stationId !== value.stationId || receipt.epoch !== value.epoch) {
      issue(errors, `${path}/receipt`, 'Receipt identity/sequence/epoch must match its event.');
    }
    if (value.type === 'CONTROL' && value.control.stationId !== value.stationId) {
      issue(errors, `${path}/control/stationId`, 'Control station must match its event.');
    }
  }
  if (value.type === 'ADVANCE' && value.toSimulationS <= value.fromSimulationS) issue(errors, path, 'ADVANCE must move simulation time forward.');
  if (value.type === 'OBSERVATIONS') {
    value.observations.forEach((record, index) => {
      if (record.runId !== value.runId || record.stationId !== value.stationId ||
          record.epoch !== value.epoch || record.sequence !== value.sequence) {
        issue(errors, `${path}/observations/${index}`, 'Observation identity/sequence/epoch must match its event.');
      }
    });
  }
}
function steps(values: readonly ReplayStep[], initialScene: ExperimentScene, path: string, errors: ValidationIssue[]): void {
  const stations = new Set(initialScene.stations.map((station) => station.id));
  const commandIds = new Map<string, string>();
  values.forEach((step, index) => {
    const at = pointer(path, index);
    if (step.kind === 'ADVANCE' || step.kind === 'CONTROL') {
      const stationId = step.kind === 'ADVANCE' ? step.stationId : step.control.stationId;
      if (!stations.has(stationId)) issue(errors, at, 'Replay station does not exist in initial scene.', 'MISSING_REFERENCE');
    }
    if (step.kind !== 'ADVANCE') {
      const id = step.kind === 'ACTION' ? step.action.actionId : step.control.controlId;
      const command = canonicalJson(step as unknown as JsonValue);
      if (commandIds.has(id) && commandIds.get(id) !== command) issue(errors, at, 'Command ID is reused with different input.', 'ACTION_ID_CONFLICT');
      commandIds.set(id, command);
    }
  });
}
function checkpoint(value: RuntimeCheckpoint, path: string, errors: ValidationIssue[]): void {
  if (value.initialScene.id !== value.snapshot.scene.id) issue(errors, `${path}/initialScene/id`, 'Initial/current scene IDs must match.');
  if (value.completedStepCount > value.steps.length) issue(errors, `${path}/completedStepCount`, 'Completed step count exceeds the frozen step list.');
  if (value.events.length !== value.snapshot.lastSequence) {
    issue(errors, `${path}/events`, 'Checkpoint must retain the complete event ledger, not truncate idempotency history.');
  }
  const commandIds = new Set<string>();
  let priorRevision = 0;
  value.events.forEach((entry, index) => {
    const at = `${path}/events/${index}`;
    if (entry.sequence !== index + 1 || entry.runId !== value.snapshot.runId) issue(errors, at, 'Event sequence must be contiguous and belong to the checkpoint run.');
    if (entry.type === 'ACTION' || entry.type === 'CONTROL') {
      const id = entry.type === 'ACTION' ? entry.action.actionId : entry.control.controlId;
      if (commandIds.has(id)) issue(errors, at, 'Duplicate commands return their original receipt; they must not append another event.', 'ACTION_ID_CONFLICT');
      commandIds.add(id);
      if (entry.receipt.runtimeRevision < priorRevision || entry.receipt.runtimeRevision > value.snapshot.revision) {
        issue(errors, `${at}/receipt/runtimeRevision`, 'Event runtime revisions must be ordered and cannot exceed the snapshot.');
      }
      priorRevision = entry.receipt.runtimeRevision;
    }
  });
  steps(value.steps, value.initialScene, `${path}/steps`, errors);
}
function nodeResponse(value: NodeRunResponse, path: string, errors: ValidationIssue[]): void {
  if (value.checkpoint &&
      (value.checkpoint.snapshot.runId !== value.result.runId ||
       value.checkpoint.inputHash !== value.result.inputHash ||
       value.checkpoint.methodVersion !== value.result.methodVersion ||
       value.checkpoint.initialScene.simulationConfig.methodId !== value.result.methodId)) {
    issue(errors, `${path}/checkpoint`, 'Checkpoint run/hash/method must match the immutable result.');
  }
}

/** Refinements supplement JSON Schema; they never execute actions or chemistry. */
export function validateSemantics(name: string, value: unknown, path: string, errors: ValidationIssue[]): void {
  switch (name) {
    case 'Transform': {
      const transform = value as Transform;
      const norm = Math.hypot(...transform.quaternion);
      if (Math.abs(norm - 1) > 1e-6) issue(errors, `${path}/quaternion`, 'Quaternion must be normalized (tolerance 1e-6); no silent normalization.');
      break;
    }
    case 'BoundsM': {
      const bounds = value as BoundsM;
      if (bounds.min.some((minimum, i) => minimum > bounds.max[i]!)) issue(errors, path, 'Bounds minima cannot exceed maxima.');
      break;
    }
    case 'ContainerContents': contents(value as ContainerContents, path, errors); break;
    case 'Connection': connection(value as Connection, path, errors); break;
    case 'ExperimentScene': scene(value as ExperimentScene, path, errors); break;
    case 'VesselCalibration': calibration(value as VesselCalibration, path, errors); break;
    case 'ConfigField': configField(value as ConfigField, path, errors); break;
    case 'ConfigSchema': configSchema(value as ConfigSchema, path, errors); break;
    case 'ApparatusDefinition': apparatusDefinition(value as ApparatusDefinition, path, errors); break;
    case 'LabAction': action(value as LabAction, path, errors); break;
    case 'CumulativeTransfer': transfer(value as CumulativeTransfer, path, errors); break;
    case 'Observation': observation(value as Observation, path, errors); break;
    case 'ObservationRecord': observationRecord(value as ObservationRecord, path, errors); break;
    case 'RuntimeSnapshot': snapshot(value as RuntimeSnapshot, path, errors); break;
    case 'LabRuntimeEvent': event(value as LabRuntimeEvent, path, errors); break;
    case 'RuntimeCheckpoint': checkpoint(value as RuntimeCheckpoint, path, errors); break;
    case 'NodeRunRequest': {
      const request = value as NodeRunRequest;
      steps(request.steps, request.initialScene, `${path}/steps`, errors);
      break;
    }
    case 'NodeRunResponse': nodeResponse(value as NodeRunResponse, path, errors); break;
    case 'EquilibriumInput':
      if ((value as EquilibriumInput).contents.volumeL <= 0) issue(errors, `${path}/contents/volumeL`, 'Equilibrium input requires positive volume.');
      break;
  }
}
