import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { APPARATUS_DEFINITIONS, apparatusRegistry } from '../apparatus/registry';
import {
  calibratedGraduations, calibratedHeightM, checkVesselCalibration, evaluateVesselFill, integratedProfileVolumeL,
} from './calibration';
import { boundedSurfaceMotion, createLiquidGeometry, surfaceWaveM } from './liquidGeometry';
import { createGlassMaterial, createLiquidMaterial } from './materials';
import { resolveFluidSettings } from './quality';
import { fluidScope } from './types';
import { fixture } from './fixtures.test-support';

const upright = [0, 0, 0, 1] as const;
const burette = apparatusRegistry.getDefinition('burette-50ml')!;
const flask = apparatusRegistry.getDefinition('conical-flask-250ml')!;

function meshVolumeL(geometry: BufferGeometry): number {
  const positions = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  let sum = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    sum += positions.getX(a) * (positions.getY(b) * positions.getZ(c) - positions.getZ(b) * positions.getY(c)) +
      positions.getY(a) * (positions.getZ(b) * positions.getX(c) - positions.getX(b) * positions.getZ(c)) +
      positions.getZ(a) * (positions.getX(b) * positions.getY(c) - positions.getY(b) * positions.getX(c));
  }
  return sum / 6 * 1000;
}

