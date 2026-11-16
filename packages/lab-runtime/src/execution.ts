import { LAB_CONTRACT_VERSION, hashNodeRunInput, parseLabContract } from '@matterlab/contracts';
import type { ApparatusDefinitionReader, NodeRunRequest, NodeRunResponse, ProblemDetails } from '@matterlab/contracts';
import {
  DEFAULT_ASSUMPTIONS, SCIENCE_METHOD_ID, SCIENCE_METHOD_VERSION, solveEquilibrium,
} from '@matterlab/lab-science';
import { asProblem, problem } from './errors.ts';
import { applyReplayStep, createLabRuntime, LAB_RUNTIME_VERSION, RuntimeEngine } from './runtime.ts';
import type { LabRuntime, LabRuntimeOptions, RuntimeDependencies } from './types.ts';

export function standardRuntimeDependencies(definitions: ApparatusDefinitionReader): RuntimeDependencies {
  return {
    definitions,
    science: {
      solve: solveEquilibrium, methodId: SCIENCE_METHOD_ID,
      methodVersion: SCIENCE_METHOD_VERSION, assumptions: DEFAULT_ASSUMPTIONS,
    },
  };
}
export function createStandardLabRuntime(
  options: Pick<LabRuntimeOptions, 'initialScene' | 'runId' | 'definitions' | 'limits'>,
): Promise<LabRuntime> {
  return createLabRuntime({ ...standardRuntimeDependencies(options.definitions), ...options });
}

export async function executeNodeRun(
  input: NodeRunRequest, dependencies: RuntimeDependencies,
): Promise<NodeRunResponse> {
  const request = parseLabContract('NodeRunRequest', input);
  const inputHash = await hashNodeRunInput(request);
  let runtime: RuntimeEngine | undefined;
  let initialized = false;
  let completedStepCount = 0;
  let failure: ProblemDetails | undefined;
  try {
    if (request.contractVersion !== LAB_CONTRACT_VERSION || request.runtimeVersion !== LAB_RUNTIME_VERSION ||
        request.methodVersion !== dependencies.science.methodVersion) {
      throw problem('METHOD_VERSION_MISMATCH', 'Requested contract/runtime/science versions do not match this execution release.');
    }
    if (request.initialScene.simulationConfig.methodId !== dependencies.science.methodId) {
      throw problem('UNSUPPORTED_MODEL', 'Requested science method is not available in this release.');
    }
    runtime = new RuntimeEngine({
      ...dependencies, initialScene: request.initialScene, runId: request.runId,
      ...(request.limits ? { limits: request.limits } : {}),
    });
    await runtime.initialize();
    initialized = true;
    for (const step of request.steps) {
      await applyReplayStep(runtime, step);
      completedStepCount++;
    }
  } catch (error) {
    const typed = typeof error === 'object' && error !== null && 'code' in error && 'detail' in error;
    failure = typed ? parseLabContract('ProblemDetails', error) : asProblem(error);
  }
  if (!runtime || !initialized) {
    const error = failure ?? problem('RUNTIME_ERROR', 'Runtime could not initialize.', 500);
    runtime?.dispose();
    return parseLabContract('NodeRunResponse', {
      schemaVersion: 1,
      result: {
        runId: request.runId, status: error.code.startsWith('UNSUPPORTED') ? 'UNSUPPORTED' : 'FAILED',
        methodId: request.initialScene.simulationConfig.methodId, methodVersion: request.methodVersion, inputHash,
        observations: [], warnings: [], assumptions: [], limitations: ['No execution was completed.'],
        error, solverDiagnostics: { contractVersion: LAB_CONTRACT_VERSION, runtimeVersion: LAB_RUNTIME_VERSION, initialized: false },
      },
    });
  }
  try {
    const prefix = await runtime.getCheckpoint();
    const result = runtime.makeResult(inputHash, failure);
    return parseLabContract('NodeRunResponse', {
      schemaVersion: 1, result,
      checkpoint: { ...prefix, inputHash, steps: request.steps, completedStepCount, ...(request.limits ? { limits: request.limits } : {}) },
    });
  } finally {
    runtime.dispose();
  }
}
