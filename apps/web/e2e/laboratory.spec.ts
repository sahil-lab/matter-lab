import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RuntimeSnapshot } from '@matterlab/contracts';
import type { LabCameraView } from '../src/lab/environment';
import { Lab } from './lab';

let lab: Lab;
test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});
test.afterEach(() => lab.expectNoProblems());

async function openLaboratory(page: Page) {
  await page.getByTestId('open-laboratory').click();
  await page.getByTestId('instrument-laboratory').waitFor({ state: 'visible', timeout: 60_000 });
  const intro = page.getByRole('button', { name: 'Skip introduction', exact: true });
  if (await intro.isVisible()) await intro.click();
  await page.waitForFunction(() => !!window.__MATTERLAB_LAB__?.metrics());
}
const snapshot = (page: Page): Promise<RuntimeSnapshot> => page.evaluate(() => window.__MATTERLAB_LAB__!.snapshot());
const camera = (page: Page): Promise<LabCameraView> => page.evaluate(() => window.__MATTERLAB_LAB__!.session.camera.getView());
function roles(state: RuntimeSnapshot) {
  const stationId = state.scene.stations[0]!.id;
  const burette = state.scene.apparatus.find((instance) => instance.kind === 'BURETTE' && instance.stationId === stationId)!;
  const flask = state.scene.apparatus.find((instance) => instance.kind === 'FLASK' && instance.stationId === stationId)!;
  return { stationId, burette, flask };
}

test('operates the real worker-driven titration, preserves inventory and restores the saved run', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const molecule = await lab.atoms();
  await openLaboratory(page);
  const before = await snapshot(page);
  const { stationId, burette, flask } = roles(before);
  const otherStation = before.scene.stations[1]!.id;
  await page.getByTestId('lab-prepare-reference').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('1.0000');
  await page.getByTestId('lab-immerse-probe').click();
  await expect(page.getByTestId('lab-probe-ph')).toHaveText('1.0000');
  await page.getByTestId('lab-valve').press('End');
  await page.getByTestId('lab-play').click();
  await expect.poll(async () => Number(await page.getByTestId('lab-delivered-ml').innerText())).toBeGreaterThan(0.2);
  await page.getByTestId('lab-play').click();
  await expect.poll(async () => (await snapshot(page)).stationStates[stationId]!.status).toBe('PAUSED');
  const stopped = await snapshot(page);
  await page.waitForTimeout(300);
  expect((await snapshot(page)).transferTotals).toEqual(stopped.transferTotals);
  const delivered = stopped.transferTotals.find((entry) => entry.sourceInstanceId === burette.id)!.deliveredVolumeL;
  expect(delivered).toBeLessThan(0.025);
  await page.getByRole('button', { name: 'Close stopcock', exact: true }).click();
  await expect(page.getByTestId('lab-valve')).toHaveValue('0');
  await page.getByTestId('lab-play').click();
  await page.getByRole('spinbutton', { name: 'Metered dose in milliliters' }).fill(String((0.025 - delivered) * 1000));
  await page.getByTestId('lab-dose-drop').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('7.0000');
  await expect(page.getByTestId('lab-probe-ph')).toHaveText('7.0000');
  await page.getByTestId('lab-play').click();
  await page.getByRole('button', { name: 'Close stopcock', exact: true }).click();
  const final = await snapshot(page);
  expect(final.scene.containerStates[burette.id]!.volumeL).toBeCloseTo(0.025, 12);
  expect(final.scene.containerStates[flask.id]!.volumeL).toBeCloseTo(0.05, 12);
  expect(final.stationStates[otherStation]).toEqual(before.stationStates[otherStation]);
  const latest = final.observations.findLast((entry) => entry.observation.type === 'PH' && entry.observation.apparatusId === flask.id)!;
  expect(latest.observation).toMatchObject({ evidence: 'MODEL_CALCULATED', methodId: 'aqueous-acid-base-ideal-v1', quantity: { unit: 'pH' } });
  expect(latest.observation.quantity.value).toBeCloseTo(7, 7);
  expect(latest.observation.sourceIds.length).toBeGreaterThan(0);
  await expect(page.getByRole('img', { name: 'Recorded pH against delivered volume in milliliters' })).toBeVisible();
  await page.getByRole('button', { name: 'Open scientific inspector', exact: true }).click();
  await page.getByRole('group', { name: 'Laboratory inspector tab' }).getByRole('button', { name: 'learning', exact: true }).click();
  await page.getByRole('radio', { name: /^Guided lab/ }).check();
  await page.getByRole('spinbutton', { name: 'Your delivered-volume meniscus reading (mL)' }).fill('25');
  await page.getByRole('button', { name: 'Record scale reading', exact: true }).click();
  const capture = page.getByRole('button', { name: 'Capture current endpoint', exact: true });
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect.poll(() => page.evaluate((id) => window.__MATTERLAB_LAB__!.session.challenges.get(id)!.getSnapshot().trial.status, stationId)).toBe('captured');
  await page.getByTestId('lab-notebook').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download local draft', exact: true }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('No saved laboratory download was created.');
  const saved = JSON.parse(await readFile(path, 'utf8')) as { remoteSave: string; runtimeCheckpoint: { snapshot: RuntimeSnapshot }; scene: RuntimeSnapshot['scene'] };
  expect(saved.remoteSave).toBe('UNCONFIRMED');
  expect(saved.runtimeCheckpoint.snapshot.scene.containerStates).toEqual(final.scene.containerStates);
  expect(saved.scene.id).toBe(final.scene.id);
  await page.getByRole('button', { name: 'Close Laboratory notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Return to molecular workspace', exact: true }).click();
  await expect(page.getByTestId('open-laboratory')).toBeVisible();
  expect(await lab.atoms()).toEqual(molecule);
  await page.reload();
  await lab.ready();
  await openLaboratory(page);
  await expect(page.getByTestId('lab-current-ph')).toHaveText('7.0000');
  expect((await snapshot(page)).scene.containerStates).toEqual(final.scene.containerStates);
  expect((await snapshot(page)).observations).toEqual(final.observations);
});

