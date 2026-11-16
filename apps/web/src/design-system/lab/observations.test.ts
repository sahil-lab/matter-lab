import type { Observation, ObservationRecord, RunResult } from '@matterlab/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ObservationTimeline } from './ObservationTimeline';
import { ScientificExplanationPanel, safeReferenceUrl } from './ScientificExplanationPanel';
import { TitrationHUD } from './TitrationHUD';
import { latestObservation, observationDisplay, titrationPlotData } from './observations';

const RUN = '00000000-0000-4000-8000-000000000001';
const STATION = '00000000-0000-4000-8000-000000000002';
const SOURCE = '00000000-0000-4000-8000-000000000003';
const RECEIVER = '00000000-0000-4000-8000-000000000004';
const OTHER = '00000000-0000-4000-8000-000000000005';
const SCOPE = Object.freeze({ runId: RUN, stationId: STATION, epoch: 2, apparatusId: RECEIVER });

// Synthetic UI fixtures, deliberately not advertised as scientific benchmarks or gallery results.
const PH: Extract<Observation, { type: 'PH' }> = Object.freeze({
  type: 'PH', apparatusId: RECEIVER, timeS: 1.5, quantity: { value: 5.4321, unit: 'pH' as const, uncertainty: .003 },
  evidence: 'MODEL_CALCULATED', methodId: 'ui-test-method', methodVersion: 'fixture', sourceIds: ['ui-test-source'],
  titration: { sourceInstanceId: SOURCE, receiverInstanceId: RECEIVER, deliveredVolumeL: .004321 },
});
const VOLUME: Observation = {
  type: 'VOLUME', apparatusId: SOURCE, timeS: 1.5, quantity: { value: .019876, unit: 'L' },
  evidence: 'MODEL_CALCULATED', methodId: 'ui-test-inventory', sourceIds: ['ui-test-source'],
};
const record = (sequence: number, observation: Observation = PH, overrides: Partial<Omit<ObservationRecord, 'observation'>> = {}): ObservationRecord =>
  Object.freeze({ id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, runId: RUN, stationId: STATION, epoch: 2, sequence, observation, ...overrides });
const run = (status: 'SUCCEEDED' | 'FAILED' | 'UNSUPPORTED' = 'SUCCEEDED'): RunResult => ({
  runId: RUN, methodId: 'ui-test-method', methodVersion: 'fixture', inputHash: 'fixture-hash',
  observations: [PH], warnings: ['Fixture warning'], assumptions: ['Fixture assumption'], limitations: ['Fixture limitation'],
  ...(status === 'SUCCEEDED' ? { status } : { status, error: { type: 'urn:test', title: 'Fixture unavailable', status: 422, detail: 'No valid output exists for this fixture.', code: 'UNSUPPORTED_MODEL' } }),
});

