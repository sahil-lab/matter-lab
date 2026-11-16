import { LAB_LIMITS, hashNodeRunInput, parseLabContract, validateLabContract } from '../../../packages/contracts/src/index.ts';
import type { LabContractName } from '../../../packages/contracts/src/index.ts';

const supported = new Set<LabContractName>(['ExperimentScene', 'RuntimeCheckpoint', 'NodeRunRequest', 'NodeRunResponse', 'ApparatusDefinition']);
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
    if (typeof request.contract !== 'string' || !supported.has(request.contract as LabContractName)) throw new Error('Unsupported validation request.');
    const result = validateLabContract(request.contract as LabContractName, request.value);
    process.stdout.write(JSON.stringify(result.ok ? { ok: true } : { ok: false, errors: result.errors }));
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, errors: [{ code: 'INVALID_INPUT', path: '', message: 'Invalid or oversized shared-contract validation request.' }] }));
}
