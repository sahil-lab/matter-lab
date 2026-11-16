import { describe, expect, it } from 'vitest';
import { buildFixtureContext, buildPrecisionFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { GUIDED_TITRATION_OBJECTIVE, PRECISION_TITRATION_OBJECTIVE } from '../titrationObjective';
import { scoreAttempt } from './rubric';

describe('scoreAttempt', () => {
  it('scores a well-controlled, accurately-marked titration highly on setup/operation/endpoint', () => {
    const ctx = buildFixtureContext();
    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    const byId = Object.fromEntries(score.dimensions.map((d) => [d.id, d]));
    expect(byId.setup!.score01).toBe(1);
    expect(byId.endpointDetection!.score01).toBeGreaterThan(0.9);
    expect(byId.instrumentOperation!.score01).toBeGreaterThan(0.6);
    expect(score.overall01).toBeGreaterThan(0.5);
    expect(score.deterministic).toBe(true);
  });

  it('is a pure function: scoring the same context twice gives byte-identical numbers', () => {
    const ctx = buildFixtureContext();
    const a = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    const b = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('penalises a single huge dump of titrant (poor instrument operation) and flags overshoot', () => {
    const sloppy = buildFixtureContext({ coarseStepL: 0.05, fineStepL: 0.05, overshootToL: 0.045, markedVolumeL: 0.045 });
    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, sloppy);
    const operation = score.dimensions.find((d) => d.id === 'instrumentOperation')!;
    expect(operation.score01).toBeLessThan(0.5);
    expect(operation.detail.toLowerCase()).toContain('overshot');
  });

  it('reports endpoint detection as UNSUPPORTED when no endpoint has been marked yet', () => {
    const ctx = { scene: null, events: [], runResults: [], trials: [], nowSimulationS: 0 } as const;
    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    const endpoint = score.dimensions.find((d) => d.id === 'endpointDetection')!;
    expect(endpoint.evidence).toBe('UNSUPPORTED');
    expect(endpoint.score01).toBe(0);
  });

  it('rewards low relative standard deviation across repeat trials and penalises high RSD', () => {
    const tight = buildPrecisionFixtureContext([0.0249, 0.025, 0.0251]);
    const loose = buildPrecisionFixtureContext([0.02, 0.025, 0.032]);
    const tightScore = scoreAttempt(PRECISION_TITRATION_OBJECTIVE, tight);
    const looseScore = scoreAttempt(PRECISION_TITRATION_OBJECTIVE, loose);
    const tightRepeat = tightScore.dimensions.find((d) => d.id === 'measurementRepeatability')!;
    const looseRepeat = looseScore.dimensions.find((d) => d.id === 'measurementRepeatability')!;
    expect(tightRepeat.score01).toBeGreaterThan(looseRepeat.score01);
  });

  it('needs at least two trials to score repeatability at all', () => {
    const ctx = buildFixtureContext();
    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    const repeat = score.dimensions.find((d) => d.id === 'measurementRepeatability')!;
    expect(repeat.evidence).toBe('UNVERIFIED');
  });
});
