import { describe, expect, it } from 'vitest';
import { CONICAL_FLASK_250ML } from '../definitions/conicalFlask';
import { ApparatusRegistry } from '../registry';
import { createApparatusInstance, parseApparatusInstance, serializeApparatusInstance, validateConfig } from '../serialization';

const registry = new ApparatusRegistry();
registry.register(CONICAL_FLASK_250ML);

describe('createApparatusInstance / serializeApparatusInstance / parseApparatusInstance round trip', () => {
  it('creates a valid instance with defaults filled in, then survives a JSON round trip unchanged', () => {
    const instance = createApparatusInstance(CONICAL_FLASK_250ML, { stationId: 'station-1' });
    expect(instance.definitionId).toBe('conical-flask-250ml');
    expect(instance.kind).toBe('FLASK');
    expect(instance.config).toEqual({ contentsLabel: '' });

    const json = serializeApparatusInstance(instance);
    const parsed = parseApparatusInstance(json, registry);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.instance).toEqual(instance);
  });

  it('preserves a non-default config value and an explicit transform through the round trip', () => {
    const transform = { positionM: [1, 0.9, -2] as const, quaternion: [0, 0.7071, 0, 0.7071] as const };
    const instance = createApparatusInstance(CONICAL_FLASK_250ML, { stationId: 'station-1', transform, config: { contentsLabel: '0.100 mol/L HCl' } });
    const parsed = parseApparatusInstance(serializeApparatusInstance(instance), registry);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.instance.transform).toEqual(transform);
      expect(parsed.instance.config).toEqual({ contentsLabel: '0.100 mol/L HCl' });
    }
  });
});

describe('createApparatusInstance', () => {
  it('throws with a clear message when the supplied config fails validation', () => {
    expect(() => createApparatusInstance(CONICAL_FLASK_250ML, { stationId: 's', config: { contentsLabel: 42 } })).toThrow(/must be a string/);
  });
});

describe('parseApparatusInstance', () => {
  it('reports a clear error for an unknown definitionId instead of throwing', () => {
    const result = parseApparatusInstance({ id: 'i', definitionId: 'no-such-definition', stationId: 's', revision: 0, transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] } }, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown apparatus definition id/i);
  });

  it('reports a clear error for a malformed transform', () => {
    const result = parseApparatusInstance({ id: 'i', definitionId: 'conical-flask-250ml', stationId: 's', revision: 0, transform: { positionM: [0, 0], quaternion: [0, 0, 0, 1] } }, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/transform/i);
  });

  it('rejects a non-object payload instead of throwing', () => {
    expect(parseApparatusInstance(null, registry).ok).toBe(false);
    expect(parseApparatusInstance('not an instance', registry).ok).toBe(false);
  });
});

describe('validateConfig', () => {
  it('drops unknown keys not present in the schema', () => {
    const result = validateConfig(CONICAL_FLASK_250ML, { contentsLabel: 'x', bogusKey: 'y' });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ contentsLabel: 'x' });
  });
});
