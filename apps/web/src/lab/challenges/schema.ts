import { APPARATUS_KINDS, CAPABILITIES, CONNECTION_KINDS, EVIDENCE_VALUES, LAB_JSON_SCHEMA, LAB_LIMITS, UUID_PATTERN } from '@matterlab/contracts';
import type { JsonSchema } from '@matterlab/contracts';
import { freezeJson } from './json.ts';

export const LEARNING_STATE_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024, maxAttempts: LAB_LIMITS.maxStations, maxTrialsPerAttempt: 30,
  maxEvents: 20_000, maxObservations: 20_000, maxDepth: 48, maxNodes: 300_000,
});
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str = (maximum = 4096, minimum = 1): JsonSchema => ({ type: 'string', minLength: minimum, maxLength: maximum });
const id = str(128);
const uuid: JsonSchema = { type: 'string', pattern: UUID_PATTERN };
const int = (min = 0, max = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum: min, maximum: max });
const num = (min = 0, max = 1e12): JsonSchema => ({ type: 'number', minimum: min, maximum: max });
const bool: JsonSchema = { type: 'boolean' };
const constant = (value: string | number): JsonSchema => ({ const: value });
const enumeration = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const object = (properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false,
});
const array = (items: JsonSchema, maxItems = 256, minItems = 0): JsonSchema => ({ type: 'array', items, maxItems, minItems });
const record = (values: JsonSchema): JsonSchema => ({
  type: 'object', additionalProperties: values, maxProperties: 512,
  propertyNames: { type: 'string', minLength: 1, maxLength: 128, pattern: '^(?!(?:__proto__|constructor|prototype)$).+$' },
});
const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [schema, { type: 'null' }] });
const quantity = (unit: string, min = 0): JsonSchema => object({ value: num(min), unit: constant(unit), uncertainty: num() }, ['uncertainty']);
const categories = ['setup', 'operation', 'endpoint', 'repeatability', 'interpretation'] as const;
const modes = ['guided', 'challenge', 'free', 'precision'] as const;
const strings = array(str());
const timestamp: JsonSchema = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{3})?Z$' };
const metadata = {
  id, methodId: id, methodVersion: id, sourceIds: strings, warnings: strings, assumptions: strings, limitations: strings,
};
const runtimeSchema = LAB_JSON_SCHEMA.$defs.RuntimeSnapshot!;