describe('canonical observation presentation', () => {
  it('chooses the latest matching sequence without mixing another run, station, apparatus or reset epoch', () => {
    const latest = record(20);
    const records = Object.freeze([
      latest, record(10), record(100, PH, { epoch: 1 }), record(110, PH, { stationId: OTHER }),
      record(120, PH, { runId: OTHER }), record(130, { ...PH, apparatusId: OTHER }), record(200, VOLUME),
    ]);
    expect(latestObservation(records, SCOPE, 'PH')).toBe(latest);
    expect(latestObservation(records, { ...SCOPE, epoch: 3 }, 'PH')).toBeNull();
    expect(records[0]).toBe(latest);
  });

  it('distinguishes zero and zero uncertainty from missing, stale, invalid and unsupported values', () => {
    expect(observationDisplay({ ...PH, quantity: { value: 0, unit: 'pH', uncertainty: 0 } }, 'current')).toMatchObject({ value: '0', uncertainty: '0', available: true });
    expect(observationDisplay(PH, 'stale')).toMatchObject({ value: '5.4321', message: 'Previously recorded · not a live reading' });
    expect(observationDisplay({ ...PH, quantity: { value: Number.NaN, unit: 'pH' } }, 'current')).toMatchObject({ value: '—', available: false });
    expect(observationDisplay({ ...PH, evidence: 'UNSUPPORTED' }, 'current')).toMatchObject({ value: '—', message: 'Unsupported' });
    expect(observationDisplay(null, 'current')).toMatchObject({ value: '—', message: 'No observation' });
  });

  it('quotes the runtime transfer stamp and never deduces a delivered amount or endpoint from pH', () => {
    const html = renderToStaticMarkup(createElement(TitrationHUD, { scope: SCOPE, ph: record(1), remaining: record(2, VOLUME) }));
    expect(html).toContain('5.4321');
    expect(html).toContain('0.004321');
    expect(html).toContain('0.019876');
    expect(html.match(/Not reported/g)).toHaveLength(2);
    expect(html).not.toContain('reached');
    const unpaired = renderToStaticMarkup(createElement(TitrationHUD, { scope: SCOPE, ph: record(1, { ...PH, titration: undefined }), remaining: record(2, VOLUME) }));
    expect(unpaired).toContain('No paired transfer sample');
    expect(unpaired).not.toContain('0.004321');
  });

  it('withholds current values and reached milestones for failed, unsupported, loading and empty operations', () => {
    for (const status of ['unsupported', 'error', 'loading', 'empty'] as const) {
      const html = renderToStaticMarkup(createElement(TitrationHUD, { scope: SCOPE, status, ph: record(1), remaining: record(2, VOLUME), endpoint: { state: 'reached' }, equivalence: { state: 'reached' } }));
      expect(html, status).not.toContain('5.4321');
      expect(html, status).not.toContain('0.019876');
      expect(html, status).not.toContain('0.004321');
      expect(html, status).not.toContain('reached');
    }
    const otherEpoch = renderToStaticMarkup(createElement(TitrationHUD, { scope: SCOPE, ph: record(1, PH, { epoch: 1 }) }));
    expect(otherEpoch).not.toContain('5.4321');
  });

  it('uses only scoped, time-matched canonical indicator state and never synthesizes legacy colors', () => {
    const indicator: Extract<Observation, { type: 'INDICATOR' }> = {
      type: 'INDICATOR', apparatusId: RECEIVER, timeS: PH.timeS, quantity: { value: .37, unit: '1' },
      evidence: 'MODEL_CALCULATED', methodId: PH.methodId, sourceIds: PH.sourceIds, indicatorId: 'ui-test-indicator',
      indicatorState: { indicatorId: 'ui-test-indicator', baseFraction: .37, colorSrgb: [.2, .4, .8], colorEvidence: 'ILLUSTRATIVE', sourceIds: PH.sourceIds },
    };
    const props = { scope: SCOPE, ph: record(1) };
    const html = renderToStaticMarkup(createElement(TitrationHUD, { ...props, indicator: record(2, indicator) }));
    expect(html).toContain('background:rgb(20% 40% 80%)');
    expect(html).toContain('Solver-provided color / illustrative');
    for (const unavailable of [
      record(2, { ...indicator, indicatorState: undefined }),
      record(2, { ...indicator, timeS: 0 }),
      record(2, indicator, { stationId: OTHER }),
      record(2, indicator, { epoch: 1 }),
    ]) {
      const missing = renderToStaticMarkup(createElement(TitrationHUD, { ...props, indicator: unavailable }));
      expect(missing).not.toContain('background:rgb(20% 40% 80%)');
      expect(missing).toContain('No supported color observation');
    }
  });
});