test('assembles a working titration from an empty bench with drag and accessible socket controls', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openLaboratory(page);
  await page.getByRole('button', { name: 'New empty lab', exact: true }).click();
  await page.getByTestId('lab-confirm-new').click();
  await page.waitForFunction(() => window.__MATTERLAB_LAB__?.snapshot().scene.apparatus.length === 2 && !!window.__MATTERLAB_LAB__.metrics());
  await page.getByRole('searchbox', { name: 'Find equipment', exact: true }).fill('Retort stand');
  const card = page.getByRole('button', { name: 'Retort stand Supports', exact: true });
  await card.scrollIntoViewIfNeeded();
  const rect = await card.boundingBox();
  if (!rect) throw new Error('The equipment palette card has no bounds.');
  const position = await page.evaluate(() => window.__MATTERLAB_LAB__!.session.camera.projectPoint([-0.45, 0.9, 0]));
  if (!position?.visible) throw new Error('The target workbench point is not visible.');
  const originalCamera = await camera(page);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(position.clientX, position.clientY, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).scene.apparatus.filter((instance) => instance.kind === 'STAND').length).toBe(1);
  const unchanged = await camera(page);
  expect(unchanged.mode).toBe(originalCamera.mode);
  for (const axis of [0, 1, 2]) {
    expect(unchanged.positionM[axis]).toBeCloseTo(originalCamera.positionM[axis]!, 10);
    expect(unchanged.targetM[axis]).toBeCloseTo(originalCamera.targetM[axis]!, 10);
  }
  const stand = (await snapshot(page)).scene.apparatus.find((instance) => instance.kind === 'STAND')!;
  expect(stand.transform.positionM[1]).toBeCloseTo(0.9, 5);
  expect((await snapshot(page)).scene.containerStates).toEqual({});

  await page.getByRole('button', { name: 'Open scientific inspector', exact: true }).click();
  const inspector = page.getByRole('region', { name: 'Accessible laboratory editor', exact: true });
  async function choose(label: string) {
    await page.getByRole('searchbox', { name: 'Find equipment', exact: true }).fill(label);
    await page.getByRole('region', { name: 'Apparatus palette' }).getByRole('button', { name: new RegExp(`^${label}`) }).click();
  }
  async function mount(label: string, parent: string) {
    await choose(label);
    await inspector.getByRole('combobox', { name: 'Compatible mechanical mount' }).selectOption({ label: parent });
    await inspector.getByRole('button', { name: 'Place and attach atomically', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).scene.apparatus.length).toBe(++count);
  }
  let count = 3;
  await mount('Burette clamp', 'Retort stand / clamp-mount');
  await mount('50 mL burette', 'Burette clamp / barrel-grip');
  await choose('Magnetic stirrer');
  await inspector.getByRole('spinbutton', { name: 'Local X (m)', exact: true }).fill('-0.13');
  await inspector.getByRole('spinbutton', { name: 'Local Z (m)', exact: true }).fill('0');
  await inspector.getByRole('button', { name: 'Place on surface', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.apparatus.length).toBe(++count);
  await mount('250 mL conical flask', 'Magnetic stirrer / platform');
  const assembled = await snapshot(page);
  const source = assembled.scene.apparatus.find((instance) => instance.kind === 'BURETTE')!;
  const receiver = assembled.scene.apparatus.find((instance) => instance.kind === 'FLASK')!;
  await inspector.getByRole('listbox', { name: 'Apparatus selection' }).selectOption(source.id);
  await inspector.locator('[data-control-id="socket:outlet"]').click();
  await inspector.getByRole('combobox', { name: 'Target socket', exact: true }).selectOption({ label: '250 mL conical flask / inlet' });
  await inspector.getByRole('button', { name: 'Connect selected sockets', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).scene.connections.some((edge) => edge.kind === 'FLUID' && edge.from.instanceId === source.id && edge.to.instanceId === receiver.id)).toBe(true);
  await page.getByTestId('lab-prepare-reference').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('1.0000');
});

