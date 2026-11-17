import { describe, expect, it } from 'vitest';
import { buildVerticalSliceAssembly } from '../demo/sceneAssembly';
import { distanceBetween } from '../transforms';

describe('buildVerticalSliceAssembly (the shared vertical slice, contract \u00a76 steps 1-2)', () => {
  const assembly = buildVerticalSliceAssembly();

  it('places every P0 instance required for the vertical slice, the pH probe, and the second P1 station', () => {
    const ids = assembly.instances.map((i) => i.id);
    expect(ids).toEqual([
      'bench',
      'stand',
      'clamp',
      'burette',
      'stirrer',
      'flask',
      'bottle',
      'probe',
      'thermometer',
      'second-stand',
      'ring',
      'funnel',
      'cylinder',
      'jack-beaker',
      'jack',
      'balance',
      'dropper',
    ]);
  });

  it('stands the stand, clamp, burette, stirrer, flask and second-station instances upright (no pitch/roll tilt, yaw about vertical allowed)', () => {
    for (const id of ['stand', 'clamp', 'burette', 'stirrer', 'flask', 'second-stand', 'ring', 'cylinder', 'jack', 'balance']) {
      const instance = assembly.instances.find((i) => i.id === id)!;
      // A pure yaw (rotation about the vertical Y axis, e.g. the clamp's arm direction) has a
      // quaternion of the form (0, sin, 0, cos); qx and qz are exactly zero only when there is no
      // pitch or roll away from vertical.
      const [qx, , qz] = instance.transform.quaternion;
      expect(Math.abs(qx), id).toBeLessThan(1e-6);
      expect(Math.abs(qz), id).toBeLessThan(1e-6);
    }
  });

  it('positions the flask directly under the burette\u2019s delivery tip (within a few millimeters)', () => {
    const burette = assembly.instances.find((i) => i.id === 'burette')!;
    const flask = assembly.instances.find((i) => i.id === 'flask')!;
    const dx = burette.transform.positionM[0] - flask.transform.positionM[0];
    const dz = burette.transform.positionM[2] - flask.transform.positionM[2];
    expect(Math.hypot(dx, dz)).toBeLessThan(0.002);
    // And the tip is well above the flask's own mouth, not buried inside the glass.
    expect(burette.transform.positionM[1]).toBeGreaterThan(flask.transform.positionM[1] + flask.definition.dimensionsM.height);
  });

  it('rests the flask on the stirrer\u2019s plate, which itself rests on the bench, at plausible heights', () => {
    const bench = assembly.instances.find((i) => i.id === 'bench')!;
    const stirrer = assembly.instances.find((i) => i.id === 'stirrer')!;
    const flask = assembly.instances.find((i) => i.id === 'flask')!;
    expect(stirrer.transform.positionM[1]).toBeCloseTo(bench.definition.dimensionsM.height, 6);
    expect(flask.transform.positionM[1]).toBeGreaterThan(stirrer.transform.positionM[1]);
  });

  it('reports every real P0 socket pairing as compatible, and the two deliberately-mismatched pairings as incompatible', () => {
    for (const check of assembly.checks) {
      const expected = !check.label.startsWith('INVALID');
      expect(check.compatible, `${check.label}: ${check.reason}`).toBe(expected);
      expect(check.reason.length).toBeGreaterThan(0);
    }
  });

  it('rests a beaker directly on the lab jack\u2019s platform (its realistic use), the balance on the bench instead, and the funnel at the support ring\u2019s cradling socket', () => {
    const jack = assembly.instances.find((i) => i.id === 'jack')!;
    const jackBeaker = assembly.instances.find((i) => i.id === 'jack-beaker')!;
    expect(jackBeaker.transform.positionM[1]).toBeGreaterThan(jack.transform.positionM[1]);

    const bench = assembly.instances.find((i) => i.id === 'bench')!;
    const balance = assembly.instances.find((i) => i.id === 'balance')!;
    expect(balance.transform.positionM[1]).toBeCloseTo(bench.definition.dimensionsM.height, 6);

    const ring = assembly.instances.find((i) => i.id === 'ring')!;
    const funnel = assembly.instances.find((i) => i.id === 'funnel')!;
    // The funnel (visually placed, no rigid socket — see definitions/funnel.ts) sits at
    // approximately the ring's own height, well above the ring's own stand base.
    expect(Math.abs(funnel.transform.positionM[1] - ring.transform.positionM[1])).toBeLessThan(0.05);
  });

  it('shares the flask\u2019s sensor-access socket between the pH probe and the thermometer (maxConnections: 2)', () => {
    const flask = assembly.instances.find((i) => i.id === 'flask')!;
    const flaskMouthSocket = flask.definition.sockets.find((s) => s.id === 'sensor-access')!;
    expect(flaskMouthSocket.maxConnections).toBeGreaterThanOrEqual(2);
    const probe = assembly.instances.find((i) => i.id === 'probe')!;
    const thermometer = assembly.instances.find((i) => i.id === 'thermometer')!;
    expect(distanceBetween(probe.transform, thermometer.transform)).toBeGreaterThan(0.001);
    expect(distanceBetween(probe.transform, thermometer.transform)).toBeLessThan(0.1);
  });

  it('keeps every placed instance within a sensible distance of the bench (no runaway coordinates)', () => {
    const bench = assembly.instances.find((i) => i.id === 'bench')!;
    for (const instance of assembly.instances) {
      expect(distanceBetween(bench.transform, instance.transform)).toBeLessThan(2);
    }
  });
});
