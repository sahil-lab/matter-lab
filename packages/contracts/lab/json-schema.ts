import { EVIDENCE_VALUES, LAB_ERROR_CODES, LAB_LIMITS, RUN_STATUSES } from './common.ts';
import { APPARATUS_KINDS, CAPABILITIES, CONNECTION_KINDS } from './scene.ts';

/** The deliberately small JSON Schema vocabulary used by both exported schemas and validation. */
export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly const?: string | number | boolean | null;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly propertyNames?: JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
}
export interface LabJsonSchemaDocument extends JsonSchema {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly $id: string;
  readonly $defs: Readonly<Record<string, JsonSchema>>;
}

const scalarString = '^(?![\\s\\S]*[\\uD800-\\uDFFF])[\\s\\S]*$';
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const literal = (value: string | number | boolean | null): JsonSchema => ({ const: value });
const enumeration = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const text = (max: number = LAB_LIMITS.maxStringLength): JsonSchema => ({
  type: 'string', minLength: 1, maxLength: max, pattern: scalarString,
});
const identifier = text(256);
const number = (minimum = -1e12, maximum = 1e12): JsonSchema => ({ type: 'number', minimum, maximum });
const positive = (maximum = 1e12): JsonSchema => ({ type: 'number', exclusiveMinimum: 0, maximum });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum, maximum });
const bool: JsonSchema = { type: 'boolean' };
const array = (items: JsonSchema, maxItems: number, minItems = 0, uniqueItems = false): JsonSchema => ({
  type: 'array', items, minItems, maxItems, ...(uniqueItems ? { uniqueItems: true } : {}),
});
const strings = array(text(), 256);
const keys = array(identifier, 256, 0, true);
const object = (properties: Record<string, JsonSchema>, optional: readonly string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const record = (value: JsonSchema, maxProperties: number = LAB_LIMITS.maxObjectProperties, uuidKeys = false): JsonSchema => ({
  type: 'object', additionalProperties: value, maxProperties,
  propertyNames: uuidKeys ? ref('UUID') : {
    type: 'string', minLength: 1, maxLength: 256,
    pattern: '^(?!(?:__proto__|prototype|constructor)$)(?![\\s\\S]*[\\uD800-\\uDFFF])[\\s\\S]+$',
  },
});
const time = number(0, LAB_LIMITS.maxSimulationTimeS);
const volume = number(0, 10_000);
const temperature = positive(10_000);
const fraction = number(0, 1);
const quantity = (unit: string, value: JsonSchema = number()): JsonSchema => object({
  value, unit: literal(unit), uncertainty: number(0),
}, ['uncertainty']);
const jsonObject = record(ref('JsonValue'));
const revision = integer();

const provenance = {
  methodId: identifier, methodVersion: identifier, sourceIds: keys,
  warnings: strings, assumptions: strings, limitations: strings, diagnostics: ref('JsonObject'),
};
const scientificFailures = ['UNSUPPORTED', 'FAILED'].map((status) => object({
  ...provenance, status: literal(status),
  evidence: literal(status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNVERIFIED'), error: ref('ProblemDetails'),
}));
const actionFields = {
  actionId: ref('UUID'), atSimulationS: time, targetInstanceId: ref('UUID'),
  actorId: ref('UUID'), expectedRevision: revision, expectedEpoch: revision,
};
const optionalActionFields = ['actorId', 'expectedRevision', 'expectedEpoch'];
const actionPayloads = {
  PLACE: object({ instance: ref('ApparatusInstance') }),
  MOVE: object({ transform: ref('Transform') }),
  ATTACH: object({ connection: ref('Connection') }),
  DETACH: object({ connectionId: ref('UUID') }),
  FILL: object({
    contents: ref('ContainerContents'),
    preparation: object({ kind: enumeration(['INITIAL', 'EXTERNAL']), sourceId: identifier }),
  }),
  SET_VALVE: object({ openingFraction: fraction }),
  TRANSFER: object({
    sourceInstanceId: ref('UUID'), targetInstanceId: ref('UUID'), volumeL: positive(10_000), connectionId: ref('UUID'),
  }),
  START_STIRRER: object({ enabled: bool, frequencyHz: number(0, 1000) }),
  SET_PROBE: object({ containerInstanceId: { anyOf: [ref('UUID'), { type: 'null' }] } }),
  RESET: object({ scope: enumeration(['STATION', 'SCENE']) }),
  CUSTOM: object({ pluginId: identifier, actionType: identifier, data: ref('JsonObject') }),
};
export const LAB_ACTION_TYPES = Object.freeze(Object.keys(actionPayloads) as (keyof typeof actionPayloads)[]);

const receiptFields = {
  sequence: integer(1), runtimeRevision: revision, stationId: ref('UUID'), epoch: revision,
};
const receipt = (id: 'actionId' | 'controlId'): JsonSchema => ({
  oneOf: [
    object({ ...receiptFields, [id]: ref('UUID'), status: literal('APPLIED') }),
    object({ ...receiptFields, [id]: ref('UUID'), status: literal('REJECTED'), error: ref('ProblemDetails') }),
  ],
});
const eventFields = { runId: ref('UUID'), sequence: integer(1), stationId: ref('UUID'), epoch: revision };
const observationFields = {
  apparatusId: ref('UUID'), stationId: ref('UUID'), timeS: time, evidence: ref('Evidence'),
  methodId: identifier, methodVersion: identifier, sourceIds: keys, speciesId: identifier, indicatorId: identifier,
  titration: ref('CumulativeTransfer'),
};
const observationOptional = ['apparatusId', 'stationId', 'methodVersion', 'speciesId', 'indicatorId', 'titration', 'indicatorState'];
const observationQuantities = {
  PH: quantity('pH'),
  TEMPERATURE: quantity('K', temperature),
  VOLUME: quantity('L', volume),
  CONCENTRATION: quantity('mol/L', number(0)),
  INDICATOR: quantity('1', fraction),
  MASS: quantity('kg', number(0)),
};
const runFields = {
  runId: ref('UUID'), methodId: identifier, methodVersion: identifier, inputHash: ref('InputHash'),
  observations: array(ref('Observation'), LAB_LIMITS.maxObservations),
  warnings: strings, assumptions: strings, limitations: strings, solverDiagnostics: ref('JsonObject'),
};

const definitions = {
  UUID: { type: 'string', pattern: UUID_PATTERN, format: 'uuid' } satisfies JsonSchema,
  UtcTimestamp: {
    type: 'string', format: 'date-time',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$',
  } satisfies JsonSchema,
  InputHash: { type: 'string', pattern: '^[0-9a-f]{64}$' } satisfies JsonSchema,
  Evidence: enumeration(EVIDENCE_VALUES),
  RunStatus: enumeration(RUN_STATUSES),
  LabErrorCode: enumeration(LAB_ERROR_CODES),
  JsonValue: {
    anyOf: [
      { type: 'null' }, bool, number(-Number.MAX_VALUE, Number.MAX_VALUE),
      { ...text(), minLength: 0 },
      array(ref('JsonValue'), LAB_LIMITS.maxEvents), ref('JsonObject'),
    ],
  } satisfies JsonSchema,
  JsonObject: jsonObject,
  Vec3M: array(number(-10_000, 10_000), 3, 3),
  Quaternion: array(number(-1, 1), 4, 4),
  Transform: object({ positionM: ref('Vec3M'), quaternion: ref('Quaternion') }),
  BoundsM: object({ min: ref('Vec3M'), max: ref('Vec3M') }),
  Quantity: object({ value: number(), unit: identifier, uncertainty: number(0) }, ['uncertainty']),
  ValidationIssue: object({ code: ref('LabErrorCode'), path: { ...text(), minLength: 0 }, message: text() }),
  ProblemDetails: object({
    type: text(), title: text(), status: integer(400, 599), detail: text(), code: ref('LabErrorCode'),
    instance: text(), traceId: ref('UUID'), errors: array(ref('ValidationIssue'), LAB_LIMITS.maxValidationIssues),
  }, ['instance', 'traceId', 'errors']),
  Station: object({ id: ref('UUID'), name: text(256) }),
  ApparatusKind: enumeration(APPARATUS_KINDS),
  Capability: enumeration(CAPABILITIES),
  ConnectionKind: enumeration(CONNECTION_KINDS),
  ApparatusInstance: object({
    id: ref('UUID'), kind: ref('ApparatusKind'), definitionId: identifier, transform: ref('Transform'),
    revision, config: ref('JsonObject'), capabilities: array(ref('Capability'), CAPABILITIES.length, 0, true),
    stationId: ref('UUID'),
  }),
  SocketEndpoint: object({ instanceId: ref('UUID'), socketId: identifier }),
  Connection: object({
    id: ref('UUID'), from: ref('SocketEndpoint'), to: ref('SocketEndpoint'),
    kind: ref('ConnectionKind'), enabled: bool,
  }),
  SpeciesAmount: object({ speciesId: identifier, moles: number(0, 1_000_000), sourceId: identifier }, ['sourceId']),
  ContainerContents: object({
    volumeL: volume, species: array(ref('SpeciesAmount'), LAB_LIMITS.maxSpeciesPerContainer),
    temperatureK: temperature, mixing: enumeration(['WELL_MIXED', 'UNMIXED']), modelId: identifier,
  }),
  SimulationConfig: object({ methodId: identifier, timeStepS: number(0.000001, 60) }),
  ExperimentScene: object({
    id: ref('UUID'), revision, schemaVersion: literal(1),
    stations: array(ref('Station'), LAB_LIMITS.maxStations, 1),
    apparatus: array(ref('ApparatusInstance'), LAB_LIMITS.maxApparatus),
    connections: array(ref('Connection'), LAB_LIMITS.maxConnections),
    containerStates: record(ref('ContainerContents'), LAB_LIMITS.maxApparatus, true),
    simulationConfig: ref('SimulationConfig'), viewport: ref('JsonObject'),
  }, ['viewport']),
  ExperimentAssembly: object({
    id: ref('UUID'), schemaVersion: literal(1), name: text(256), description: text(),
    scene: ref('ExperimentScene'), sourceIds: keys,
  }),
  ConfigField: {
    oneOf: [
      object({ type: literal('number'), unit: identifier, minimum: number(), maximum: number(), default: number() },
        ['minimum', 'maximum', 'default']),
      object({ type: literal('boolean'), default: bool }, ['default']),
      object({
        type: literal('string'), enum: array({ ...text(), minLength: 0 }, 256, 1, true),
        maxLength: integer(0, LAB_LIMITS.maxStringLength), default: { ...text(), minLength: 0 },
      }, ['enum', 'maxLength', 'default']),
    ],
  } satisfies JsonSchema,
  ConfigSchema: object({
    type: literal('object'), properties: record(ref('ConfigField'), 128),
    required: array(identifier, 128, 0, true), additionalProperties: literal(false),
  }),
  SocketCompatibility: object({
    key: identifier, accepts: keys, requiredCapabilities: array(ref('Capability'), CAPABILITIES.length, 0, true),
    allowedKinds: array(ref('ApparatusKind'), APPARATUS_KINDS.length, 0, true), requiredTags: keys,
  }, ['requiredCapabilities', 'allowedKinds', 'requiredTags']),
  SocketDefinition: object({
    id: identifier, kind: ref('ConnectionKind'), localTransform: ref('Transform'),
    direction: enumeration(['IN', 'OUT', 'BIDIRECTIONAL']), gender: enumeration(['MALE', 'FEMALE', 'NEUTRAL']),
    compatibility: ref('SocketCompatibility'), maxConnections: integer(1, LAB_LIMITS.maxConnections),
    highlightAnchorM: ref('Vec3M'), alignmentToleranceM: number(0, 10),
  }, ['highlightAnchorM', 'alignmentToleranceM']),
  VesselCalibration: object({
    capacityL: positive(10_000), maxFillHeightM: positive(10_000),
    interiorProfile: array(object({ yM: number(-10_000, 10_000), radiusM: number(0, 10_000) }), LAB_LIMITS.maxCalibrationPoints, 2),
    volumeHeightCurve: array(object({ volumeL: volume, heightM: number(-10_000, 10_000) }), LAB_LIMITS.maxCalibrationPoints, 2),
    graduations: object({
      minorStepL: positive(10_000), majorStepL: positive(10_000),
      startHeightM: number(-10_000, 10_000), endHeightM: number(-10_000, 10_000),
      reading: enumeration(['CONTAINED', 'DELIVERED']), direction: enumeration(['UP', 'DOWN']),
    }),
    meniscus: object({ reference: enumeration(['BOTTOM', 'TOP']), offsetM: number(-10, 10) }),
    evidence: ref('Evidence'), sourceIds: keys, assumptions: strings,
  }, ['graduations']),
  ApparatusControl: object({
    id: identifier, label: text(256),
    actionType: enumeration(['FILL', 'SET_VALVE', 'TRANSFER', 'START_STIRRER', 'SET_PROBE', 'CUSTOM']),
    fields: record(ref('ConfigField'), 128),
  }),
  FlowModelDefinition: object({ methodId: identifier, maxFlowLPerS: positive(10_000), assumptions: strings }),
  ApparatusAsset: object({
    kind: enumeration(['PROCEDURAL', 'GLTF']), uri: text(), thumbnailUri: text(), previewFocusM: ref('Vec3M'),
    license: text(256), attribution: text(), triangleCount: integer(0, 10_000_000),
    textureBytes: integer(0, 1_073_741_824), sourceIds: keys,
    status: enumeration(['COMPLETE', 'DEVELOPMENT_PLACEHOLDER']),
  }, ['uri', 'thumbnailUri', 'previewFocusM']),
  ApparatusDefinition: object({
    id: identifier, version: identifier, schemaVersion: literal(1), kind: ref('ApparatusKind'),
    label: text(256), category: identifier, capabilities: array(ref('Capability'), CAPABILITIES.length, 0, true),
    dimensionsM: array(positive(10_000), 3, 3), boundsM: ref('BoundsM'),
    permittedTransforms: object({
      translation: array(enumeration(['X', 'Y', 'Z']), 3, 0, true),
      rotation: array(enumeration(['X', 'Y', 'Z']), 3, 0, true),
    }),
    sockets: array(ref('SocketDefinition'), LAB_LIMITS.maxSocketsPerDefinition),
    controls: array(ref('ApparatusControl'), 64), configSchema: ref('ConfigSchema'), defaultConfig: ref('JsonObject'),
    tags: keys, capacityL: positive(10_000), vesselCalibration: ref('VesselCalibration'),
    flowModel: ref('FlowModelDefinition'), massKg: number(0, 1_000_000),
    maxSupportedMassKg: number(0, 1_000_000), visual: ref('ApparatusAsset'),
  }, ['tags', 'capacityL', 'vesselCalibration', 'flowModel', 'massKg', 'maxSupportedMassKg', 'visual']),
  LabAction: {
    oneOf: Object.entries(actionPayloads).map(([type, payload]) =>
      object({ ...actionFields, type: literal(type), payload }, optionalActionFields)),
  } satisfies JsonSchema,
  RuntimeControl: {
    oneOf: ['PAUSE', 'RESUME', 'SET_SPEED'].map((type) => object({
      controlId: ref('UUID'), stationId: ref('UUID'), atSimulationS: time, expectedEpoch: revision,
      type: literal(type), payload: type === 'SET_SPEED' ? object({ speed: number(0.05, 100) }) : object({}),
    }, ['expectedEpoch'])),
  } satisfies JsonSchema,
  ReplayStep: {
    oneOf: [
      object({ kind: literal('ACTION'), action: ref('LabAction') }),
      object({ kind: literal('ADVANCE'), stationId: ref('UUID'), ticks: integer(1, LAB_LIMITS.maxTicksPerAdvance) }),
      object({ kind: literal('CONTROL'), control: ref('RuntimeControl') }),
    ],
  } satisfies JsonSchema,
  ScientificProvenance: object(provenance),
  EquilibriumInput: object({
    contents: ref('ContainerContents'), methodId: identifier, assumptions: strings,
    indicatorIds: array(identifier, 32, 0, true),
  }, ['indicatorIds']),
  EquilibriumSpecies: object({ speciesId: identifier, concentrationMolL: number(0) }),
  IndicatorResult: object({
    indicatorId: identifier, baseFraction: fraction, colorSrgb: array(fraction, 3, 3),
    colorEvidence: literal('ILLUSTRATIVE'), sourceIds: keys,
  }),
  EquilibriumResult: {
    oneOf: [
      object({
        ...provenance, status: literal('SUCCEEDED'), evidence: literal('MODEL_CALCULATED'),
        pH: quantity('pH'), equilibriumSpecies: array(ref('EquilibriumSpecies'), 512),
        indicators: array(ref('IndicatorResult'), 32),
      }),
      ...scientificFailures,
    ],
  } satisfies JsonSchema,
  PreparationInput: object({
    reagentId: identifier, volumeL: positive(10_000), concentrationMolL: number(0),
    temperatureK: temperature, mixing: enumeration(['WELL_MIXED', 'UNMIXED']),
  }, ['temperatureK', 'mixing']),
  PreparationResult: {
    oneOf: [
      object({ ...provenance, status: literal('SUCCEEDED'), evidence: literal('MODEL_CALCULATED'), contents: ref('ContainerContents') }),
      ...scientificFailures,
    ],
  } satisfies JsonSchema,
  Observation: {
    oneOf: Object.entries(observationQuantities).map(([type, value]) =>
      object({
        ...observationFields, type: literal(type), quantity: value,
        ...(type === 'INDICATOR' ? { indicatorState: ref('IndicatorResult') } : {}),
      }, observationOptional)),
  } satisfies JsonSchema,
  CumulativeTransfer: object({
    sourceInstanceId: ref('UUID'), receiverInstanceId: ref('UUID'), deliveredVolumeL: volume,
  }),
  ObservationRecord: object({
    id: ref('UUID'), runId: ref('UUID'), stationId: ref('UUID'), epoch: revision,
    sequence: integer(1), observation: ref('Observation'),
  }),
  RunResult: {
    oneOf: RUN_STATUSES.map((status) => object({
      ...runFields, status: literal(status),
      ...(['FAILED', 'UNSUPPORTED'].includes(status) ? { error: ref('ProblemDetails') } : {}),
    }, ['limitations', 'solverDiagnostics'])),
  } satisfies JsonSchema,
  TerminalRunResult: {
    oneOf: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'].map((status) => object({
      ...runFields, status: literal(status),
      ...(['FAILED', 'UNSUPPORTED'].includes(status) ? { error: ref('ProblemDetails') } : {}),
    }, ['limitations', 'solverDiagnostics'])),
  } satisfies JsonSchema,
  StationRuntimeState: object({
    stationId: ref('UUID'), epoch: revision,
    status: enumeration(['PREPARING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'UNSUPPORTED']),
    simulationTimeS: time, tick: revision, speed: number(0.05, 100), error: ref('ProblemDetails'),
  }, ['error']),
  ApparatusRuntimeState: object({
    valveOpeningFraction: fraction, deliveredVolumeL: volume,
    stirring: object({ enabled: bool, frequencyHz: number(0, 1000) }),
    probe: object({ containerInstanceId: { anyOf: [ref('UUID'), { type: 'null' }] } }),
  }, ['valveOpeningFraction', 'deliveredVolumeL', 'stirring', 'probe']),
  ActionReceipt: receipt('actionId'),
  ControlReceipt: receipt('controlId'),
  RuntimeSnapshot: object({
    schemaVersion: literal(1), runId: ref('UUID'), revision, scene: ref('ExperimentScene'),
    stationStates: record(ref('StationRuntimeState'), LAB_LIMITS.maxStations, true),
    apparatusStates: record(ref('ApparatusRuntimeState'), LAB_LIMITS.maxApparatus, true),
    transferTotals: array(ref('CumulativeTransfer'), LAB_LIMITS.maxConnections),
    observations: array(ref('ObservationRecord'), LAB_LIMITS.maxObservations), lastSequence: revision,
  }),
  LabRuntimeEvent: {
    oneOf: [
      object({ ...eventFields, type: literal('ACTION'), action: ref('LabAction'), receipt: ref('ActionReceipt') }),
      object({ ...eventFields, type: literal('CONTROL'), control: ref('RuntimeControl'), receipt: ref('ControlReceipt') }),
      object({ ...eventFields, type: literal('ADVANCE'), fromSimulationS: time, toSimulationS: time, ticks: integer(1, LAB_LIMITS.maxTicksPerAdvance) }),
      object({ ...eventFields, type: literal('OBSERVATIONS'), observations: array(ref('ObservationRecord'), LAB_LIMITS.maxObservations, 1) }),
      object({ ...eventFields, type: literal('STATUS'), status: ref('RunStatus'), error: ref('ProblemDetails') }, ['error']),
    ],
  } satisfies JsonSchema,
  RuntimeCheckpoint: object({
    schemaVersion: literal(1), contractVersion: identifier, runtimeVersion: identifier,
    methodVersion: identifier, inputHash: ref('InputHash'), initialScene: ref('ExperimentScene'),
    snapshot: ref('RuntimeSnapshot'), steps: array(ref('ReplayStep'), LAB_LIMITS.maxReplaySteps),
    completedStepCount: integer(0, LAB_LIMITS.maxReplaySteps), limits: ref('RunLimits'),
    events: array(ref('LabRuntimeEvent'), LAB_LIMITS.maxEvents),
  }, ['limits']),
  RunLimits: object({
    maxTicks: integer(1, 1_000_000), maxActions: integer(1, LAB_LIMITS.maxEvents),
    maxObservations: integer(1, LAB_LIMITS.maxObservations), maxSimulationTimeS: positive(LAB_LIMITS.maxSimulationTimeS),
  }),
  NodeRunRequest: object({
    schemaVersion: literal(1), runId: ref('UUID'), contractVersion: identifier, runtimeVersion: identifier,
    methodVersion: identifier, initialScene: ref('ExperimentScene'),
    steps: array(ref('ReplayStep'), LAB_LIMITS.maxReplaySteps), limits: ref('RunLimits'),
  }, ['limits']),
  RuntimeSolverRequest: object({ apparatusId: ref('UUID'), input: ref('EquilibriumInput') }),
  NodeRunResponse: object({
    schemaVersion: literal(1), result: ref('TerminalRunResult'), checkpoint: ref('RuntimeCheckpoint'),
  }, ['checkpoint']),
} satisfies Record<string, JsonSchema>;

export type LabSchemaName = keyof typeof definitions;

function freezeSchema<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) freezeSchema(child);
  }
  return Object.freeze(value);
}
export const LAB_JSON_SCHEMA: LabJsonSchemaDocument = freezeSchema({
  $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
  $id: 'urn:matterlab:contracts:lab:1',
  $ref: '#/$defs/ExperimentScene',
  $defs: definitions,
});
export function getLabJsonSchema(name: LabSchemaName = 'ExperimentScene'): LabJsonSchemaDocument {
  return Object.freeze({ ...LAB_JSON_SCHEMA, $ref: `#/$defs/${name}` });
}