test('renders with forced WebGL fallback while scientific state stays unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openLaboratory(page);
  const initial = await snapshot(page);
  await expect.poll(() => page.evaluate(() => window.__MATTERLAB_LAB__!.metrics()!.drawCalls)).toBeGreaterThan(0);
  await page.getByText('World & camera', { exact: true }).click();
  const options = page.locator('.laboratory-view-options');
  await options.getByLabel('Laboratory rendering backend', { exact: true }).scrollIntoViewIfNeeded();
  const cameraLayout = await options.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const controls = element.querySelector('.lab-view-controls')!.getBoundingClientRect();
    const selector = element.querySelector('select[aria-label="Laboratory rendering backend"]')!.getBoundingClientRect();
    return { top: controls.top, after: selector.bottom, left: controls.left, right: controls.right, panelLeft: panel.left, panelRight: panel.right };
  });
  expect(cameraLayout.top).toBeGreaterThan(cameraLayout.after);
  expect(cameraLayout.left).toBeGreaterThanOrEqual(cameraLayout.panelLeft);
  expect(cameraLayout.right).toBeLessThanOrEqual(cameraLayout.panelRight);
  await page.getByLabel('Laboratory rendering backend', { exact: true }).selectOption('webgl2');
  await page.waitForFunction(() => window.__MATTERLAB_LAB__?.metrics()?.backend === 'webgl2');
  expect((await snapshot(page)).scene).toEqual(initial.scene);
  expect((await snapshot(page)).observations).toEqual(initial.observations);
  const measured = await page.evaluate(() => window.__MATTERLAB_LAB__!.metrics());
  expect(measured!.drawCalls).toBeGreaterThan(0);
  expect(measured!.triangles).toBeGreaterThan(100);
  await page.getByLabel('Laboratory environment', { exact: true }).selectOption('studio');
  await page.getByRole('button', { name: 'Top-down view', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Laboratory display settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Render quality' }).selectOption('low');
  await page.getByRole('button', { name: 'Close Display & access', exact: true }).click();
  await expect(page.locator('.lab-environment')).toHaveAttribute('data-lab-reduced-motion', 'true');
  await expect.poll(() => page.evaluate(() => window.__MATTERLAB_LAB__?.metrics()?.quality)).toBe('low');
  expect((await snapshot(page)).scene).toEqual(initial.scene);
  expect((await snapshot(page)).observations).toEqual(initial.observations);
});