describe('definition-calibrated liquid geometry', () => {
  it('accepts every actual parent vessel and checks cubic-meter-to-liter capacity', () => {
    for (const definition of APPARATUS_DEFINITIONS) {
      if (!definition.vesselCalibration) continue;
      const calibration = definition.vesselCalibration;
      expect(checkVesselCalibration(calibration), definition.id).toMatchObject({ supported: true });
      expect(integratedProfileVolumeL(calibration.interiorProfile, calibration.volumeHeightCurve[0]!.heightM,
        calibration.maxFillHeightM)).toBeCloseTo(calibration.capacityL, 10);
    }
  });

  it('aligns the actual 10 mL descending burette mark with 40 mL remaining', () => {
    const fill = evaluateVesselFill(burette, 0.04, upright);
    expect(fill.status).toBe('READY');
    expect(fill.referenceHeightM).toBeCloseTo(0.452, 10);
    const mark = calibratedGraduations(burette.vesselCalibration!).find((item) => Math.abs(item.readingL - 0.01) < 1e-10)!;
    expect(mark.major).toBe(true);
    expect(mark.heightM).toBeCloseTo(fill.referenceHeightM, 10);
    expect(fill.geometricVolumeL).toBeCloseTo(0.04, 10);
  });

  it('uses the nonlinear conical curve rather than a volume fraction times height', () => {
    const calibration = flask.vesselCalibration!;
    const fill = evaluateVesselFill(flask, 0.125, upright);
    const linearGuess = calibration.volumeHeightCurve[0]!.heightM +
      (calibration.maxFillHeightM - calibration.volumeHeightCurve[0]!.heightM) / 2;
    expect(fill.referenceHeightM).toBe(calibratedHeightM(calibration, 0.125));
    expect(Math.abs(fill.referenceHeightM - linearGuess)).toBeGreaterThan(0.02);
    expect(Math.abs(fill.geometricVolumeL - 0.125)).toBeLessThan(0.00005);
  });

  it('rejects nonmonotonic or unit-mismatched profiles instead of drawing a plausible fill', () => {
    const calibration = burette.vesselCalibration!;
    expect(checkVesselCalibration({ ...calibration, volumeHeightCurve: [...calibration.volumeHeightCurve].reverse() }).supported).toBe(false);
    expect(checkVesselCalibration({
      ...calibration, interiorProfile: calibration.interiorProfile.map((point) => ({ ...point, radiusM: point.radiusM * 10 })),
    }).supported).toBe(false);
    expect(evaluateVesselFill({ ...burette, capacityL: 50 }, 0.04, upright).status).toBe('UNSUPPORTED');
    for (const volume of [-0.001, 0.050001, NaN, Infinity]) {
      expect(evaluateVesselFill(burette, volume, upright).status).toBe('UNSUPPORTED');
    }
  });

  it('handles empty/full, arbitrary yaw and unsupported tilt honestly', () => {
    expect(evaluateVesselFill(burette, 0, upright).status).toBe('EMPTY');
    expect(evaluateVesselFill(burette, 0.05, upright)).toMatchObject({ status: 'READY', full: true, referenceHeightM: 0.54, meniscusOffsetM: 0 });
    expect(evaluateVesselFill(burette, 0.01, [0, Math.sin(0.7), 0, Math.cos(0.7)]).status).toBe('READY');
    expect(evaluateVesselFill(burette, 0.01, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]).status).toBe('UNSUPPORTED');
    expect(evaluateVesselFill(burette, 0.01, [0, 0, 0, 2]).status).toBe('UNSUPPORTED');
  });

  it('keeps the declared meniscus reference fixed and clips its extent at both range limits', () => {
    for (const reference of ['BOTTOM', 'TOP'] as const) {
      const definition = { ...burette, vesselCalibration: { ...burette.vesselCalibration!, meniscus: { reference, offsetM: 0.0008 } } };
      const fill = evaluateVesselFill(definition, 0.025, upright);
      expect(fill.referenceHeightM).toBeCloseTo(0.32, 10);
      expect(fill.edgeHeightM - fill.referenceHeightM).toBeCloseTo(reference === 'BOTTOM' ? 0.0008 : -0.0008, 10);
      expect(evaluateVesselFill(definition, 0.05, upright).meniscusOffsetM).toBe(0);
      const nearEmpty = evaluateVesselFill(definition, 0.00000001, upright);
      expect(nearEmpty.edgeHeightM).toBeGreaterThanOrEqual(nearEmpty.bottomHeightM);
      expect(nearEmpty.meniscusOffsetM).toBeLessThan(0.000001);
    }
  });

  it('measures actual generated mesh volume, not only interpolation helpers', () => {
    for (const definition of [burette, flask]) {
      const resource = createLiquidGeometry(definition.vesselCalibration!, resolveFluidSettings());
      for (const fraction of [0, 0.001, 0.1, 0.5, 1]) {
        const volumeL = definition.capacityL! * fraction;
        const fill = evaluateVesselFill(definition, volumeL, upright);
        resource.update(fill);
        const measuredL = meshVolumeL(resource.geometry);
        if (volumeL === 0) expect(Math.abs(measuredL)).toBeLessThan(1e-9);
        else {
          expect(measuredL).toBeGreaterThan(0);
          expect(Math.abs(measuredL - volumeL)).toBeLessThan(volumeL * 0.015 + definition.capacityL! * 0.0001);
        }
        const positions = resource.geometry.getAttribute('position');
        let maxY = -Infinity;
        for (let i = 0; i < positions.count; i++) maxY = Math.max(maxY, positions.getY(i));
        expect(maxY).toBeCloseTo(fill.referenceHeightM, 6);
      }
      resource.dispose();
    }
  });

  it('bounds motion by fill/headroom, preserves the read point and stops at zero/pause/reduced motion', () => {
    const { snapshot, ids } = fixture();
    const scope = fluidScope(snapshot, ids.stationId)!;
    const fill = evaluateVesselFill(flask, 0.025, upright);
    const quality = resolveFluidSettings();
    const motion = boundedSurfaceMotion(fill, flask.vesselCalibration!.maxFillHeightM, scope, { enabled: true, frequencyHz: 25 }, quality, 5.2);
    expect(motion.amplitudeM).toBeGreaterThan(0);
    let sum = 0;
    for (let i = 0; i < 40; i++) sum += surfaceWaveM(0.5, i / 40 * Math.PI * 2, motion);
    expect(Math.abs(sum)).toBeLessThan(1e-12);
    expect(surfaceWaveM(0, 1, motion)).toBeCloseTo(0, 12);
    expect(surfaceWaveM(1, 1, motion)).toBeCloseTo(0, 12);
    for (const stopped of [
      boundedSurfaceMotion(fill, 0.175, { ...scope, status: 'PAUSED' }, { enabled: true, frequencyHz: 25 }, quality),
      boundedSurfaceMotion(fill, 0.175, scope, { enabled: false, frequencyHz: 25 }, quality),
      boundedSurfaceMotion(fill, 0.175, scope, { enabled: true, frequencyHz: 25 }, resolveFluidSettings({ reducedMotion: true })),
      boundedSurfaceMotion(fill, 0.175, scope, { enabled: true, frequencyHz: 25 }, resolveFluidSettings({ lowPower: true })),
      boundedSurfaceMotion(evaluateVesselFill(flask, 0, upright), 0.175, scope, { enabled: true, frequencyHz: 25 }, quality),
      boundedSurfaceMotion(evaluateVesselFill(flask, 0.25, upright), 0.175, scope, { enabled: true, frequencyHz: 25 }, quality),
    ]) expect(stopped.amplitudeM).toBe(0);
  });

  it('releases owned geometry once and offers a stock opacity material fallback', () => {
    const resource = createLiquidGeometry(burette.vesselCalibration!, resolveFluidSettings());
    let disposed = 0;
    resource.geometry.addEventListener('dispose', () => { disposed++; });
    resource.dispose();
    resource.dispose();
    expect(disposed).toBe(1);
    const glass = createGlassMaterial();
    const fallback = createGlassMaterial({ lowPower: true });
    const liquid = createLiquidMaterial({ materialMode: 'opacity' });
    expect(glass.transmission).toBeGreaterThan(0);
    expect(fallback.transmission).toBe(0);
    expect(liquid.transmission).toBe(0);
    expect(glass.depthWrite).toBe(false);
    for (const material of [glass, fallback, liquid]) material.dispose();
  });
});
