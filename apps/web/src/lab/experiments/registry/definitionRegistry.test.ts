import { describe, expect, it } from 'vitest';
import type { ApparatusDefinition } from '@matterlab/contracts';
import { createDefinitionRegistry, DefinitionRegistry, VERTICAL_SLICE_DEFINITIONS } from './index';

function minimalDefinition(id: string): ApparatusDefinition {
  return {
    id,
    kind: 'OTHER',
    label: id,
    category: 'test',
    capabilities: [],
    dimensionsM: { width: 0.1, height: 0.1, depth: 0.1 },
    sockets: [],
    permittedTransforms: { translate: true, rotateAxes: [] },
    controls: [],
    defaultConfig: {},
  };
}

describe('DefinitionRegistry', () => {
  it('registers and looks up a definition', () => {
    const registry = new DefinitionRegistry();
    registry.register(minimalDefinition('a'));
    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')?.id).toBe('a');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('require() throws for an unknown id', () => {
    const registry = new DefinitionRegistry();
    expect(() => registry.require('missing')).toThrow();
  });

  it('re-registering the identical object is a no-op; a different definition with the same id throws', () => {
    const registry = new DefinitionRegistry();
    const def = minimalDefinition('a');
    registry.register(def);
    expect(() => registry.register(def)).not.toThrow();
    expect(() => registry.register(minimalDefinition('a'))).toThrow();
  });

  it('createDefinitionRegistry seeds every vertical-slice definition', () => {
    const registry = createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS);
    for (const definition of VERTICAL_SLICE_DEFINITIONS) {
      expect(registry.get(definition.id)).toBe(definition);
    }
    expect(registry.list()).toHaveLength(VERTICAL_SLICE_DEFINITIONS.length);
  });
});
