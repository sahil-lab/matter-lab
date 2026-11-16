import { solveJson } from './json.js';
import { MODEL_LIMITS } from './model.js';
import { failure } from './provenance.js';

async function main(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let input = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MODEL_LIMITS.maximumJsonBytes) {
      process.stdout.write(`${JSON.stringify(failure('FAILED', 'INVALID_INPUT', `Science JSON input must be at most ${MODEL_LIMITS.maximumJsonBytes} UTF-8 bytes.`))}\n`);
      process.stdin.destroy();
      return;
    }
    input += text;
  }
  process.stdout.write(`${solveJson(input)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(failure('FAILED', 'SOLVER_FAILED', 'Science CLI transport failed.'))}\n`);
  process.exitCode = 1;
});
