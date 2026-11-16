import { parseLabContract } from '@matterlab/contracts';
import type { JsonSchema } from '@matterlab/contracts';
import { canonicalJson, copyJson } from './json.ts';
import { LEARNING_STATE_LIMITS, learningStateJsonSchema } from './schema.ts';
import type { ChallengeAttempt, ChallengeDefinition, GoalPredicate, LearningReference, LearningState, TrialEvidence } from './types.ts';

export { LEARNING_STATE_LIMITS, learningStateJsonSchema } from './schema.ts';

export class LearningStateError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path || '/'}: ${message}`);
    this.name = 'LearningStateError';
    this.path = path;
  }
}
const fail = (path: string, message: string): never => { throw new LearningStateError(path, message); };
const at = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function inspect(input: unknown): void {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (++nodes > LEARNING_STATE_LIMITS.maxNodes || depth > LEARNING_STATE_LIMITS.maxDepth) fail(path, 'JSON size or depth limit exceeded.');
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(path, 'Numbers must be finite.');
      return;
    }
    if (typeof value === 'string') {
      if (value.length > 4096 || /[\uD800-\uDFFF]/u.test(value)) fail(path, 'Invalid or oversized JSON string.');
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value !== 'object') fail(path, 'Only plain JSON data is accepted.');
    const object = value as object;
    if (ancestors.has(object)) fail(path, 'Cyclic JSON is not accepted.');
    const array = Array.isArray(object);
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail(path, 'Only plain JSON objects are accepted.');
    ancestors.add(object);
    const keys = Reflect.ownKeys(object);
    if (keys.length > LEARNING_STATE_LIMITS.maxEvents + 1) fail(path, 'Collection limit exceeded.');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(path, 'Unsafe JSON key.');
      if (array && !/^(0|[1-9]\d*)$/.test(key as string)) fail(path, 'Array properties would be lost.');
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(path, 'Accessors and hidden fields are not accepted.');
      visit(descriptor!.value, at(path, key as string), depth + 1);
    }
    if (array && keys.length !== (object as unknown[]).length + 1) fail(path, 'Sparse arrays are not accepted.');
    ancestors.delete(object);
  };
  visit(input, '', 0);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > LEARNING_STATE_LIMITS.maxBytes) fail('', 'Learning state exceeds 4 MiB; export or start another notebook. Evidence was not truncated.');
}

function check(schema: JsonSchema, value: unknown, path: string): void {
  if (schema.$ref) {
    const name = schema.$ref.slice('#/$defs/'.length);
    const target = (learningStateJsonSchema.$defs as Readonly<Record<string, JsonSchema>>)[name];
    if (!target) fail(path, `Unknown schema ${name}.`);
    return check(target, value, path);
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) {
    let matching = 0;
    for (const variant of variants) {
      try { check(variant, value, path); matching++; } catch (error) { if (!(error instanceof LearningStateError)) throw error; }
    }
    if (schema.oneOf ? matching !== 1 : matching === 0) fail(path, 'Data does not match one supported variant.');
    return;
  }
  if ('const' in schema && value !== schema.const) fail(path, `Expected ${String(schema.const)}.`);
  if (schema.enum && !schema.enum.some((entry) => entry === value)) fail(path, 'Unknown enum value.');
  if (!schema.type) return;
  if (schema.type === 'null') { if (value !== null) fail(path, 'Expected null.'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Expected object.');
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(path, 'Too many object fields.');
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(path, 'Too few object fields.');
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) fail(at(path, key), 'Required field is missing.');
    for (const key of keys) {
      if (schema.propertyNames) check(schema.propertyNames, key, at(path, key));
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
      if (child) check(child, object[key], at(path, key));
      else if (schema.additionalProperties === false) fail(at(path, key), 'Unknown field.');
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, object[key], at(path, key));
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'Expected array.');
    const items = value as unknown[];
    if ((schema.maxItems !== undefined && items.length > schema.maxItems) || (schema.minItems !== undefined && items.length < schema.minItems)) fail(path, 'Array length is outside the supported range.');
    if (schema.uniqueItems && new Set(items.map(canonicalJson)).size !== items.length) fail(path, 'Duplicate array entry.');
    if (schema.items) items.forEach((entry, index) => check(schema.items!, entry, at(path, index)));
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) fail(path, 'Expected finite number or safe integer.');
    const number = value as number;
    if ((schema.minimum !== undefined && number < schema.minimum) || (schema.maximum !== undefined && number > schema.maximum) ||
      (schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum)) fail(path, 'Number is outside the supported range.');
    return;
  }
  if (typeof value !== schema.type) fail(path, `Expected ${schema.type}.`);
  if (schema.type === 'string') {
    const text = value as string;
    if ((schema.minLength !== undefined && text.length < schema.minLength) || (schema.maxLength !== undefined && text.length > schema.maxLength) ||
      (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(text))) fail(path, 'String is outside the supported format.');
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(text))) fail(path, 'Invalid timestamp.');
  }
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'Duplicate identity is not independent evidence.');
}

function predicateRoles(predicate: GoalPredicate): readonly string[] {
  switch (predicate.kind) {
    case 'all': case 'any': return predicate.predicates.flatMap(predicateRoles);
    case 'capability': case 'prepared': case 'actionApplied': return [predicate.role];
    case 'connection': return [predicate.from, predicate.to];
    case 'mounted': return predicate.chain;
    case 'receiverAligned': case 'instrumentRead': return [predicate.source, predicate.receiver];
    case 'sensorUsed': return [predicate.sensor, predicate.receiver];
    default: return [];
  }
}

function definitionSemantics(definition: ChallengeDefinition, path: string): void {
  const roles = Object.keys(definition.roles);
  const goals = new Map(definition.goals.map((goal) => [goal.id, goal]));
  unique(definition.goals.map((goal) => goal.id), path);
  unique(definition.instructions.map((instruction) => instruction.id), path);
  const references = [definition.sourceRole, definition.receiverRole, definition.sensorRole,
    ...definition.goals.flatMap((goal) => [...goal.highlightRoles, ...predicateRoles(goal.predicate)])];
  if (references.some((role) => !roles.includes(role))) fail(path, 'A goal references an undeclared role.');
  if (definition.sourceRole === definition.receiverRole || definition.sensorRole === definition.receiverRole) fail(path, 'Source, receiver and sensor roles must differ.');
  const visit = (id: string, ancestors: readonly string[]): void => {
    if (ancestors.includes(id)) fail(path, 'Goal dependencies must be acyclic.');
    const goal = goals.get(id);
    if (!goal) fail(path, `Unknown prerequisite ${id}.`);
    goal!.requires.forEach((dependency) => visit(dependency, [...ancestors, id]));
  };
  definition.goals.forEach((goal) => visit(goal.id, []));
  for (const id of definition.captureRequires) {
    const goal = goals.get(id);
    if (!goal || !['setup', 'operation'].includes(goal.category)) fail(path, 'Capture prerequisites must be setup/operation goals.');
  }
  if (definition.instructions.some((instruction) => instruction.goalIds.some((id) => !goals.has(id)))) fail(path, 'Instruction references an unknown goal.');
  if (Object.values(definition.rubric.weights).reduce((sum, weight) => sum + weight, 0) <= 0) fail(path, 'Rubric needs positive available points.');
}

export function parseChallengeDefinition(input: unknown): ChallengeDefinition {
  inspect(input);
  check(learningStateJsonSchema.$defs.LearningDefinition, input, '/definition');
  definitionSemantics(input as ChallengeDefinition, '/definition');
  return copyJson(input as ChallengeDefinition);
}

export function parseLearningReference(input: unknown): LearningReference {
  inspect(input);
  check(learningStateJsonSchema.$defs.LearningReference, input, '/reference');
  const reference = input as LearningReference;
  if (reference.status === 'SUPPORTED') {
    if (reference.sourceIds.length === 0 || reference.equivalenceVolume.value <= 0) fail('/reference', 'Supported targets require sources and a positive equivalence volume.');
    unique(reference.preparations.map((preparation) => preparation.role), '/reference/preparations');
    reference.preparations.forEach((preparation) => parseLabContract('ContainerContents', preparation.contents));
    if (reference.preparations.some((preparation) => preparation.contents.modelId !== reference.methodId)) fail('/reference/preparations', 'Preparation method must match the target method.');
  }
  return copyJson(reference);
}

function trialSemantics(trial: TrialEvidence, path: string): void {
  const { scope, frame } = trial;
  if (frame.runId !== scope.runId || frame.stationStates[scope.stationId]?.epoch !== scope.epoch) fail(path, 'Trial frame and scope disagree.');
  if (trial.cursorSequence < trial.startedAtSequence || trial.cursorSequence > frame.lastSequence) fail(path, 'Invalid trial sequence window.');
  parseLabContract('RuntimeSnapshot', { ...frame, observations: trial.observations });
  parseLearningReference(trial.reference);
  unique(trial.definitions.map((definition) => definition.id), `${path}/definitions`);
  trial.definitions.forEach((definition) => parseLabContract('ApparatusDefinition', definition));
  unique(Object.values(trial.bindings), `${path}/bindings`);
  unique(trial.appliedEvents.map((event) => event.action.actionId), `${path}/appliedEvents`);
  unique(trial.appliedEvents.map((event) => String(event.sequence)), `${path}/appliedEvents`);
  unique(trial.observations.map((record) => record.id), `${path}/observations`);
  const inScope = (entry: { runId: string; stationId: string; epoch: number; sequence: number }) =>
    entry.runId === scope.runId && entry.stationId === scope.stationId && entry.epoch === scope.epoch &&
    entry.sequence > trial.startedAtSequence && entry.sequence <= trial.cursorSequence;
  let priorSequence = trial.startedAtSequence;
  for (const event of trial.appliedEvents) {
    parseLabContract('LabRuntimeEvent', event);
    if (!inScope(event) || event.sequence <= priorSequence || event.receipt.runtimeRevision > frame.revision || event.action.type === 'RESET') fail(path, 'Stale, unordered or foreign action evidence.');
    const target = frame.scene.apparatus.find((instance) => instance.id === event.action.targetInstanceId);
    if (target && target.stationId !== scope.stationId) fail(path, 'Action target belongs to another station.');
    if (event.action.expectedEpoch !== undefined && event.action.expectedEpoch !== scope.epoch) fail(path, 'Action expectedEpoch disagrees with the accepted receipt.');
    priorSequence = event.sequence;
  }
  priorSequence = trial.startedAtSequence;
  for (const observation of trial.observations) {
    parseLabContract('ObservationRecord', observation);
    if (!inScope(observation) || observation.sequence < priorSequence || trial.appliedEvents.some((event) => event.sequence === observation.sequence)) fail(path, 'Stale, unordered or foreign observation evidence.');
    priorSequence = observation.sequence;
  }
  unique(trial.readings.map((reading) => reading.observationId), `${path}/readings`);
  for (const reading of trial.readings) {
    const observed = trial.observations.find((record) => record.id === reading.observationId);
    if (!observed || reading.recordedAtSequence < observed.sequence || reading.recordedAtSequence > trial.cursorSequence) fail(path, 'Reading must cite this trial’s observation window.');
  }
  if ((trial.status === 'captured') !== (trial.endpoint !== null)) fail(path, 'Captured status requires endpoint evidence, and vice versa.');
  if (trial.endpoint) {
    const observed = trial.observations.find((record) => record.id === trial.endpoint!.observationId);
    if (!observed || trial.endpoint.capturedAtSequence < observed.sequence || trial.endpoint.capturedAtSequence !== trial.cursorSequence ||
      observed.observation.evidence !== trial.endpoint.evidence ||
      observed.observation.titration?.deliveredVolumeL !== trial.endpoint.deliveredVolume.value) fail(path, 'Endpoint does not match its frozen observation and cursor.');
  }
  if (trial.conclusion?.citedObservationIds.some((id) => !trial.observations.some((record) => record.id === id))) fail(path, 'Conclusion cites evidence outside this trial.');
}

export function parseLearningState(input: unknown): LearningState {
  inspect(input);
  check(learningStateJsonSchema, input, '');
  const state = input as LearningState;
  unique(state.attempts.map((attempt) => attempt.id), '/attempts');
  let events = 0;
  let observations = 0;
  for (const [index, attempt] of state.attempts.entries()) {
    const path = `/attempts/${index}`;
    definitionSemantics(attempt.definition, `${path}/definition`);
    unique(attempt.trials.map((trial) => trial.id), `${path}/trials`);
    unique(attempt.trials.map((trial) => canonicalJson(trial.scope)), `${path}/trials`);
    unique(attempt.trials.flatMap((trial) => trial.appliedEvents.map((event) => `${event.runId}:${event.action.actionId}`)), `${path}/events`);
    if (!attempt.trials.some((trial) => trial.id === attempt.activeTrialId)) fail(path, 'Active trial is missing.');
    if (attempt.trials.some((trial) => trial.status === 'active' && trial.id !== attempt.activeTrialId)) fail(path, 'Only the selected trial may remain active.');
    if (attempt.progression.instructionIndex >= attempt.definition.instructions.length) fail(path, 'Instruction cursor is outside the guide.');
    if (attempt.progression.hintsRequested.some((id) => !attempt.definition.goals.some((goal) => goal.id === id))) fail(path, 'Unknown hint.');
    unique(attempt.progression.hintsRequested, `${path}/progression/hintsRequested`);
    for (const trial of attempt.trials) {
      trialSemantics(trial, `${path}/trials/${trial.id}`);
      if (Object.keys(trial.bindings).some((role) => !Object.hasOwn(attempt.definition.roles, role))) fail(path, 'Unknown bound role.');
      events += trial.appliedEvents.length;
      observations += trial.observations.length;
    }
  }
  if (events > LEARNING_STATE_LIMITS.maxEvents || observations > LEARNING_STATE_LIMITS.maxObservations) fail('', 'Notebook evidence limit exceeded; no events were dropped.');
  return copyJson(state);
}

export function parseChallengeAttempt(input: unknown): ChallengeAttempt {
  return parseLearningState({ schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [input] }).attempts[0]!;
}

function rejectDuplicateKeys(json: string): void {
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    const frame = stack.at(-1);
    if (char === '{' || char === '[') stack.push({ object: char === '{', key: char === '{', keys: new Set() });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && frame?.object) frame.key = true;
    else if (char === ':' && frame?.object) frame.key = false;
    else if (char === '"') {
      const start = index++;
      while (index < json.length && json[index] !== '"') { if (json[index] === '\\') index++; index++; }
      if (frame?.object && frame.key) {
        const key = JSON.parse(json.slice(start, index + 1)) as string;
        if (frame.keys.has(key)) fail('', 'Duplicate JSON key.');
        frame.keys.add(key);
      }
    }
  }
}

export function parseLearningStateJson(json: string): LearningState {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > LEARNING_STATE_LIMITS.maxBytes) fail('', 'Learning JSON exceeds 4 MiB.');
  let value: unknown;
  try { value = JSON.parse(json); } catch { return fail('', 'Malformed learning JSON.'); }
  rejectDuplicateKeys(json);
  return parseLearningState(value);
}

export function serializeLearningState(state: LearningState): string {
  return canonicalJson(parseLearningState(state));
}
