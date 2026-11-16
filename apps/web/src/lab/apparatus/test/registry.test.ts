import { describe, expect, it } from 'vitest';
import { ALL_DEFINITIONS, P0_DEFINITIONS, P1_DEFINITIONS } from '../definitions';
import { ApparatusDefinitionError, ApparatusRegistry, validateDefinition } from '../registry';
import type { ApparatusDefinition } from '../types';

/** A minimal, otherwise-valid definition for exercising one validation rule at a time. */
function minimalDefinition(overrides: Partial<ApparatusDefinition> = {}): ApparatusDefinition {
  return {
    id: 'test-definition',
    kind: 'OTHER',
    category: 'instrument',
    label: 'Test definition',
    description: 'A minimal definition used only by tests.',
    version: 1,
    dimensionsM: { width: 0.1, depth: 0.1, height: 0.1 },
    collision: { kind: 'box', halfExtentsM: [0.05, 0.05, 0.05] },
    capabilities: [],
    sockets: [],
    controls: [],
    defaultConfig: {},
    configSchema: [],
    placement: { allowedSurfaceRoles: [], allowRotationAboutUpAxis: true },
    asset: {
      source: 'procedural',
      polyCount: 10,
      materialSlots: ['default'],
      textureMemoryKB: 0,
      license: 'test-only',
      isPlaceholder: true,
    },
    thumbnail: { icon: 'Box', previewColor: '#ffffff' },
    provenance: { dimensions: 'ILLUSTRATIVE', notes: 'test fixture' },
    ...overrides,
  };
}

describe('every registered P0/P1 definition', () => {
  it('passes validateDefinition without throwing', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(() => validateDefinition(def), `${def.id} should be a valid definition`).not.toThrow();
    }
  });

  it('declares a unique, non-empty id', () => {
    const ids = ALL_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.trim().length).toBeGreaterThan(0);
  });

  it('covers the full P0 vertical-slice equipment list (shared contract §6) plus a P1 subset', () => {
    expect(P0_DEFINITIONS).toHaveLength(8);
    expect(P1_DEFINITIONS).toHaveLength(4);
    const kinds = new Set(P0_DEFINITIONS.map((d) => d.kind));
    for (const requiredKind of ['BENCH', 'STAND', 'CLAMP', 'BURETTE', 'FLASK', 'STIRRER', 'PH_PROBE']) {
      expect(kinds.has(requiredKind as ApparatusDefinition['kind']), `P0 set should include a ${requiredKind}`).toBe(true);
    }
  });

  it('documents poly count, texture memory and license/provenance for every asset (acceptance test)', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(def.asset.polyCount, def.id).toBeGreaterThan(0);
      expect(def.asset.textureMemoryKB, def.id).toBeGreaterThanOrEqual(0);
      expect(def.asset.license.length, def.id).toBeGreaterThan(0);
      expect(def.provenance.notes.length, def.id).toBeGreaterThan(0);
    }
  });

  it('every CONTAINER-capable definition declares a container spec, and vice versa', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(def.capabilities.includes('CONTAINER'), def.id).toBe(!!def.container);
    }
  });
});

describe('validateDefinition', () => {
  it('rejects a definition with a duplicate socket id', () => {
    const def = minimalDefinition({
      sockets: [
        { id: 'dup', label: 'A', kind: 'MECHANICAL', role: 'r', accepts: ['*'], gender: 'NEUTRAL', mate: 'coincident', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] }, geometryCheck: { kind: 'none' }, maxConnections: 1, highlightRadiusM: 0.01 },
        { id: 'dup', label: 'B', kind: 'MECHANICAL', role: 'r2', accepts: ['*'], gender: 'NEUTRAL', mate: 'coincident', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] }, geometryCheck: { kind: 'none' }, maxConnections: 1, highlightRadiusM: 0.01 },
      ],
    });
    expect(() => validateDefinition(def)).toThrow(ApparatusDefinitionError);
    expect(() => validateDefinition(def)).toThrow(/duplicate socket id/i);
  });

  it('rejects a numeric control whose default is outside its own range', () => {
    const def = minimalDefinition({
      controls: [
        { id: 'bad', label: 'Bad', kind: 'CUSTOM', actionType: 'CUSTOM', description: 'x', valueType: 'number', range: { min: 0, max: 1, unit: '', default: 5 } },
      ],
    });
    expect(() => validateDefinition(def)).toThrow(/default is outside its range/i);
  });

  it('rejects a CONTAINER capability declared without a container spec', () => {
    const def = minimalDefinition({ capabilities: ['CONTAINER'] });
    expect(() => validateDefinition(def)).toThrow(/CONTAINER capability and a container spec must be declared together/i);
  });

  it('rejects an un-normalized socket quaternion', () => {
    const def = minimalDefinition({
      sockets: [{ id: 's', label: 'S', kind: 'MECHANICAL', role: 'r', accepts: ['*'], gender: 'NEUTRAL', mate: 'coincident', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 2] }, geometryCheck: { kind: 'none' }, maxConnections: 1, highlightRadiusM: 0.01 }],
    });
    expect(() => validateDefinition(def)).toThrow(/not normalized/i);
  });
});

describe('ApparatusRegistry', () => {
  it('rejects registering the same id twice unless replace is requested', () => {
    const registry = new ApparatusRegistry();
    const def = minimalDefinition();
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/i);
    expect(() => registry.register(def, { replace: true })).not.toThrow();
  });

  it('require() throws a clear error for an unknown id, get() returns undefined', () => {
    const registry = new ApparatusRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(/no apparatus definition registered/i);
  });

  it('search() matches on label, short label and tags', () => {
    const registry = new ApparatusRegistry();
    registry.register(minimalDefinition({ id: 'a', label: 'Alpha Widget', tags: ['gizmo'] }));
    registry.register(minimalDefinition({ id: 'b', label: 'Beta Thing', shortLabel: 'Beta' }));
    expect(registry.search('widget').map((d) => d.id)).toEqual(['a']);
    expect(registry.search('gizmo').map((d) => d.id)).toEqual(['a']);
    expect(registry.search('beta').map((d) => d.id)).toEqual(['b']);
    expect(registry.search('').length).toBe(2);
  });

  it('byKind() and byCategory() filter correctly', () => {
    const registry = new ApparatusRegistry();
    registry.register(minimalDefinition({ id: 'a', kind: 'BEAKER', category: 'glassware' }));
    registry.register(minimalDefinition({ id: 'b', kind: 'STAND', category: 'support' }));
    expect(registry.byKind('BEAKER').map((d) => d.id)).toEqual(['a']);
    expect(registry.byCategory('support').map((d) => d.id)).toEqual(['b']);
  });
});