describe('recorded titration plot and ledger', () => {
  it('uses exact source/receiver pairs and gaps incomplete samples rather than manufacturing a curve', () => {
    const last = record(3, { ...PH, quantity: { value: 5.6789, unit: 'pH' }, titration: { sourceInstanceId: SOURCE, receiverInstanceId: RECEIVER, deliveredVolumeL: .006 } });
    const records = Object.freeze([last, record(1), record(2, { ...PH, titration: undefined }), record(4, PH, { stationId: OTHER })]);
    const data = titrationPlotData(records, SCOPE);
    expect(data.sampleCount).toBe(2);
    expect(data.omitted).toBe(1);
    expect(data.series[0]?.points.map((point) => point?.deliveredVolumeL ?? null)).toEqual([.004321, null, .006]);
    expect(data.series[0]?.points.map((point) => point?.pH ?? null)).toEqual([5.4321, null, 5.6789]);
    expect(records[0]).toBe(last);
  });

  it('separates changed methods, excludes unverified numbers and reports the bounded plot window', () => {
    const data = titrationPlotData([
      record(1), record(2, { ...PH, methodId: 'second-method' }), record(3, { ...PH, evidence: 'UNVERIFIED' }),
    ], SCOPE);
    expect(data.series).toHaveLength(2);
    expect(data.omitted).toBe(1);
    expect(data.series.flatMap((series) => series.points).filter(Boolean)).toHaveLength(2);
    expect(titrationPlotData([record(1), record(2), record(3)], SCOPE, 2)).toMatchObject({ truncated: 1, sampleCount: 2 });
  });

  it('renders no plot for missing or unsuccessful data and only the selected epoch in the keyboard ledger', () => {
    const empty = renderToStaticMarkup(createElement(ObservationTimeline, { records: [], scope: SCOPE }));
    expect(empty).toContain('No paired pH samples');
    expect(empty).not.toContain('Recorded pH against delivered volume');
    const failed = renderToStaticMarkup(createElement(ObservationTimeline, { records: [record(1)], scope: SCOPE, status: 'unsupported' }));
    expect(failed).not.toContain('5.4321');
    const ledger = renderToStaticMarkup(createElement(ObservationTimeline, { records: [record(1), record(2, { ...PH, quantity: { value: 8.76543, unit: 'pH' } }, { epoch: 1 })], scope: SCOPE, defaultView: 'table' }));
    expect(ledger).toContain('5.4321');
    expect(ledger).not.toContain('8.76543');
    expect(ledger).toContain('ui-test-source');
    expect(ledger).toContain('Recorded observations in original units');
  });
});

describe('scientific explanation truth gates', () => {
  it('can explain recorded observations before a frozen run exists without claiming a completed experiment', () => {
    const html = renderToStaticMarkup(createElement(ScientificExplanationPanel, { run: null, observations: [PH] }));
    expect(html).toContain('5.4321');
    expect(html).toContain('No frozen run envelope was supplied');
    expect(html).toContain('not as a completed experiment');
    expect(html).not.toContain('No calculation selected');
    expect(html).not.toContain('SUCCEEDED');
  });

  it('never presents leftover observations or a stale summary as the result of a failed operation', () => {
    for (const status of ['FAILED', 'UNSUPPORTED'] as const) {
      const html = renderToStaticMarkup(createElement(ScientificExplanationPanel, { run: run(status), defaultDepth: 'advanced', summary: 'Stale 5.4321 result' }));
      expect(html).not.toContain('5.4321');
      expect(html).toContain('UNSUPPORTED_MODEL');
      expect(html).toContain('Fixture assumption');
      expect(html).toContain('Fixture limitation');
      expect(html).toContain('No numeric result from this operation is displayed');
    }
  });

  it('shows supplied method, equation, uncertainty, references and diagnostics without filling gaps', () => {
    const html = renderToStaticMarkup(createElement(ScientificExplanationPanel, {
      run: { ...run(), solverDiagnostics: { convergence: 'fixture-only' } }, defaultDepth: 'advanced',
      equations: [{ label: 'Supplied equation', expression: 'MODEL_EXPRESSION_FROM_SOLVER' }],
      references: [{ id: 'ui-test-source', title: 'Fixture citation', url: 'https://example.org/source', version: 'fixture' }],
    }));
    expect(html).toContain('5.4321');
    expect(html).toContain('± 0.003 pH');
    expect(html).toContain('MODEL_EXPRESSION_FROM_SOLVER');
    expect(html).toContain('Fixture citation');
    expect(html).toContain('convergence');
    expect(html).toContain('fixture-hash');
    expect(safeReferenceUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeReferenceUrl('data:text/html,unsafe')).toBeUndefined();
    expect(safeReferenceUrl('https://example.org/source')).toBe('https://example.org/source');
  });
});
