import { ContractValidationError, LAB_LIMITS } from './common.ts';
import type { JsonValue, ProblemDetails, ValidationIssue, ValidationResult } from './common.ts';
import type { LabAction, ReplayStep, RuntimeControl } from './actions.ts';
import type { ApparatusDefinition, VesselCalibration } from './apparatus.ts';
import type {
  ActionReceipt, ControlReceipt, LabRuntimeEvent, NodeRunRequest, NodeRunResponse, RuntimeCheckpoint, RuntimeSnapshot, RuntimeSolverRequest,
} from './runtime.ts';
import type { ApparatusInstance, Connection, ContainerContents, ExperimentAssembly, ExperimentScene } from './scene.ts';
import type {
  EquilibriumInput, EquilibriumResult, Observation, ObservationRecord,
  PreparationInput, PreparationResult, RunResult, TerminalRunResult,
} from './science.ts';
import { canonicalJson, checkSchema, freezeJson, inspectJson, issue } from './schema-validation.ts';
import { validateSemantics } from './semantic-validation.ts';

export interface LabContractTypes {
  readonly ExperimentScene: ExperimentScene;
  readonly ExperimentAssembly: ExperimentAssembly;
  readonly ApparatusInstance: ApparatusInstance;
  readonly ApparatusDefinition: ApparatusDefinition;
  readonly VesselCalibration: VesselCalibration;
  readonly Connection: Connection;
  readonly ContainerContents: ContainerContents;
  readonly LabAction: LabAction;
  readonly RuntimeControl: RuntimeControl;
  readonly ReplayStep: ReplayStep;
  readonly EquilibriumInput: EquilibriumInput;
  readonly EquilibriumResult: EquilibriumResult;
  readonly PreparationInput: PreparationInput;
  readonly PreparationResult: PreparationResult;
  readonly Observation: Observation;
  readonly ObservationRecord: ObservationRecord;
  readonly RunResult: RunResult;
  readonly TerminalRunResult: TerminalRunResult;
  readonly RuntimeSnapshot: RuntimeSnapshot;
  readonly RuntimeCheckpoint: RuntimeCheckpoint;
  readonly LabRuntimeEvent: LabRuntimeEvent;
  readonly ActionReceipt: ActionReceipt;
  readonly ControlReceipt: ControlReceipt;
  readonly NodeRunRequest: NodeRunRequest;
  readonly NodeRunResponse: NodeRunResponse;
  readonly RuntimeSolverRequest: RuntimeSolverRequest;
  readonly ProblemDetails: ProblemDetails;
}
export type LabContractName = keyof LabContractTypes;

export function validateLabContract<Name extends LabContractName>(
  name: Name, input: unknown,
): ValidationResult<LabContractTypes[Name]> {
  const errors: ValidationIssue[] = [];
  try {
    inspectJson(input, errors);
    if (errors.length === 0) checkSchema({ $ref: `#/$defs/${name}` }, input, '', errors, validateSemantics);
    if (errors.length === 0) {
      const value = JSON.parse(JSON.stringify(input)) as LabContractTypes[Name];
      return Object.freeze({ ok: true, value: freezeJson(value) });
    }
  } catch {
    issue(errors, '', 'Input could not be safely inspected or serialized.', 'SERIALIZATION_FAILED');
  }
  return freezeJson({ ok: false, errors });
}
export function parseLabContract<Name extends LabContractName>(name: Name, input: unknown): LabContractTypes[Name] {
  const result = validateLabContract(name, input);
  if (!result.ok) throw new ContractValidationError(result.errors);
  return result.value;
}

function rejectDuplicateKeys(text: string): void {
  const stack: { object: boolean; expectingKey: boolean; keys: Set<string> }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const frame = stack[stack.length - 1];
    if (char === '{' || char === '[') stack.push({ object: char === '{', expectingKey: char === '{', keys: new Set() });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && frame?.object) frame.expectingKey = true;
    else if (char === ':' && frame?.object) frame.expectingKey = false;
    else if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (frame?.object && frame.expectingKey) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (frame.keys.has(key)) throw new ContractValidationError([{
          code: 'SERIALIZATION_FAILED', path: '', message: 'Duplicate JSON object keys are not permitted.',
        }]);
        frame.keys.add(key);
      }
    }
  }
}

export function parseLabJson<Name extends LabContractName>(name: Name, json: string): LabContractTypes[Name] {
  if (typeof json !== 'string') throw new ContractValidationError([{ code: 'INVALID_INPUT', path: '', message: 'Expected JSON text.' }]);
  if (json.length > LAB_LIMITS.maxJsonBytes || new TextEncoder().encode(json).byteLength > LAB_LIMITS.maxJsonBytes) {
    throw new ContractValidationError([{ code: 'LIMIT_EXCEEDED', path: '', message: 'JSON byte limit exceeded.' }]);
  }
  let data: unknown;
  try {
    data = JSON.parse(json) as unknown;
  } catch {
    throw new ContractValidationError([{ code: 'SERIALIZATION_FAILED', path: '', message: 'Malformed JSON.' }]);
  }
  rejectDuplicateKeys(json);
  return parseLabContract(name, data);
}
export function serializeLabContract<Name extends LabContractName>(name: Name, input: LabContractTypes[Name]): string {
  return canonicalJson(parseLabContract(name, input) as unknown as JsonValue);
}

export const validateExperimentScene = (input: unknown): ValidationResult<ExperimentScene> => validateLabContract('ExperimentScene', input);
export const parseExperimentScene = (input: unknown): ExperimentScene => parseLabContract('ExperimentScene', input);
export const serializeExperimentScene = (scene: ExperimentScene): string => serializeLabContract('ExperimentScene', scene);
export const deserializeExperimentScene = (json: string): ExperimentScene => parseLabJson('ExperimentScene', json);
export const validateLabAction = (input: unknown): ValidationResult<LabAction> => validateLabContract('LabAction', input);
export const parseLabAction = (input: unknown): LabAction => parseLabContract('LabAction', input);
export const validateApparatusDefinition = (input: unknown): ValidationResult<ApparatusDefinition> => validateLabContract('ApparatusDefinition', input);
export const parseApparatusDefinition = (input: unknown): ApparatusDefinition => parseLabContract('ApparatusDefinition', input);

/** RFC 8785/JCS canonical request, excluding only runId. Version pins and explicit limits remain. */
export function canonicalizeNodeRunInput(input: NodeRunRequest): string {
  const request = parseLabContract('NodeRunRequest', input);
  const hashInput = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'runId'));
  return canonicalJson(hashInput as JsonValue);
}
export async function hashNodeRunInput(input: NodeRunRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeNodeRunInput(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