test('duplicates an empty station, runs two independent titrations and reopens both notebooks', async ({ page }) => {
  test.setTimeout(240_000);
  await openLaboratory(page);
  const firstId = (await snapshot(page)).scene.stations[0]!.id;
  await page.getByRole('button', { name: 'Open scientific inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate workstation…', exact: true }).click();
  await page.waitForFunction(() => window.__MATTERLAB_LAB__?.snapshot().scene.stations.length === 3 && !!window.__MATTERLAB_LAB__.metrics());
  const scene = (await snapshot(page)).scene;
  const secondId = scene.stations[2]!.id;
  const firstVessels = scene.apparatus.filter((instance) => instance.stationId === firstId && instance.capabilities.includes('CONTAINER')).map((instance) => instance.id);
  const secondVessels = scene.apparatus.filter((instance) => instance.stationId === secondId && instance.capabilities.includes('CONTAINER')).map((instance) => instance.id);
  const station = page.getByRole('combobox', { name: 'Active laboratory station', exact: true });
  for (const id of [firstId, secondId]) {
    await station.selectOption(id);
    await page.getByTestId('lab-prepare-reference').click();
    await expect(page.getByTestId('lab-current-ph')).toHaveText('1.0000');
  }
  const prepared = await snapshot(page);
  await station.selectOption(firstId);
  await page.getByTestId('lab-play').click();
  await page.getByRole('spinbutton', { name: 'Metered dose in milliliters' }).fill('10');
  await page.getByTestId('lab-dose-drop').click();
  await expect(page.getByTestId('lab-delivered-ml')).toHaveText('10.000');
  await page.getByTestId('lab-play').click();
  const firstFinished = await snapshot(page);
  for (const id of secondVessels) expect(firstFinished.scene.containerStates[id]).toEqual(prepared.scene.containerStates[id]);
  expect(firstFinished.stationStates[secondId]).toEqual(prepared.stationStates[secondId]);
  await station.selectOption(secondId);
  await page.getByTestId('lab-play').click();
  await page.getByRole('spinbutton', { name: 'Metered dose in milliliters' }).fill('25');
  await page.getByTestId('lab-dose-drop').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('7.0000');
  await page.getByTestId('lab-play').click();
  const finished = await snapshot(page);
  for (const id of firstVessels) expect(finished.scene.containerStates[id]).toEqual(firstFinished.scene.containerStates[id]);
  expect(finished.stationStates[firstId]).toEqual(firstFinished.stationStates[firstId]);
  await page.getByTestId('lab-notebook').click();
  await page.getByRole('button', { name: 'Close Laboratory notebook', exact: true }).click();
  await page.reload();
  await lab.ready();
  await openLaboratory(page);
  expect((await snapshot(page)).scene.containerStates).toEqual(finished.scene.containerStates);
  expect((await snapshot(page)).observations).toEqual(finished.observations);
  await expect.poll(() => page.evaluate(() => window.__MATTERLAB_LAB__!.session.challenges.size)).toBe(3);
  await page.getByRole('combobox', { name: 'Active laboratory station', exact: true }).selectOption(firstId);
  await expect(page.getByTestId('lab-delivered-ml')).toHaveText('10.000');
  await page.getByRole('combobox', { name: 'Active laboratory station', exact: true }).selectOption(secondId);
  await expect(page.getByTestId('lab-delivered-ml')).toHaveText('25.000');
});
