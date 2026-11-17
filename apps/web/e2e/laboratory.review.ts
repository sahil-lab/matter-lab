import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { parseExperimentScene } from '@matterlab/contracts';
import type { ExperimentScene } from '@matterlab/contracts';
import { SCIENCE_METHOD_ID } from '@matterlab/lab-science';
import { createTitrationSetup } from '../src/lab/apparatus/seeds';
import type { LabFrameMetrics } from '../src/lab/environment';
import { Lab } from './lab';

const screenshots = resolve('..', '..', 'docs', 'screenshots', 'laboratory');
const benchmarks = resolve('..', '..', 'docs', 'benchmarks');
test.beforeAll(() => mkdir(screenshots, { recursive: true }));

async function open(page: Page) {
  const lab = new Lab(page);
  await lab.open();
  const device = await lab.eval<Record<string, unknown>>('return lab.device();');
  await page.getByTestId('open-laboratory').click();
  await page.getByTestId('instrument-laboratory').waitFor();
  const intro = page.getByRole('button', { name: 'Skip introduction', exact: true });
  if (await intro.isVisible()) await intro.click();
  await page.waitForFunction(() => !!window.__MATTERLAB_LAB__?.metrics());
  return { lab, device };
}

test('captures real titration and responsive laboratory views', async ({ page }) => {
  const { lab } = await open(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId('lab-prepare-reference').click();
  await page.getByTestId('lab-immerse-probe').click();
  await expect(page.getByTestId('lab-probe-ph')).toHaveText('1.0000');
  await page.screenshot({ path: resolve(screenshots, 'desktop-prepared.png') });
  await page.getByTestId('lab-play').click();
  await page.getByRole('spinbutton', { name: 'Metered dose in milliliters' }).fill('10');
  await page.getByTestId('lab-dose-drop').click();
  await page.getByTestId('lab-play').click();
  await expect(page.getByTestId('lab-delivered-ml')).toHaveText('10.000');
  await page.screenshot({ path: resolve(screenshots, 'desktop-10ml.png') });
  await page.getByTestId('lab-play').click();
  await page.getByRole('spinbutton', { name: 'Metered dose in milliliters' }).fill('15');
  await page.getByTestId('lab-dose-drop').click();
  await page.getByTestId('lab-play').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('7.0000');
  await page.screenshot({ path: resolve(screenshots, 'desktop-equivalence.png') });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: resolve(screenshots, 'laptop-equivalence.png') });
  await page.getByRole('button', { name: 'Open scientific inspector', exact: true }).click();
  await page.getByRole('group', { name: 'Laboratory inspector tab' }).getByRole('button', { name: 'science', exact: true }).click();
  await page.screenshot({ path: resolve(screenshots, 'laptop-science.png') });
  await page.getByRole('button', { name: 'Collapse scientific inspector', exact: true }).click();
  await page.getByText('World & camera', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Laboratory environment', exact: true }).selectOption('studio');
  await page.getByRole('button', { name: 'Top-down view', exact: true }).click();
  await page.screenshot({ path: resolve(screenshots, 'laptop-top-down.png') });
  await page.getByRole('combobox', { name: 'Laboratory rendering backend', exact: true }).selectOption('webgl2');
  await page.waitForFunction(() => window.__MATTERLAB_LAB__?.metrics()?.backend === 'webgl2');
  await page.getByRole('button', { name: 'Orbit view', exact: true }).click();
  await page.screenshot({ path: resolve(screenshots, 'laptop-webgl.png') });
  await page.getByTestId('lab-notebook').click();
  await page.screenshot({ path: resolve(screenshots, 'laptop-notebook.png') });
  lab.expectNoProblems();
});

