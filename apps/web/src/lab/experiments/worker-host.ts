import { parseExperimentScene, serializeExperimentScene, UUID_PATTERN } from '@matterlab/contracts';
import {
  asProblem, createStandardLabRuntime, LabRuntimeError, problem, restoreLabRuntime, standardRuntimeDependencies,
} from '@matterlab/lab-runtime';
import type { LabRuntime } from '@matterlab/lab-runtime';
import type { ApparatusDefinitionReader, LabRuntimeEvent } from '@matterlab/contracts';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse, RuntimeWorkerValue } from './protocol';

export function createRuntimeWorkerHost(send: (response: RuntimeWorkerResponse) => void): (request: RuntimeWorkerRequest) => Promise<void> {
  let runtime: LabRuntime | undefined;
  let tail: Promise<void> = Promise.resolve();
  let events: LabRuntimeEvent[] = [];
  return (request) => {
    const task = async (): Promise<void> => {
      events = [];
      if (!request || typeof request.requestId !== 'string' || !new RegExp(UUID_PATTERN).test(request.requestId)) return;
      try {
        let value: RuntimeWorkerValue;
        if (request.type === 'INIT') {
          if (runtime) throw new LabRuntimeError(problem('INVALID_PHASE', 'A worker runtime cannot replace its immutable initial state; create a new worker/run.'));
          const definitions: ApparatusDefinitionReader = {
            getDefinition: (id) => request.options.definitions.find((definition) => definition.id === id),
            listDefinitions: () => request.options.definitions,
          };
          const scene = parseExperimentScene(request.options.initialScene);
          const checkpoint = request.options.checkpoint;
          if (checkpoint) {
            if (checkpoint.snapshot.runId !== request.options.runId ||
                serializeExperimentScene({ ...scene, revision: checkpoint.snapshot.scene.revision }) !== serializeExperimentScene(checkpoint.snapshot.scene)) {
              throw new LabRuntimeError(problem('INPUT_HASH_MISMATCH', 'Saved scene and checkpoint do not identify the same runtime state.'));
            }
            runtime = await restoreLabRuntime(checkpoint, standardRuntimeDependencies(definitions));
          } else {
            runtime = await createStandardLabRuntime({
              initialScene: scene, runId: request.options.runId, definitions,
              ...(request.options.limits ? { limits: request.options.limits } : {}),
            });
          }
          runtime.reader.subscribe((_snapshot, event) => { events.push(event); });
          value = runtime.reader.getSnapshot();
        } else {
          if (!runtime) throw new LabRuntimeError(problem('INVALID_PHASE', 'Initialize the runtime before dispatching commands.'));
          switch (request.type) {
            case 'ACTION': value = await runtime.actions.dispatch(request.action); break;
            case 'CONTROL': value = await runtime.actions.control(request.control); break;
            case 'BATCH': value = await runtime.dispatchBatch(request.actions); break;
            case 'ADVANCE': value = await runtime.advanceStation(request.stationId, request.ticks); break;
            case 'CHECKPOINT': value = await runtime.getCheckpoint(); break;
            case 'SUPPORT': value = runtime.getModelSupport(request.stationId); break;
            default: throw new LabRuntimeError(problem('INVALID_ACTION', 'Unknown worker operation.'));
          }
        }
        send({
          requestId: request.requestId, ok: true, value, events,
          ...(request.type === 'CHECKPOINT' || request.type === 'SUPPORT' ? {} : { snapshot: runtime!.reader.getSnapshot() }),
        });
      } catch (error) {
        send({ requestId: request.requestId, ok: false, error: asProblem(error), events,
          ...(runtime ? { snapshot: runtime.reader.getSnapshot() } : {}) });
      }
    };
    tail = tail.then(task, task);
    return tail;
  };
}
