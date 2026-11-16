import { LAB_LIMITS, parseLabJson, serializeLabContract } from '@matterlab/contracts';
import { apparatusRegistry } from '../../../apps/web/src/lab/apparatus/registry.ts';
import { asProblem } from './errors.ts';
import { executeNodeRun, standardRuntimeDependencies } from './execution.ts';

try {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk as Buffer;
    length += bytes.byteLength;
    if (length > LAB_LIMITS.maxJsonBytes) throw new Error('Runtime stdin exceeds the laboratory JSON byte limit.');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const request = parseLabJson('NodeRunRequest', text);
  const response = await executeNodeRun(request, standardRuntimeDependencies(apparatusRegistry));
  process.stdout.write(`${serializeLabContract('NodeRunResponse', response)}\n`);
} catch (error) {
  process.stdin.destroy();
  process.stderr.write(`${JSON.stringify(asProblem(error))}\n`);
  process.exitCode = 64;
}
