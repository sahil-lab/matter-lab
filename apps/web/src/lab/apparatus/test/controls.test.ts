import { describe, expect, it } from 'vitest';
import { BURETTE_50ML_CLASS_A } from '../definitions/burette';
import { MAGNETIC_STIRRER_COMPACT } from '../definitions/magneticStirrer';
import { buildControlAction, clampControlValue, findControl } from '../controls';

describe('buildControlAction', () => {
  it('builds a valid SET_VALVE action for the stopcock within range', () => {
    const result = buildControlAction(BURETTE_50ML_CLASS_A, 'instance-1', 'stopcock', 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.type).toBe('SET_VALVE');
    expect(result.action.targetInstanceId).toBe('instance-1');
    expect(result.action.payload).toMatchObject({ controlId: 'stopcock', value: 0.5 });
    expect(result.action.actionId.length).toBeGreaterThan(0);
  });

  it('rejects a stopcock value outside its declared 0..1 range, with a clear message', () => {
    const result = buildControlAction(BURETTE_50ML_CLASS_A, 'instance-1', 'stopcock', 1.5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/between 0 and 1/);
  });

  it('rejects a non-numeric value for a numeric control', () => {
    const result = buildControlAction(BURETTE_50ML_CLASS_A, 'instance-1', 'stopcock', 'open' as unknown as number);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown control id, listing the available ones', () => {
    const result = buildControlAction(BURETTE_50ML_CLASS_A, 'instance-1', 'nonexistent', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('stopcock');
    expect(result.error).toContain('fill');
  });

  it('accepts a FILL action at the declared capacity boundary and merges extraPayload', () => {
    const result = buildControlAction(BURETTE_50ML_CLASS_A, 'instance-1', 'fill', 0.05, { extraPayload: { speciesId: 'naoh-aq', concentrationMolPerL: 0.1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.type).toBe('FILL');
    expect(result.action.payload).toMatchObject({ speciesId: 'naoh-aq', concentrationMolPerL: 0.1, value: 0.05 });
  });

  it('rejects a boolean control given a non-boolean value, and accepts a real boolean', () => {
    const rejected = buildControlAction(MAGNETIC_STIRRER_COMPACT, 'stirrer-1', 'power', 'on' as unknown as boolean);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/true or false/);

    const accepted = buildControlAction(MAGNETIC_STIRRER_COMPACT, 'stirrer-1', 'power', true);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.action.payload.value).toBe(true);
  });
});

describe('clampControlValue', () => {
  const control = findControl(BURETTE_50ML_CLASS_A, 'stopcock')!;

  it('clamps into range and snaps to the declared step', () => {
    expect(clampControlValue(control, -1)).toBe(0);
    expect(clampControlValue(control, 2)).toBe(1);
    expect(clampControlValue(control, 0.503)).toBeCloseTo(0.5, 6);
  });
});
