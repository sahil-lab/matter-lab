import { describe, expect, it } from 'vitest';
import type { ObservationRecord } from '@matterlab/contracts';
import { apparatusRegistry } from '../apparatus/registry';
import { LiquidAppearanceTransition } from './appearance';
import { CLEAR_LIQUID_APPEARANCE } from './materials';
import {
  formatInstrumentReading, selectIndicatorAppearance, selectInstrumentReading, selectProbeReading, vesselReadings,
} from './observations';
import { fluidScope } from './types';
import { fixture, observationsFor } from './fixtures.test-support';

function queryFixture() {
  const { snapshot: initial, ids } = fixture();
  const observations = observationsFor(initial, ids.flaskId);
  const snapshot = { ...initial, observations, lastSequence: 20 };
  return { snapshot, ids, query: { observations, apparatusId: ids.flaskId, scope: fluidScope(snapshot, ids.stationId)! } };
}

describe('exact observation-driven color and instrument adapters', () => {
  it('copies the current scientific indicator without deriving color from pH', () => {
    const { query } = queryFixture();
    const selection = selectIndicatorAppearance(query);
    expect(selection.record?.id).toBe(query.observations[1]!.id);
    expect(selection.appearance.colorSrgb).toEqual([0.91, 0.42, 0.63]);
    const changedPH: ObservationRecord = {
      ...query.observations[0]!, observation: { ...query.observations[0]!.observation, type: 'PH', quantity: { unit: 'pH', value: 2 } },
    };
    expect(selectIndicatorAppearance({ ...query, observations: [changedPH, query.observations[1]!] }).appearance.colorSrgb).toEqual(selection.appearance.colorSrgb);
    expect(formatInstrumentReading(selectInstrumentReading(query, 'PH'))).toBe('8.20 pH');
  });

  it('does not color legacy records, unsupported results, or records from another run/station/epoch', () => {
    const { query } = queryFixture();
    const indicator = query.observations[1]!;
    if (indicator.observation.type !== 'INDICATOR') throw new Error('Invalid fixture');
    const legacy: ObservationRecord = { ...indicator, observation: { ...indicator.observation, indicatorState: undefined } };
    for (const invalid of [
      legacy, { ...indicator, runId: 'other-run' }, { ...indicator, stationId: 'other-station' },
      { ...indicator, epoch: 1 }, { ...indicator, sequence: 21 },
      { ...indicator, observation: { ...indicator.observation, timeS: 1 } },
      { ...indicator, observation: { ...indicator.observation, evidence: 'UNSUPPORTED' as const } },
    ]) expect(selectIndicatorAppearance({ ...query, observations: [query.observations[0]!, invalid] }).appearance).toBe(CLEAR_LIQUID_APPEARANCE);
    for (const status of ['FAILED', 'UNSUPPORTED'] as const) {
      expect(selectIndicatorAppearance({ ...query, scope: { ...query.scope, status } }).record).toBeUndefined();
    }
  });

  it('invalidates tint when a same-time refill has a newer PH or pending inventory batch', () => {
    const { query } = queryFixture();
    const newerPH: ObservationRecord = { ...query.observations[0]!, id: 'new-ph', sequence: 18 };
    const inventory: ObservationRecord = {
      ...query.observations[0]!, id: 'new-volume', sequence: 17,
      observation: { ...query.observations[0]!.observation, type: 'VOLUME', quantity: { unit: 'L', value: 0.03 } },
    };
    expect(selectIndicatorAppearance({ ...query, observations: [...query.observations, newerPH] }).record).toBeUndefined();
    expect(selectIndicatorAppearance({ ...query, observations: [...query.observations, inventory] }).record).toBeUndefined();
    const currentIndicator = { ...query.observations[1]!, id: 'new-indicator', sequence: 18 };
    expect(selectIndicatorAppearance({ ...query, observations: [...query.observations, inventory, newerPH, currentIndicator] }).record?.id).toBe('new-indicator');
  });

  it('does not fall back to an older successful pH after a newer unsupported observation', () => {
    const { query } = queryFixture();
    const unsupported: ObservationRecord = {
      ...query.observations[0]!, id: 'unsupported', sequence: 19,
      observation: { ...query.observations[0]!.observation, evidence: 'UNSUPPORTED' },
    };
    const changed = { ...query, observations: [...query.observations, unsupported] };
    expect(selectIndicatorAppearance(changed).record).toBeUndefined();
    expect(formatInstrumentReading(selectInstrumentReading(changed, 'PH'))).toBe('—');
  });

  it('requires an explicit selection for simultaneous indicators and exact copied provenance', () => {
    const { query } = queryFixture();
    const indicator = query.observations[1]!;
    if (indicator.observation.type !== 'INDICATOR') throw new Error('Invalid fixture');
    const other: ObservationRecord = {
      ...indicator, id: 'other-indicator',
      observation: {
        ...indicator.observation, indicatorId: 'test:other',
        indicatorState: { ...indicator.observation.indicatorState!, indicatorId: 'test:other' },
      },
    };
    const ambiguous = { ...query, observations: [...query.observations, other] };
    expect(selectIndicatorAppearance(ambiguous).record).toBeUndefined();
    expect(selectIndicatorAppearance({ ...ambiguous, indicatorId: 'test:other' }).record?.id).toBe('other-indicator');
    for (const indicatorState of [
      { ...indicator.observation.indicatorState!, sourceIds: ['different-source'] },
      { ...indicator.observation.indicatorState!, baseFraction: 0.7 },
      { ...indicator.observation.indicatorState!, colorSrgb: [NaN, 0.5, 1] as const },
    ]) {
      expect(selectIndicatorAppearance({ ...query, observations: [
        query.observations[0]!, { ...indicator, observation: { ...indicator.observation, indicatorState } },
      ] }).record).toBeUndefined();
    }
  });

  it('resolves a pH probe through its authoritative same-station binding only', () => {
    const { snapshot, ids } = queryFixture();
    expect(selectProbeReading(snapshot, ids.probeId).status).toBe('UNAVAILABLE');
    const bound = { ...snapshot, apparatusStates: {
      ...snapshot.apparatusStates, [ids.probeId]: { probe: { containerInstanceId: ids.flaskId } },
    } };
    expect(formatInstrumentReading(selectProbeReading(bound, ids.probeId))).toBe('8.20 pH');
    const crossed = { ...bound, scene: { ...bound.scene, apparatus: bound.scene.apparatus.map((instance) =>
      instance.id === ids.flaskId ? { ...instance, stationId: ids.blankStationId } : instance) } };
    expect(selectProbeReading(crossed, ids.probeId).status).toBe('UNAVAILABLE');
  });

  it('separates partial-fill scale readings from authoritative cumulative delivered volume', () => {
    const { snapshot, ids } = fixture();
    const readings = vesselReadings(apparatusRegistry.getDefinition('burette-50ml')!,
      { ...snapshot.scene.containerStates[ids.buretteId]!, volumeL: 0.03 }, { deliveredVolumeL: 0.002 });
    expect(readings.remainingL).toBe(0.03);
    expect(readings.deliveredL).toBe(0.002);
    expect(readings.nominalScaleL).toBeCloseTo(0.02, 12);
    expect(vesselReadings(apparatusRegistry.getDefinition('burette-50ml')!).remainingL).toBeUndefined();
  });

  it('snaps away old epoch/missing/reduced-motion colors while allowing bounded real-color transitions', () => {
    const { query } = queryFixture();
    const appearance = selectIndicatorAppearance(query).appearance;
    const transition = new LiquidAppearanceTransition();
    transition.set(query.scope, appearance, 0, false);
    const next = { ...appearance, indicatorRecordId: 'next', colorSrgb: [1, 0.1, 0.4] as const };
    transition.set(query.scope, next, 1, false);
    expect(transition.sample(1.09).colorSrgb[1]).toBeGreaterThan(0.1);
    expect(transition.sample(1.3)).toBe(next);
    transition.set({ ...query.scope, epoch: 1 }, CLEAR_LIQUID_APPEARANCE, 1.4, false);
    expect(transition.sample(1.4)).toBe(CLEAR_LIQUID_APPEARANCE);
    transition.set(query.scope, appearance, 2, false);
    transition.set(query.scope, next, 2.1, true);
    expect(transition.sample(2.1)).toBe(next);
    transition.set(query.scope, CLEAR_LIQUID_APPEARANCE, 2.2, false);
    expect(transition.sample(2.2)).toBe(CLEAR_LIQUID_APPEARANCE);
  });
});
