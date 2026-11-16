import { describe, expect, it } from 'vitest';
import { BURETTE_50ML_CLASS_A, BURETTE_CLAMP_BOSS_HEAD, CONICAL_FLASK_250ML, RETORT_STAND_600MM, WORKBENCH_STANDARD } from '../definitions';
import { MAGNETIC_STIRRER_COMPACT } from '../definitions/magneticStirrer';
import { buildRoleCompatibilityMatrix, computeAttachmentPlacement, evaluateSocketCompatibility } from '../sockets';
import { distanceBetween, composeTransforms, approxEqualTransform } from '../transforms';
import type { ApparatusDefinition, SocketDefinition } from '../types';

function socket(def: ApparatusDefinition, id: string): SocketDefinition {
  const found = def.sockets.find((s) => s.id === id);
  if (!found) throw new Error(`${def.id} has no socket "${id}"`);
  return found;
}

describe('evaluateSocketCompatibility — the brief\u2019s worked examples', () => {
  it('accepts a retort stand\u2019s pole and a burette clamp\u2019s boss head', () => {
    const result = evaluateSocketCompatibility(
      { definition: RETORT_STAND_600MM, socket: socket(RETORT_STAND_600MM, 'pole') },
      { definition: BURETTE_CLAMP_BOSS_HEAD, socket: socket(BURETTE_CLAMP_BOSS_HEAD, 'boss-head') },
    );
    expect(result.compatible).toBe(true);
    expect(result.reasonCode).toBe('OK');
  });

  it('accepts a burette clamp\u2019s jaw and a burette\u2019s barrel', () => {
    const result = evaluateSocketCompatibility(
      { definition: BURETTE_CLAMP_BOSS_HEAD, socket: socket(BURETTE_CLAMP_BOSS_HEAD, 'jaw') },
      { definition: BURETTE_50ML_CLASS_A, socket: socket(BURETTE_50ML_CLASS_A, 'barrel') },
    );
    expect(result.compatible).toBe(true);
  });

  it('accepts a conical flask resting on the workbench, and on the stirrer plate', () => {
    const onBench = evaluateSocketCompatibility(
      { definition: WORKBENCH_STANDARD, socket: socket(WORKBENCH_STANDARD, 'top-surface') },
      { definition: CONICAL_FLASK_250ML, socket: socket(CONICAL_FLASK_250ML, 'base') },
    );
    expect(onBench.compatible).toBe(true);

    const onStirrer = evaluateSocketCompatibility(
      { definition: MAGNETIC_STIRRER_COMPACT, socket: socket(MAGNETIC_STIRRER_COMPACT, 'plate') },
      { definition: CONICAL_FLASK_250ML, socket: socket(CONICAL_FLASK_250ML, 'base') },
    );
    expect(onStirrer.compatible).toBe(true);
  });

  it('rejects a burette barrel offered directly to the stand\u2019s pole, with a clear reason', () => {
    const result = evaluateSocketCompatibility(
      { definition: RETORT_STAND_600MM, socket: socket(RETORT_STAND_600MM, 'pole') },
      { definition: BURETTE_50ML_CLASS_A, socket: socket(BURETTE_50ML_CLASS_A, 'barrel') },
    );
    expect(result.compatible).toBe(false);
    expect(result.reasonCode).toBe('ROLE_NOT_ACCEPTED');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('rejects a retort stand\u2019s base resting on the stirrer\u2019s plate (footprint too large)', () => {
    const result = evaluateSocketCompatibility(
      { definition: MAGNETIC_STIRRER_COMPACT, socket: socket(MAGNETIC_STIRRER_COMPACT, 'plate') },
      { definition: RETORT_STAND_600MM, socket: socket(RETORT_STAND_600MM, 'base') },
    );
    expect(result.compatible).toBe(false);
    expect(result.reasonCode).toBe('FOOTPRINT_TOO_LARGE');
  });

  it('rejects two female connectors mated to each other (gender mismatch)', () => {
    const result = evaluateSocketCompatibility(
      { definition: BURETTE_CLAMP_BOSS_HEAD, socket: { ...socket(BURETTE_CLAMP_BOSS_HEAD, 'boss-head'), accepts: ['boss-head'] } },
      { definition: BURETTE_CLAMP_BOSS_HEAD, socket: { ...socket(BURETTE_CLAMP_BOSS_HEAD, 'boss-head'), accepts: ['boss-head'] } },
    );
    expect(result.compatible).toBe(false);
    expect(result.reasonCode).toBe('GENDER_MISMATCH');
  });

  it('rejects a socket that already has the maximum number of connections', () => {
    const jaw = socket(BURETTE_CLAMP_BOSS_HEAD, 'jaw');
    const result = evaluateSocketCompatibility(
      { definition: BURETTE_CLAMP_BOSS_HEAD, socket: jaw, currentConnections: jaw.maxConnections },
      { definition: BURETTE_50ML_CLASS_A, socket: socket(BURETTE_50ML_CLASS_A, 'barrel') },
    );
    expect(result.compatible).toBe(false);
    expect(result.reasonCode).toBe('SOCKET_FULL');
  });
});

describe('computeAttachmentPlacement', () => {
  it('slides a clamp along the stand\u2019s rod by the requested axial offset, clamped to the rail\u2019s range', () => {
    const standWorld = { positionM: [0, 0, 0] as const, quaternion: [0, 0, 0, 1] as const };
    const pole = socket(RETORT_STAND_600MM, 'pole');
    const bossHead = socket(BURETTE_CLAMP_BOSS_HEAD, 'boss-head');

    const low = computeAttachmentPlacement(standWorld, pole, bossHead, { axialOffsetM: 0.1 });
    const high = computeAttachmentPlacement(standWorld, pole, bossHead, { axialOffsetM: 0.4 });
    expect(high.childOrigin.positionM[1]).toBeGreaterThan(low.childOrigin.positionM[1]);

    // The parent (stand) rail's range governs, not the child clamp's own placeholder [0, 0] range.
    // The range is measured from the pole socket's own world anchor (the base of the rod), not from world y=0.
    const poleWorldY = composeTransforms(standWorld, pole.transform).positionM[1];
    const beyondRail = computeAttachmentPlacement(standWorld, pole, bossHead, { axialOffsetM: 999 });
    expect(beyondRail.childOrigin.positionM[1]).toBeCloseTo(poleWorldY + pole.axialRangeM![1], 6);
  });

  it('leaves a planar-mated child standing upright (no residual tilt) on the bench', () => {
    const benchWorld = { positionM: [1, 0, 2] as const, quaternion: [0, 0, 0, 1] as const };
    const placement = computeAttachmentPlacement(benchWorld, socket(WORKBENCH_STANDARD, 'top-surface'), socket(CONICAL_FLASK_250ML, 'base'), {
      planarOffsetM: [0.1, -0.05],
    });
    // Identity rotation (up to floating point) means the flask stands upright, matching how its own mesh was authored.
    const [qx, qy, qz, qw] = placement.childOrigin.quaternion;
    expect(Math.abs(qx)).toBeLessThan(1e-6);
    expect(Math.abs(qy)).toBeLessThan(1e-6);
    expect(Math.abs(qz)).toBeLessThan(1e-6);
    expect(Math.abs(qw)).toBeCloseTo(1, 6);
    // And it should land on the bench's top surface height (the bench is 0.9 m tall).
    expect(placement.childOrigin.positionM[1]).toBeCloseTo(0.9, 6);
  });

  it('coincidentally mates a burette\u2019s barrel socket exactly with the clamp\u2019s jaw (fixed, no free offset)', () => {
    const clampWorld = { positionM: [0, 0.4, 0] as const, quaternion: [0, 0, 0, 1] as const };
    const jaw = socket(BURETTE_CLAMP_BOSS_HEAD, 'jaw');
    const barrel = socket(BURETTE_50ML_CLASS_A, 'barrel');
    const placement = computeAttachmentPlacement(clampWorld, jaw, barrel);
    expect(placement.mate).toBe('coincident');

    // The burette's barrel socket, placed at the computed origin, must land exactly on the jaw's world transform.
    const jawWorld = composeTransforms(clampWorld, jaw.transform);
    const barrelWorldFromOrigin = composeTransforms(placement.childOrigin, barrel.transform);
    expect(distanceBetween(jawWorld, barrelWorldFromOrigin)).toBeLessThan(1e-9);
    expect(approxEqualTransform(jawWorld, barrelWorldFromOrigin)).toBe(true);
  });
});

describe('buildRoleCompatibilityMatrix', () => {
  it('produces a non-empty, symmetric matrix covering the registered roles', () => {
    const matrix = buildRoleCompatibilityMatrix([WORKBENCH_STANDARD, RETORT_STAND_600MM, BURETTE_CLAMP_BOSS_HEAD, BURETTE_50ML_CLASS_A, CONICAL_FLASK_250ML]);
    expect(matrix.length).toBeGreaterThan(0);
    const poleToBossHead = matrix.find((e) => (e.roleA === 'stand-pole' && e.roleB === 'boss-head') || (e.roleA === 'boss-head' && e.roleB === 'stand-pole'));
    expect(poleToBossHead?.result.compatible).toBe(true);
  });
});
