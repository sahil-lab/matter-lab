import { describe, expect, it } from 'vitest';
import type { ApparatusDefinition } from '@matterlab/contracts';
import { clampValveOpening, flowRateLPerS, volumeOverTick } from './flow';

function definitionWithFlow(maxFlowRateLPerS: number): ApparatusDefinition {
  return {
    id: 'burette.test',
    kind: 'BURETTE',
    label: 'Test burette',
    category: 'glassware',
    capabilities: ['FLOW_SOURCE', 'CONTAINER'],
    dimensionsM: { width: 0.03, height: 0.5, depth: 0.03 },
    sockets: [],
    permittedTransforms: { translate: true, rotateAxes: ['y'] },
    controls: [],
    defaultConfig: {},
    flowModel: { id: 'linear-valve-v1', maxFlowRateLPerS },
  };
}

describe('clampValveOpening', () => {
  it('clamps to [0, 1]', () => {
    expect(clampValveOpening(-0.5)).toBe(0);
    expect(clampValveOpening(1.5)).toBe(1);
    expect(clampValveOpening(0.4)).toBe(0.4);
  });

  it('treats a non-finite opening as closed', () => {
    expect(clampValveOpening(Number.NaN)).toBe(0);
  });
});

describe('flowRateLPerS', () => {
  it('scales linearly with valve opening under the declared model', () => {
    const definition = definitionWithFlow(0.005);
    expect(flowRateLPerS(definition, 0)).toBe(0);
    expect(flowRateLPerS(definition, 1)).toBeCloseTo(0.005, 12);
    expect(flowRateLPerS(definition, 0.5)).toBeCloseTo(0.0025, 12);
  });

  it('returns 0 for a definition with no flow model, instead of throwing', () => {
    const definition: ApparatusDefinition = {
      id: 'flask.test',
      kind: 'FLASK',
      label: 'Test flask',
      category: 'glassware',
      capabilities: ['CONTAINER'],
      dimensionsM: { width: 0.1, height: 0.1, depth: 0.1 },
      sockets: [],
      permittedTransforms: { translate: true, rotateAxes: ['y'] },
      controls: [],
      defaultConfig: {},
    };
    expect(flowRateLPerS(definition, 1)).toBe(0);
  });
});

describe('volumeOverTick', () => {
  it('multiplies flow rate by the fixed tick length', () => {
    const definition = definitionWithFlow(0.005);
    expect(volumeOverTick(definition, 1, 1)).toBeCloseTo(0.005, 12);
    expect(volumeOverTick(definition, 1, 0.1)).toBeCloseTo(0.0005, 12);
  });

  it('is zero for a non-positive time step', () => {
    const definition = definitionWithFlow(0.005);
    expect(volumeOverTick(definition, 1, 0)).toBe(0);
    expect(volumeOverTick(definition, 1, -1)).toBe(0);
  });
});
