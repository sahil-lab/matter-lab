import { describe, expect, it } from 'vitest';
import type { Observation } from '@matterlab/contracts';
import { beginRecompute, EMPTY_OBSERVATION_LEDGER, latestObservation, observationsFor, recordObservations } from './observationLedger';

function phObservation(value: number, timeS: number): Observation {
  return { type: 'PH', apparatusId: 'flask-1', timeS, quantity: { value, unit: 'pH' }, evidence: 'UNVERIFIED', methodId: 'test', sourceIds: [] };
}

describe('observation ledger', () => {
  it('records an observation for the generation it was requested at', () => {
    const { state: s1, generation } = beginRecompute(EMPTY_OBSERVATION_LEDGER, 'flask-1');
    const outcome = recordObservations(s1, 'flask-1', generation, [phObservation(7, 1)]);
    expect(outcome.accepted).toBe(true);
    expect(observationsFor(outcome.state, 'flask-1')).toHaveLength(1);
  });

  it('rejects a stale (superseded) response and keeps only the newer one', () => {
    const { state: s1, generation: genA } = beginRecompute(EMPTY_OBSERVATION_LEDGER, 'flask-1');
    const { state: s2, generation: genB } = beginRecompute(s1, 'flask-1');
    expect(genB).toBeGreaterThan(genA);

    // The newer request's response arrives first.
    const afterB = recordObservations(s2, 'flask-1', genB, [phObservation(5, 2)]);
    expect(afterB.accepted).toBe(true);

    // The older request's response arrives after; it must be discarded, not overwrite the newer value.
    const afterA = recordObservations(afterB.state, 'flask-1', genA, [phObservation(9, 1)]);
    expect(afterA.accepted).toBe(false);
    expect(latestObservation(afterA.state, 'flask-1', 'PH')?.quantity.value).toBe(5);
  });

  it('keeps generations independent per apparatus', () => {
    const { state: s1, generation: genFlask } = beginRecompute(EMPTY_OBSERVATION_LEDGER, 'flask-1');
    const { state: s2, generation: genOther } = beginRecompute(s1, 'flask-2');
    const outcome = recordObservations(s2, 'flask-1', genFlask, [phObservation(6, 1)]);
    expect(outcome.accepted).toBe(true);
    const otherOutcome = recordObservations(outcome.state, 'flask-2', genOther, [phObservation(8, 1)]);
    expect(otherOutcome.accepted).toBe(true);
  });
});
