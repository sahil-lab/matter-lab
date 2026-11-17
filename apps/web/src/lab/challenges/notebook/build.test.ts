import { describe, expect, it } from 'vitest';
import { buildPrecisionFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { PRECISION_TITRATION_OBJECTIVE } from '../titrationObjective';
import { buildNotebook } from './build';

describe('buildNotebook', () => {
  it('builds a trial row, a pH-vs-volume curve and a conclusion referencing only real numbers', () => {
    const ctx = buildPrecisionFixtureContext([0.0249, 0.025, 0.0251]);
    const notebook = buildNotebook(PRECISION_TITRATION_OBJECTIVE, ctx);

    expect(notebook.rows).toHaveLength(3);
    for (const row of notebook.rows) {
      expect(row.deliveredVolumeL).not.toBeNull();
      expect(row.equivalenceVolumeL).toBeCloseTo(0.025, 6);
      expect(row.evidence).toBe('MODEL_CALCULATED');
    }
    expect(notebook.curves).toHaveLength(3);
    for (const curve of notebook.curves) {
      expect(curve.points.length).toBeGreaterThan(5);
      // pH must be monotonically non-decreasing as volume increases for a strong acid/strong base titration.
      for (let i = 1; i < curve.points.length; i++) expect(curve.points[i]!.ph).toBeGreaterThanOrEqual(curve.points[i - 1]!.ph - 1e-9);
    }
    expect(notebook.meanVolumeL).not.toBeNull();
    expect(notebook.rsdPercent).not.toBeNull();
    expect(notebook.rsdPercent!).toBeLessThan(1);
    expect(notebook.conclusion.paragraphs.join(' ')).toContain('Mean measured endpoint volume');
    expect(notebook.conclusion.evidence).toBe('MODEL_CALCULATED');
  });

  it('never invents a conclusion when nothing has been measured yet', () => {
    const notebook = buildNotebook(PRECISION_TITRATION_OBJECTIVE, { scene: null, events: [], observations: [], trials: [], nowSimulationS: 0 });
    expect(notebook.rows).toHaveLength(0);
    expect(notebook.meanVolumeL).toBeNull();
    expect(notebook.conclusion.evidence).toBe('UNSUPPORTED');
  });
});
