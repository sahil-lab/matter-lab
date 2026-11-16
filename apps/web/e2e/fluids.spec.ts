import { expect, test } from '@playwright/test';
import { FluidsLab } from './fluids-lab';

let lab: FluidsLab;

test.beforeEach(async ({ page }) => {
  lab = new FluidsLab(page);
  await lab.open();
});

test.describe('lab/fluids regression harness', () => {
  test('loads every scenario without console errors or a lost graphics context', async () => {
    for (const id of ['clear-liquid', 'tinted-liquid', 'burette-levels', 'swirling', 'endpoint-titration'] as const) {
      await lab.setScenario(id);
      await lab.settle(400);
      const state = await lab.state();
      expect(state.scenario).toBe(id);
    }
    lab.expectNoProblems();
  });

  test('burette reading and meniscus-derived volume agree at 10 mL delivered (acceptance test)', async () => {
    await lab.setScenario('endpoint-titration');
    await lab.setDeliveredMl(10);
    await lab.settle(200);

    // The burette's own rendered graduation reads "delivered mL", computed from the same
    // remaining-volume -> height conversion the 3D meniscus uses (geometry/vesselProfile.ts); see
    // its own unit tests for the exact round-trip. This is the end-to-end wiring check (does the
    // scene actually display what the authoritative volume implies), not a re-derivation of that math.
    const reading = await lab.buretteReadingML();
    expect(reading).toBeCloseTo(10, 2);

    const state = await lab.state();
    expect(state.deliveredMl).toBeCloseTo(10, 6);
    lab.expectNoProblems();
  });

  test('droplets appear only while flow is open, land on their own when it closes, and reset clears them instantly', async () => {
    await lab.setScenario('endpoint-titration');
    await lab.reset();

    expect(await lab.activeDroplets()).toBe(0);

    await lab.setDripping(true);
    await lab.page.waitForTimeout(900);
    const whileDripping = await lab.activeDroplets();
    expect(whileDripping).toBeGreaterThan(0);

    await lab.setDripping(false);
    // Drops already in flight should still land naturally (not vanish instantly) ...
    await lab.page.waitForTimeout(50);
    // ... but within a couple of fall durations, every drop has landed and none are left ("no ghost droplets").
    await lab.page.waitForTimeout(600);
    expect(await lab.activeDroplets()).toBe(0);

    // An explicit reset clears in-flight drops immediately, even mid-flow.
    await lab.setDripping(true);
    await lab.page.waitForTimeout(500);
    expect(await lab.activeDroplets()).toBeGreaterThan(0);
    await lab.reset();
    expect(await lab.activeDroplets()).toBe(0);
    const state = await lab.state();
    expect(state.dripping).toBe(false);
    expect(state.deliveredMl).toBe(0);
    lab.expectNoProblems();
  });

  test('never drips at zero flow (no droplets spawn merely by changing the delivered volume manually)', async () => {
    await lab.setScenario('endpoint-titration');
    await lab.reset();
    await lab.setDeliveredMl(5);
    await lab.setDeliveredMl(15);
    await lab.page.waitForTimeout(300);
    expect(await lab.activeDroplets()).toBe(0);
    lab.expectNoProblems();
  });

  test('the indicator color near the endpoint is chemistry-driven: the rendered flask liquid pixel changes between just before and just after equivalence (25.00 mL)', async () => {
    await lab.setScenario('endpoint-titration');
    await lab.reset();
    // The 'efficient' tier's liquid material is a direct alpha-blended `color`, so a sampled pixel
    // reflects `colorHex` unambiguously; nested glass+liquid *transmission* at higher tiers can make
    // a thin-path color change hard to tell apart from the background by eye at a single pixel.
    await lab.eval("lab.getState().setQualityTier('efficient');");
    await lab.settle(200);
    // Inside the flask body, well below its liquid surface at every tested volume (see dev notes:
    // surface height is >= ~8 mm even at the smallest volume here, 25 mL).
    const samplePoint: [number, number, number] = [0.025, 0.004, 0];

    await lab.setDeliveredMl(24.9);
    await lab.settle(250);
    const before = await lab.projectWorldPoint(samplePoint);
    expect(before).not.toBeNull();
    const colorBefore = await lab.pixelColorAt(before![0], before![1]);

    await lab.setDeliveredMl(25.5);
    await lab.settle(250);
    const after = await lab.projectWorldPoint(samplePoint);
    expect(after).not.toBeNull();
    const colorAfter = await lab.pixelColorAt(after![0], after![1]);

    const delta = Math.hypot(colorAfter[0] - colorBefore[0], colorAfter[1] - colorBefore[1], colorAfter[2] - colorBefore[2]);
    expect(delta).toBeGreaterThan(15); // a visibly different rendered color, not a no-op recolor
    lab.expectNoProblems();
  });

  test('quality tiers render without errors, including the low-power alpha-blended fallback', async () => {
    for (const tier of ['efficient', 'balanced', 'quality'] as const) {
      await lab.eval(`lab.getState().setQualityTier(${JSON.stringify(tier)});`);
      await lab.settle(400);
      expect((await lab.state()).qualityTier).toBe(tier);
    }
    lab.expectNoProblems();
  });

  test('reduced motion can be toggled without errors', async () => {
    await lab.setScenario('swirling');
    await lab.eval('lab.getState().setReducedMotion(true);');
    await lab.settle(500);
    expect((await lab.state()).reducedMotion).toBe(true);
    lab.expectNoProblems();
  });
});
