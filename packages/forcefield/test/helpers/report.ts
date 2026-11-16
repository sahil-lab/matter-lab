/**
 * Collects the deviations measured by the test suite. Every section is printed (run vitest with
 * `--silent=false` to see it) and, when the environment variable UFF_WRITE_REPORT is set, written
 * to `packages/forcefield/test-results/validation-<section>.json`. The numbers quoted in the README
 * come from those files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function publish(section: string, data: Record<string, unknown>): void {
  console.log(`[uff-validation] ${section}: ${JSON.stringify(data)}`);
  if (process.env.UFF_WRITE_REPORT) {
    const dir = process.env.UFF_REPORT_DIR ?? fileURLToPath(new URL('../../test-results/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `validation-${section}.json`), `${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Keeps track of the largest value seen and where it occurred. */
export class Worst {
  value = 0;
  where = '';

  note(value: number, where: string): void {
    if (value > this.value || this.where === '') {
      this.value = value;
      this.where = where;
    }
  }

  toJSON(): { value: number; where: string } {
    return { value: this.value, where: this.where };
  }
}
