/*
 * The example experiments that ship with the documentation (docs/examples/experiments) are results
 * of the engine, not hand-written files. This test runs each of them again and requires the file
 * to be exactly what the engine produces, so the examples cannot drift from the code.
 *
 * To write the files afresh after an intended change:
 *   $env:MATTERLAB_WRITE_EXAMPLES = '1'; vitest run --project reactions packages/reactions/test/examples.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPERIMENT_PRESETS, parseExperimentResult, runExperiment, serializeExperimentResult } from '../src';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'examples', 'experiments');
const write = process.env.MATTERLAB_WRITE_EXAMPLES === '1';

/** One example of each kind of outcome: thermodynamics only, away from 298 K, with kinetics, in solution, and a refusal. */
const SHIPPED = ['methane-combustion', 'ammonia-synthesis-700k', 'no-o3-kinetics', 'silver-chloride-precipitation', 'iron-oxidation-missing-data'] as const;

describe('the example experiments of the documentation', () => {
  for (const id of SHIPPED) {
    it(`${id} is exactly what the engine produces`, () => {
      const preset = EXPERIMENT_PRESETS.find((candidate) => candidate.id === id);
      expect(preset, `preset ${id}`).toBeDefined();
      const text = `${serializeExperimentResult(runExperiment(preset!.input), 1)}\n`;
      const file = join(directory, `${id}.experiment.json`);
      if (write) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(file, text);
      }
      expect(existsSync(file), `${file} is missing; see the header of this test for how to write it`).toBe(true);
      // A checkout may have turned the line ends into CR LF; nothing else may differ.
      const shipped = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      expect(shipped).toBe(text);

      // The file is one the application accepts, and it says what the preset is meant to show.
      const read = parseExperimentResult(shipped);
      expect(read.status).toBe(preset!.expectedStatus);
      expect(read.input.title).toBe(preset!.input.title);
    });
  }
});