function teachingScene(count: number): ExperimentScene {
  const seed = createTitrationSetup(SCIENCE_METHOD_ID).scene;
  const stations: ExperimentScene['stations'][number][] = [];
  const apparatus: ExperimentScene['apparatus'][number][] = [];
  const connections: ExperimentScene['connections'][number][] = [];
  const columns = Math.min(4, count);
  const rows = Math.ceil(count / columns);
  for (let index = 0; index < count; index++) {
    const source = createTitrationSetup(SCIENCE_METHOD_ID).scene;
    const station = source.stations[0]!;
    const x = (index % columns - (columns - 1) / 2) * 3;
    const z = (Math.floor(index / columns) - (rows - 1) / 2) * 1.8;
    stations.push({ ...station, name: `Station ${index + 1}` });
    apparatus.push(...source.apparatus.filter((instance) => instance.stationId === station.id).map((instance) => ({
      ...instance,
      transform: { ...instance.transform, positionM: [instance.transform.positionM[0] + x, instance.transform.positionM[1], instance.transform.positionM[2] + z] as const },
    })));
    connections.push(...source.connections);
  }
  return parseExperimentScene({ ...seed, stations, apparatus, connections });
}

test('measures one, ten and sixteen stations with actual rendered apparatus', async ({ page, browser }) => {
  const { lab, device } = await open(page);
  const results: {
    stations: number; apparatus: number; quality: string; loadToFirstMetricMs: number;
    frameSamplesMs: number[]; metrics: LabFrameMetrics; meanFps: number; medianFrameMs: number; p95FrameMs: number;
    heapBytes: number | null;
  }[] = [];
  for (const stations of [1, 10, 16]) {
    const scene = teachingScene(stations);
    const start = Date.now();
    await page.evaluate(async (json) => {
      const scene: ExperimentScene = JSON.parse(json);
      await window.__MATTERLAB_LAB__!.openDraft({ title: `${scene.stations.length}-station rendering measurement`, scene, runtimeCheckpoint: null });
    }, JSON.stringify(scene));
    await page.waitForFunction((id) => window.__MATTERLAB_LAB__?.snapshot().scene.id === id && !!window.__MATTERLAB_LAB__.metrics(), scene.id);
    const loadToFirstMetricMs = Date.now() - start;
    await page.getByText('World & camera', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Laboratory environment', exact: true }).selectOption('studio');
    await page.evaluate(() => {
      const { session, snapshot } = window.__MATTERLAB_LAB__!;
      const positions = snapshot().scene.apparatus.filter((instance) => instance.kind === 'BENCH').map((instance) => instance.transform.positionM);
      session.camera.focusBounds({
        minM: [Math.min(...positions.map((point) => point[0])) - 1.2, 0, Math.min(...positions.map((point) => point[2])) - 0.525],
        maxM: [Math.max(...positions.map((point) => point[0])) + 1.2, 1.8, Math.max(...positions.map((point) => point[2])) + 0.525],
      }, { animate: false, padding: 1.08 });
    });
    for (const quality of ['balanced', 'low']) {
      await page.getByRole('button', { name: 'Laboratory display settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Render quality' }).selectOption(quality);
      await page.getByRole('button', { name: 'Close Display & access', exact: true }).click();
      await page.waitForFunction((quality) => window.__MATTERLAB_LAB__?.metrics()?.quality === quality, quality);
      await page.waitForTimeout(3000);
      const sample = await page.evaluate(async () => {
        const frames: number[] = [];
        await new Promise<void>((done) => {
          let previous = 0;
          let start = 0;
          function frame(now: number) {
            if (!start) start = now;
            if (previous) frames.push(now - previous);
            previous = now;
            if (now - start >= 8000) done(); else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        });
        return {
          frames, metrics: window.__MATTERLAB_LAB__!.metrics()!,
          heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
        };
      });
      expect(sample.metrics.visibility).toBe('visible');
      expect(sample.metrics.drawCalls).toBeGreaterThan(0);
      expect(sample.metrics.triangles).toBeGreaterThan(0);
      expect(sample.frames.length).toBeGreaterThan(1);
      const sorted = [...sample.frames].sort((a, b) => a - b);
      const meanFps = 1000 * sorted.length / sorted.reduce((sum, duration) => sum + duration, 0);
      results.push({
        stations, apparatus: scene.apparatus.length, quality, loadToFirstMetricMs, frameSamplesMs: sample.frames,
        metrics: sample.metrics, meanFps, medianFrameMs: sorted[Math.floor(sorted.length / 2)]!,
        p95FrameMs: sorted[Math.ceil(sorted.length * 0.95) - 1]!, heapBytes: sample.heapBytes,
      });
      await page.screenshot({ path: resolve(screenshots, `${stations}-stations-${quality}.png`) });
      expect(await page.evaluate(() => window.__MATTERLAB_LAB__!.snapshot().scene.containerStates)).toEqual({});
    }
    const bytes = await page.evaluate(async () => JSON.stringify(await window.__MATTERLAB_LAB__!.session.snapshotDraft()).length);
    expect(bytes).toBeGreaterThan(0);
    await page.getByTestId('lab-notebook').click();
    await expect(page.getByRole('dialog', { name: 'Laboratory notebook', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close Laboratory notebook', exact: true }).click();
  }
  await mkdir(benchmarks, { recursive: true });
  const report = {
    measuredAt: new Date().toISOString(), browser: browser.version(), cpu: cpus()[0]?.model, device,
    viewport: page.viewportSize(), scope: 'Whole-page animation cadence, not isolated GPU execution time; empty assembled stations in studio.',
    concurrentDesktop: process.env.MATTERLAB_BENCH_CONCURRENT_DESKTOP === '1',
    cpuRenderMs: null, gpuRenderMs: null, shaderCompilationMs: null,
    limitations: ['Shared machine; no claim of an isolated hardware laboratory.', 'Load-to-first-metric includes worker/UI/renderer initialization, not just shader compilation.', 'GPU allocation bytes are null when not reported by Three.js.'],
    results,
  };
  await writeFile(resolve(benchmarks, 'laboratory.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Laboratory rendering measurements', '', `Measured ${report.measuredAt} with Edge/Chromium ${report.browser}.`, '',
    `${report.scope} Viewport: 1366 x 768. CPU: ${report.cpu}.`, '',
    '| Stations | Apparatus | Quality | Backend | FPS | Median ms | P95 ms | Draw calls | Triangles | DPR |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((run) => `| ${run.stations} | ${run.apparatus} | ${run.quality} | ${run.metrics.backend} | ${run.meanFps.toFixed(1)} | ${run.medianFrameMs.toFixed(1)} | ${run.p95FrameMs.toFixed(1)} | ${run.metrics.drawCalls} | ${run.metrics.triangles} | ${run.metrics.dpr.toFixed(2)} |`),
    '', '## Interpretation', '', 'Target: 60 FPS for a single station and 30 FPS for large scenes. These are measurements, not guaranteed frame rates.',
    ...results.map((run) => `- ${run.stations} station(s), ${run.quality}: ${run.meanFps >= (run.stations === 1 ? 60 : 30) ? 'meets' : 'below'} the target.`),
    '', ...report.limitations.map((limitation) => `- ${limitation}`),
    ...(report.concurrentDesktop ? ['- The user kept the native MATTER LAB application open. These samples include shared GPU/CPU contention and are not an isolated FPS acceptance result.'] : []),
    '- Separate CPU/GPU render timers and isolated shader compilation time were not available and are not invented.',
    '- Raw frame samples, renderer/resource counters and load-to-first-metric times are in [laboratory.json](laboratory.json).',
    '', 'Reproduce: `playwright test --config playwright.laboratory-review.config.ts` from `apps/web` with the project environment loaded.',
  ];
  await writeFile(resolve(benchmarks, 'laboratory.md'), `${lines.join('\n')}\n`);
  lab.expectNoProblems();
});
