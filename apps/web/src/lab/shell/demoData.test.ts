import { describe, expect, it } from 'vitest';
import { pairVolumeAndPh } from './contracts';
import { buildDemoObservations, buildDemoRunResult, buildDemoScene, DEMO_APPARATUS_CATALOG } from './demoData';

describe('demoData', () => {
  it('tags every sample observation as ILLUSTRATIVE, never a stronger evidence level', () => {
    const observations = buildDemoObservations(30, 24);
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) expect(o.evidence).toBe('ILLUSTRATIVE');
  });

  it('produces a chart point that lands exactly on the sample equivalence and endpoint volumes', () => {
    const equivalenceMl = 25;
    const endpointMl = 25.18;
    const observations = buildDemoObservations(30, 24, equivalenceMl, endpointMl);
    const points = pairVolumeAndPh(observations);
    const hasEquivalencePoint = points.some((p) => Math.abs(p.volumeL - equivalenceMl / 1000) < 1e-9);
    const hasEndpointPoint = points.some((p) => Math.abs(p.volumeL - endpointMl / 1000) < 1e-9);
    expect(hasEquivalencePoint).toBe(true);
    expect(hasEndpointPoint).toBe(true);
  });

  it('keeps the run result solverDiagnostics consistent with the observations it was built from', () => {
    const observations = buildDemoObservations(30, 24);
    const run = buildDemoRunResult(observations);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.solverDiagnostics?.equivalenceVolumeL).toBeCloseTo(0.025);
    const points = pairVolumeAndPh(observations);
    const hasEndpointPoint = points.some((p) => Math.abs(p.volumeL - (run.solverDiagnostics!.endpointVolumeL as number)) < 1e-9);
    expect(hasEndpointPoint).toBe(true);
  });

  it('warns unambiguously that the sample run is not a scientific result', () => {
    const run = buildDemoRunResult(buildDemoObservations(10, 4));
    expect(run.warnings.join(' ')).toMatch(/not a scientific result/i);
  });

  it('builds a scene with the eight P0 vertical-slice instruments present and marked as such', () => {
    const scene = buildDemoScene();
    const p0Kinds = new Set(scene.apparatus.map((a) => a.kind));
    for (const kind of ['BENCH', 'STAND', 'BURETTE', 'FLASK', 'STIRRER', 'PH_PROBE'] as const) expect(p0Kinds.has(kind)).toBe(true);
    expect(scene.stations.length).toBeGreaterThanOrEqual(2);
  });

  it('marks exactly the documented P0 catalog entries, leaving the rest unmarked', () => {
    const p0 = DEMO_APPARATUS_CATALOG.filter((a) => a.vertical_slice);
    expect(p0.length).toBe(8);
    const nonP0 = DEMO_APPARATUS_CATALOG.filter((a) => !a.vertical_slice);
    expect(nonP0.length).toBeGreaterThan(0);
  });

  it('gives every catalog entry a definition id unique within the catalog', () => {
    const ids = DEMO_APPARATUS_CATALOG.map((a) => a.definitionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
