import { expect, test } from '@playwright/test';
import { LabEnvironmentPage } from './lab-environment';

function isFiniteVec3(v: readonly number[]): boolean {
  return v.length === 3 && v.every((n) => Number.isFinite(n));
}

test.describe('lab environment harness', () => {
  let lab: LabEnvironmentPage;

  test.beforeEach(async ({ page }) => {
    lab = new LabEnvironmentPage(page);
    await lab.open();
  });

  test.afterEach(() => {
    lab.expectNoProblems([/THREE\.Clock/, /gradient instruction used in a loop/]);
  });

  test('loads with a valid initial camera pose and one station', async () => {
    const pose = await lab.pose();
    expect(pose).not.toBeNull();
    expect(isFiniteVec3(pose!.position)).toBe(true);
    expect(isFiniteVec3(pose!.target)).toBe(true);
    expect(pose!.projection).toBe('perspective');

    const slots = await lab.stationSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.position).toEqual([0, 0, 0]);
  });

  test('every camera mode produces a finite, valid pose, and top-down is orthographic', async () => {
    const modes = ['orbit', 'inspect', 'top-down', 'first-person', 'cinematic', 'orbit'] as const;
    for (const mode of modes) {
      await lab.setCameraMode(mode);
      await lab.settle(200);
      expect(await lab.mode()).toBe(mode);
      const pose = await lab.pose();
      expect(pose, `pose after switching to ${mode}`).not.toBeNull();
      expect(isFiniteVec3(pose!.position), `position after switching to ${mode}`).toBe(true);
      expect(isFiniteVec3(pose!.target), `target after switching to ${mode}`).toBe(true);
      expect(Number.isFinite(pose!.zoom)).toBe(true);
      if (mode === 'top-down') expect(pose!.projection).toBe('orthographic');
      else expect(pose!.projection).toBe('perspective');
    }
  });

  test('switching to top-down and back preserves the orbit vantage point instead of resetting it', async () => {
    // Orbit the camera away from its default pose first (drag the canvas).
    await lab.page.mouse.move(700, 400);
    await lab.page.mouse.down();
    await lab.page.mouse.move(900, 300, { steps: 8 });
    await lab.page.mouse.up();
    await lab.settle(250);
    const orbited = await lab.pose();

    await lab.setCameraMode('top-down');
    await lab.settle(250);
    const topDown = await lab.pose();
    // Looking straight down: the camera sits almost directly above the target (small X/Z offset).
    expect(Math.abs(topDown!.position[0] - topDown!.target[0])).toBeLessThan(0.05);
    expect(Math.abs(topDown!.position[2] - topDown!.target[2])).toBeLessThan(0.05);
    expect(topDown!.position[1]).toBeGreaterThan(topDown!.target[1]);

    await lab.setCameraMode('orbit');
    await lab.settle(250);
    const backToOrbit = await lab.pose();
    // The distance from the target carries across both projection switches (within numerical tolerance).
    const distance = (p: { position: readonly number[]; target: readonly number[] }) =>
      Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
    expect(distance(backToOrbit!)).toBeCloseTo(distance(orbited!), 1);
  });

  test('pausing the camera blocks pointer orbiting; resuming restores it (the Agent 04 drag contract)', async () => {
    await lab.setCameraMode('orbit');
    await lab.settle(200);
    const before = await lab.pose();

    await lab.pauseCamera('apparatus-drag');
    expect(await lab.isPaused()).toBe(true);
    await lab.page.mouse.move(700, 400);
    await lab.page.mouse.down();
    await lab.page.mouse.move(950, 250, { steps: 8 });
    await lab.page.mouse.up();
    await lab.settle(250);
    const whilePaused = await lab.pose();
    expect(whilePaused!.position).toEqual(before!.position);

    await lab.resumeCamera('apparatus-drag');
    expect(await lab.isPaused()).toBe(false);
    await lab.page.mouse.move(700, 400);
    await lab.page.mouse.down();
    await lab.page.mouse.move(950, 250, { steps: 8 });
    await lab.page.mouse.up();
    await lab.settle(250);
    const afterResume = await lab.pose();
    expect(afterResume!.position).not.toEqual(before!.position);
  });

  test('multiple stations lay out without overlapping, and stay fixed while the camera moves', async () => {
    await lab.addStation();
    await lab.addStation();
    const before = await lab.stationSlots();
    expect(before).toHaveLength(3);
    const xs = before.map((s) => s.position[0]).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeGreaterThan(1);
    expect(xs[2]! - xs[1]!).toBeGreaterThan(1);

    await lab.fitAllStations(false);
    await lab.setCameraMode('top-down');
    await lab.setCameraMode('first-person');
    await lab.setCameraMode('orbit');
    await lab.settle(200);

    const after = await lab.stationSlots();
    expect(after).toEqual(before);
  });

  test('reduced motion makes the cinematic intro resolve immediately instead of playing the full path', async () => {
    await lab.eval('lab.actions.setReducedMotion(true);');
    const start = Date.now();
    await lab.eval('return lab.camera.playIntro([{pose:{position:[9,5,11],target:[0,1,0],zoom:1,projection:"perspective"},travelSeconds:0},{pose:{position:[1,1,1],target:[0,1,0],zoom:1,projection:"perspective"},travelSeconds:3}]);');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('environment settings (mode, lighting, quality) are reflected in the store after changing them', async () => {
    await lab.setEnvironmentMode('studio');
    await lab.setLightingPreset('night-lab');
    await lab.setQuality('quality');
    const env = await lab.environment();
    expect(env.mode).toBe('studio');
    expect(env.lightingPresetId).toBe('night-lab');
    expect(env.qualityId).toBe('quality');
  });

  test('records a render-mode performance snapshot (measured, not asserted against a fixed target)', async () => {
    await lab.settle(1500);
    const perf = await lab.perf();
    expect(perf.framesRendered).toBeGreaterThan(0);
    expect(Number.isFinite(perf.drawCalls)).toBe(true);
    expect(Number.isFinite(perf.triangles)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[lab-environment perf] fps=${perf.fps.toFixed(1)} frameMs=${perf.frameMs.toFixed(2)} drawCalls=${perf.drawCalls} triangles=${perf.triangles}`);
  });
});
