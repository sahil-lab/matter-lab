import { LAB_LIMITS, hashNodeRunInput, parseLabContract, validateLabContract } from '../../../packages/contracts/src/index.ts';
import type { LabContractName } from '../../../packages/contracts/src/index.ts';
import { LearningStateError, parseLearningState } from '../../../apps/web/src/lab/challenges/persistence.ts';
import { parseEditorState } from '../../../apps/web/src/lab/editor/serialization.ts';
import { isDeepStrictEqual } from 'node:util';

const supported = new Set<string>(['ExperimentScene', 'RuntimeCheckpoint', 'NodeRunRequest', 'NodeRunResponse', 'ApparatusDefinition', 'LearningState', 'EditorState']);
const chunks: Buffer[] = [];
let bytes = 0;
try {
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > LAB_LIMITS.maxJsonBytes) throw new Error('Validation input exceeds the shared byte limit.');
    chunks.push(Buffer.from(chunk));
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (process.argv[2] === '--hash') {
    process.stdout.write(await hashNodeRunInput(parseLabContract('NodeRunRequest', input)));
  } else {
    const request = input as { readonly contract?: unknown; readonly value?: unknown };
    if (typeof request.contract !== 'string' || !supported.has(request.contract)) throw new Error('Unsupported validation request.');
    const editorValue = request.contract === 'EditorState' ? parseEditorState(request.value, String((request.value as { sceneId?: unknown })?.sceneId)) : undefined;
    if (editorValue && !isDeepStrictEqual(editorValue, request.value)) throw new Error('Use canonical editor serialization; metadata cannot be silently pruned on save.');
    const result = editorValue ? { ok: true, value: editorValue } as const
      : request.contract === 'LearningState' ? { ok: true, value: parseLearningState(request.value) } as const
        : validateLabContract(request.contract as LabContractName, request.value);
    process.stdout.write(JSON.stringify(result.ok ? { ok: true } : { ok: false, errors: result.errors }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, errors: [{
    code: 'INVALID_INPUT', path: error instanceof LearningStateError ? error.path : '',
    message: error instanceof LearningStateError ? error.message.slice(0, 2048) : 'Invalid or oversized shared-contract validation request.',
  }] }));
}
