import { describe, expect, it } from 'vitest';
import { parseApparatusDefinition, serializeExperimentScene, deserializeExperimentScene } from '@matterlab/contracts';
import { getIndicatorDefinitions } from '@matterlab/lab-science';
import { createVesselCalibration, profileVolumeL } from './calibration';
import { APPARATUS_DEFINITIONS, ApparatusRegistry, apparatusRegistry } from './registry';
import { createTitrationSetup } from './seeds';

describe('procedural apparatus calibration', () => {
  it('makes the actual interior integrate to nominal capacity in liters, not cubic meters', () => {
    for (const definition of APPARATUS_DEFINITIONS) {
      if (!definition.vesselCalibration) continue;
      const calibration = definition.vesselCalibration;
      expect(profileVolumeL(calibration.interiorProfile), definition.id).toBeCloseTo(calibration.capacityL, 12);
      for (const point of calibration.volumeHeightCurve) {
        expect(profileVolumeL(calibration.interiorProfile, point.heightM), definition.id).toBeCloseTo(point.volumeL, 12);
      }
      const maxRadius = Math.max(...calibration.interiorProfile.map((point) => point.radiusM));
      expect(maxRadius * 2, definition.id).toBeLessThan(definition.dimensionsM[0]);
      expect(calibration.maxFillHeightM, definition.id).toBeLessThan(definition.dimensionsM[1]);
      expect(parseApparatusDefinition(JSON.parse(JSON.stringify(definition)))).toEqual(definition);
    }
  });

  it('places 40 mL remaining at the matching 10 mL delivered burette mark', () => {
    const calibration = apparatusRegistry.getDefinition('burette-50ml')!.vesselCalibration!;
    const bottom = calibration.volumeHeightCurve[0]!.heightM;
    const remainingHeight = bottom + 0.8 * (calibration.maxFillHeightM - bottom);
    expect(profileVolumeL(calibration.interiorProfile, remainingHeight)).toBeCloseTo(0.04, 12);
    const marks = calibration.graduations!;
    const tenDeliveredHeight = marks.startHeightM + 0.01 / calibration.capacityL * (marks.endHeightM - marks.startHeightM);
    expect(tenDeliveredHeight).toBeCloseTo(remainingHeight, 12);
  });

  it('refuses invalid calibration input instead of constructing NaN geometry', () => {
    expect(() => createVesselCalibration(0, [{ yM: 0, radiusM: 1 }, { yM: 1, radiusM: 1 }])).toThrow();
    expect(() => createVesselCalibration(1, [{ yM: 1, radiusM: 1 }, { yM: 0, radiusM: 1 }])).toThrow();
    expect(() => createVesselCalibration(1, [{ yM: 0, radiusM: NaN }, { yM: 1, radiusM: 1 }])).toThrow();
  });
});

describe('apparatus registration and assemblies', () => {
  it('allows validated extensions but does not silently replace definitions used by existing runs', () => {
    const existing = APPARATUS_DEFINITIONS[0]!;
    const registry = new ApparatusRegistry([existing]);
    registry.register({ ...existing, id: 'another-bench' });
    expect(registry.getDefinition('another-bench')?.kind).toBe('BENCH');
    expect(() => registry.register(existing)).toThrow(/already registered/);
    expect(() => registry.register({ ...existing, id: 'invalid-bench', dimensionsM: [NaN, 1, 1] })).toThrow();
    expect(registry.getDefinition('invalid-bench')).toBeUndefined();
  });

  it('supplies a serializable two-station assembly with compatible, physically aligned ports', () => {
    let sequence = 0;
    const setup = createTitrationSetup('test:solver', () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
    expect(deserializeExperimentScene(serializeExperimentScene(setup.scene))).toEqual(setup.scene);
    expect(setup.scene.stations).toHaveLength(2);
    expect(setup.scene.apparatus.filter((instance) => instance.stationId === setup.ids.blankStationId)).toHaveLength(1);
    expect(setup.scene.containerStates).toEqual({});
    const supportedIndicators = new Set(['none', ...getIndicatorDefinitions().map((indicator) => indicator.id)]);
    for (const instance of setup.scene.apparatus) {
      if (instance.capabilities.includes('CONTAINER')) expect(supportedIndicators.has(String(instance.config.indicatorId))).toBe(true);
    }
    expect(setup.scene.apparatus.find((instance) => instance.id === setup.ids.buretteId)?.config.indicatorId).toBe('none');
    expect(setup.scene.apparatus.find((instance) => instance.id === setup.ids.flaskId)?.config.indicatorId).toBe('phenolphthalein');
    for (const connection of setup.scene.connections) {
      const from = setup.scene.apparatus.find((instance) => instance.id === connection.from.instanceId)!;
      const to = setup.scene.apparatus.find((instance) => instance.id === connection.to.instanceId)!;
      const out = apparatusRegistry.getDefinition(from.definitionId)!.sockets.find((port) => port.id === connection.from.socketId)!;
      const into = apparatusRegistry.getDefinition(to.definitionId)!.sockets.find((port) => port.id === connection.to.socketId)!;
      expect(out.kind).toBe(connection.kind);
      expect(into.kind).toBe(connection.kind);
      expect(out.compatibility.accepts).toContain(into.compatibility.key);
      expect(into.compatibility.accepts).toContain(out.compatibility.key);
      for (const capability of out.compatibility.requiredCapabilities ?? []) expect(to.capabilities).toContain(capability);
      for (const capability of into.compatibility.requiredCapabilities ?? []) expect(from.capabilities).toContain(capability);
      const delta = out.localTransform.positionM.map((value, axis) =>
        value + from.transform.positionM[axis]! - into.localTransform.positionM[axis]! - to.transform.positionM[axis]!);
      expect(Math.hypot(...delta), `${from.definitionId} -> ${to.definitionId}`).toBeLessThanOrEqual(Math.min(out.alignmentToleranceM!, into.alignmentToleranceM!));
    }
  });
});