export const learningStateJsonSchema = freezeJson({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://matterlab.local/schemas/learning-state-v1.json',
  ...object({
    schemaVersion: constant(1), kind: constant('MATTERLAB_LEARNING_STATE'),
    attempts: array(ref('ChallengeAttempt'), LEARNING_STATE_LIMITS.maxAttempts),
  }),
  $defs: {
    ...LAB_JSON_SCHEMA.$defs,
    LearningScope: object({ runId: uuid, stationId: uuid, epoch: int() }),
    LearningSelector: object({ kind: enumeration(APPARATUS_KINDS), definitionId: id, capabilities: array(enumeration(CAPABILITIES), 16), label: str(200) }, ['kind', 'definitionId']),
    LearningPredicate: { oneOf: [
      ...['all', 'any'].map((kind) => object({ kind: constant(kind), predicates: array(ref('LearningPredicate'), 32, 1) })),
      object({ kind: constant('capability'), role: id, capabilities: array(enumeration(CAPABILITIES), 16, 1) }),
      object({ kind: constant('connection'), from: id, to: id, connectionKind: enumeration(CONNECTION_KINDS) }),
      object({ kind: constant('mounted'), chain: array(id, 16, 2) }),
      object({ kind: constant('receiverAligned'), source: id, receiver: id }),
      object({ kind: constant('prepared'), role: id }),
      object({ kind: constant('sensorUsed'), sensor: id, receiver: id }),
      object({ kind: constant('instrumentRead'), source: id, receiver: id }),
      object({
        kind: constant('actionApplied'), role: id,
        actionType: enumeration(['PLACE', 'MOVE', 'ATTACH', 'DETACH', 'FILL', 'SET_VALVE', 'TRANSFER', 'START_STIRRER', 'SET_PROBE', 'RESET', 'CUSTOM']),
        setting: enumeration(['positive', 'zero']),
      }, ['setting']),
      object({ kind: constant('deliveredVolumeWithin'), target: enumeration(['equivalence', 'endpoint']) }),
      object({ kind: constant('endpointCaptured') }),
      object({ kind: constant('repeatTrials'), minimum: int(2, 30) }),
      object({ kind: constant('repeatabilityWithin') }),
      object({ kind: constant('interpretation') }),
    ] },
    LearningGoal: object({
      id, label: str(300), category: enumeration(categories), predicate: ref('LearningPredicate'),
      modes: array(enumeration(['guided', 'challenge', 'precision']), 3, 1),
      requires: array(id, 64), hint: str(), highlightRoles: array(id, 16), controlId: id,
    }, ['controlId']),
    LearningDefinition: object({
      id, version: id, title: str(300), description: str(), roles: record(ref('LearningSelector')),
      sourceRole: id, receiverRole: id, sensorRole: id, captureRequires: array(id, 64, 1), goals: array(ref('LearningGoal'), 64, 1),
      instructions: array(object({
        id, title: str(300), caption: str(), goalIds: array(id, 64),
        actionKind: enumeration(['place', 'connect', 'prepare', 'read', 'operate', 'reset']),
      }, ['actionKind']), 64, 1),
      rubric: object({
        id, version: id, weights: object(Object.fromEntries(categories.map((key) => [key, num(0, 100)]))),
        endpointToleranceL: num(1e-12, 1), readingToleranceL: num(1e-12, 1), repeatabilityToleranceL: num(1e-12, 1),
        concentrationToleranceMolL: num(1e-12, 100), minimumTrials: int(2, 30),
        toleranceMeaning: constant('PEDAGOGICAL_NOT_EXPERIMENTAL_UNCERTAINTY'),
      }),
    }),
    LearningReference: { oneOf: [
      object({
        ...metadata, status: constant('SUPPORTED'), evidence: enumeration(['MODEL_CALCULATED', 'REFERENCE_MEASURED']),
        preparations: array(object({ role: id, label: str(300), sourceId: id, contents: ref('ContainerContents') }), 16, 1),
        equivalenceVolume: quantity('L'), equivalencePH: quantity('pH', -100), initialConcentration: quantity('mol/L'),
        indicatorEndpoint: object({ indicatorId: id, volume: quantity('L'), criterion: str(), interpretation: str() }),
      }, ['equivalencePH', 'initialConcentration', 'indicatorEndpoint']),
      ...['UNSUPPORTED', 'FAILED'].map((status) => object({
        ...metadata, status: constant(status), evidence: constant(status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNVERIFIED'), reasons: array(str(), 256, 1),
      })),
    ] },
    LearningFrame: {
      ...runtimeSchema,
      properties: Object.fromEntries(Object.entries(runtimeSchema.properties ?? {}).filter(([key]) => key !== 'observations')),
      required: runtimeSchema.required?.filter((key) => key !== 'observations'),
    },
    LearningAppliedEvent: object({
      runId: uuid, stationId: uuid, epoch: int(), sequence: int(1), type: constant('ACTION'),
      action: ref('LabAction'),
      receipt: object({ actionId: uuid, sequence: int(1), runtimeRevision: int(), stationId: uuid, epoch: int(), status: constant('APPLIED') }),
    }),
    LearningReading: object({ observationId: uuid, recordedAtSequence: int(), enteredDeliveredVolume: quantity('L') }),
    LearningEndpoint: object({
      observationId: uuid, capturedAtSequence: int(), basis: enumeration(['instrument-reading', 'indicator-change']),
      deliveredVolume: quantity('L'), evidence: enumeration(EVIDENCE_VALUES), note: str(2000, 0),
    }),
    LearningConclusion: object({
      text: str(2000, 0), citedObservationIds: array(uuid, 256),
      equivalenceAndEndpoint: enumeration(['distinct', 'same', 'unsure']),
      endpointPosition: enumeration(['before', 'within', 'after', 'unsure']), concentration: quantity('mol/L'),
      acknowledgesModelLimits: bool,
    }, ['concentration']),
    LearningTrial: object({
      id: uuid, scope: ref('LearningScope'), status: enumeration(['active', 'captured', 'interrupted']),
      startedAt: timestamp, startedAtSequence: int(), cursorSequence: int(), bindings: record(uuid),
      initialContainerStates: record(ref('ContainerContents')), initialTransferVolumeL: num(),
      frame: ref('LearningFrame'), definitions: array(ref('ApparatusDefinition'), 128),
      support: object({ status: enumeration(['SUPPORTED', 'UNSUPPORTED']), reasons: strings, methodId: id }),
      reference: ref('LearningReference'),
      appliedEvents: array(ref('LearningAppliedEvent'), LEARNING_STATE_LIMITS.maxEvents),
      observations: array(ref('ObservationRecord'), LEARNING_STATE_LIMITS.maxObservations),
      readings: array(ref('LearningReading'), 1024), endpoint: nullable(ref('LearningEndpoint')),
      conclusion: nullable(ref('LearningConclusion')), notes: str(4000, 0), interruptionReason: str(),
    }, ['interruptionReason']),
    ChallengeAttempt: object({
      schemaVersion: constant(1), kind: constant('MATTERLAB_CHALLENGE_ATTEMPT'), id: uuid,
      definition: ref('LearningDefinition'), mode: enumeration(modes), createdAt: timestamp, updatedAt: timestamp,
      activeTrialId: uuid, requestedBindings: record(uuid),
      progression: object({ instructionIndex: int(0, 63), dismissed: bool, hintsRequested: array(id, 64) }),
      trials: array(ref('LearningTrial'), LEARNING_STATE_LIMITS.maxTrialsPerAttempt, 1),
    }),
  },
} as const);
