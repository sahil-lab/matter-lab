import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { Lab } from './lab';

/**
 * Rendering and responsiveness benchmark, run in the real application on this machine's GPU.
 * It measures; the only things it asserts are that the scenes were built as intended and that the
 * measurements are plausible enough to report. Results go to docs/benchmarks.
 */

const OUT = fileURLToPath(new URL('../../../docs/benchmarks/', import.meta.url));
const SIZES = [1_000, 10_000, 50_000, 100_000] as const;
const QUALITIES = ['efficient', 'balanced', 'quality'] as const;
const WARMUP_MS = 3500;
const MEASURE_MS = 4000;
/** How often every large-scene configuration is measured, each time in a separate pass over all scenes. */
const PASSES = 3;

interface Pacing {
  frames: number;
  seconds: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  /** Main-thread time per frame, median. */
  cpuMs: number | null;
  /** GPU time per frame, median; null when the browser exposes no timer queries. */
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  heapMb: number | null;
}

interface Run extends Pacing {
  quality: string;
  representation: string;
}

interface SceneResult {
  atoms: number;
  bonds: number;
  molecules: number;
  buildMs: number;
  firstFrameMs: number;
  autosaveSerialiseMs: number;
  autosaveBytes: number;
  /** One step of dragging an atom: the view follows the pointer without the scene being edited yet. */
  dragStepMs: number;
  /** Releasing the drag: the move becomes one undoable edit of the scene. */
  commitMoveMs: number;
  addAtomMs: number;
  deleteAtomMs: number;
  undoMs: number;
  runs: Run[];
}

/** One configuration over all passes: the run with the middle frame rate, and the frame rate of every run. */
interface RepeatedRun extends Run {
  /** In the order measured. */
  fpsRuns: number[];
}

/** A scene over all passes: the middle one of each single timing, and every configuration with its repeats. */
type SceneSummary = Omit<SceneResult, 'runs'> & { runs: RepeatedRun[] };

let lab: Lab;

/** Orbits the camera continuously for a while and reports how the frames were paced. */
function orbit(durationMs: number): Promise<Pacing> {
  return lab.page.evaluate(
    (duration) =>
      new Promise<Pacing>((resolve) => {
        const api = (window as unknown as { __MATTERLAB__: { viewApi: { getPose(): { position: number[]; target: number[] }; setPose(pose: unknown, animate: boolean): void }; perf: { reset(): void; snapshot(): Record<string, number | null> } } }).__MATTERLAB__;
        const pose = api.viewApi.getPose();
        const [tx, ty, tz] = pose.target as [number, number, number];
        const dx = pose.position[0]! - tx;
        const dy = pose.position[1]! - ty;
        const dz = pose.position[2]! - tz;
        const stamps: number[] = [];
        api.perf.reset();
        const start = performance.now();
        const tick = (now: number) => {
          stamps.push(now);
          // 0.8 radians per second about the vertical axis through the centre of the scene.
          const angle = ((now - start) / 1000) * 0.8;
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          api.viewApi.setPose({ ...pose, position: [tx + dx * c + dz * s, ty + dy, tz - dx * s + dz * c] }, false);
          if (now - start < duration) {
            requestAnimationFrame(tick);
            return;
          }
          const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!).sort((a, b) => a - b);
          const at = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0;
          const snapshot = api.perf.snapshot();
          const seconds = (stamps[stamps.length - 1]! - stamps[0]!) / 1000;
          resolve({
            frames: stamps.length,
            seconds,
            fps: (stamps.length - 1) / seconds,
            medianMs: at(0.5),
            p95Ms: at(0.95),
            p99Ms: at(0.99),
            worstMs: gaps[gaps.length - 1] ?? 0,
            cpuMs: snapshot.cpuMs as number | null,
            gpuMs: snapshot.gpuMs as number | null,
            drawCalls: snapshot.drawCalls as number,
            triangles: snapshot.triangles as number,
            pixelRatio: snapshot.pixelRatio as number,
            heapMb: snapshot.heapMb as number | null,
          });
        };
        requestAnimationFrame(tick);
      }),
    durationMs,
  );
}

/** Time from calling something that changes the scene until the frame showing it has been drawn. */
function timed(body: string): Promise<number> {
  return lab.eval<number>(`
    return new Promise((resolve) => {
      const before = lab.perf.snapshot().framesRendered;
      const start = performance.now();
      ${body}
      const wait = () => (lab.perf.snapshot().framesRendered > before ? resolve(performance.now() - start) : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    });`);
}

async function setQuality(quality: string): Promise<void> {
  await lab.eval(`lab.lab.set({ quality: '${quality}' });`);
  // Changing between the direct and the post-processing pipeline creates a new canvas.
  await lab.ready();
  await lab.settle(600);
}

const round = (value: number | null, digits = 1): number | null => (value === null ? null : Number(value.toFixed(digits)));

interface PresetSwitch {
  from: string;
  to: string;
  /** Whether the switch replaced the canvas and its graphics context (it does when the render pipeline changes). */
  newContext: boolean;
  /** From choosing the preset to the end of the first frame drawn with it. */
  firstFrameMs: number;
  /** Shader programs the renderer holds once that frame is drawn. */
  programs: number;
}

/** Switches the quality preset and times how long it takes until a frame has been drawn with it. */
async function switchPreset(from: string, to: string): Promise<PresetSwitch> {
  // Efficient draws straight to the screen, the other two through the post-processing chain;
  // crossing between the two replaces the canvas and its graphics context.
  const expectNewContext = (from === 'efficient') !== (to === 'efficient');
  const measured = await lab.eval<{ ms: number; programs: number; newContext: boolean }>(`
    return new Promise((resolve) => {
      const canvas = document.querySelector('.ml-viewport canvas');
      const before = lab.perf.snapshot().framesRendered;
      const start = performance.now();
      lab.lab.set({ quality: '${to}' });
      const wait = () => {
        const now = document.querySelector('.ml-viewport canvas');
        const snapshot = lab.perf.snapshot();
        const replaced = now !== null && now !== canvas;
        if (now && lab.device() && lab.viewApi.getPose() && snapshot.framesRendered > before && snapshot.programs > 0 && (replaced || !${expectNewContext})) {
          resolve({ ms: performance.now() - start, programs: snapshot.programs, newContext: replaced });
        } else {
          requestAnimationFrame(wait);
        }
      };
      requestAnimationFrame(wait);
    });`);
  await lab.ready();
  await lab.settle(500);
  return { from, to, newContext: measured.newContext, firstFrameMs: measured.ms, programs: measured.programs };
}

test('rendering and responsiveness', async ({ page }, testInfo) => {
  lab = new Lab(page);
  await lab.open();
  const device = await lab.eval<Record<string, unknown>>('return lab.device();');
  const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, devicePixelRatio: window.devicePixelRatio, viewport: [window.innerWidth, window.innerHeight], deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null }));
  expect(device.webgl2, 'the benchmark needs a WebGL 2 context').toBe(true);

  // ---------- the empty stage: what a frame costs before there is anything to draw ----------
  const baseline: Run[] = [];
  for (const quality of QUALITIES) {
    await setQuality(quality);
    await lab.eval('lab.actions.newDocument();');
    await lab.settle(400);
    await orbit(WARMUP_MS);
    baseline.push({ quality, representation: 'empty stage', ...(await orbit(MEASURE_MS)) });
  }

  // ---------- budgets of the directive, on a typical molecule (caffeine, 24 atoms) ----------
  await lab.openExample('caffeine');
  await lab.eval('lab.lab.set({ showPerf: false });');
  // Every preset three times in a row, to show how much the same measurement varies on this machine;
  // the middle one is quoted. Balanced comes last because the measurements that follow start from it.
  const typicalPresets: Array<{ quality: (typeof QUALITIES)[number]; runs: Pacing[]; middle: Pacing }> = [];
  for (const quality of ['efficient', 'quality', 'balanced'] as const) {
    await setQuality(quality);
    await orbit(1500);
    const runs = [await orbit(MEASURE_MS), await orbit(MEASURE_MS), await orbit(MEASURE_MS)];
    typicalPresets.push({ quality, runs, middle: [...runs].sort((a, b) => a.fps - b.fps)[1]! });
  }
  typicalPresets.sort((a, b) => QUALITIES.indexOf(a.quality) - QUALITIES.indexOf(b.quality));
  const typical = typicalPresets.find((preset) => preset.quality === 'balanced')!.middle;

  // ---------- what a change of preset costs once: a new pipeline, its shaders, a first frame ----------
  const presetSwitches: PresetSwitch[] = [];
  for (const [from, to] of [
    ['balanced', 'efficient'],
    ['efficient', 'balanced'],
    ['balanced', 'quality'],
    ['quality', 'balanced'],
    ['balanced', 'efficient'],
  ] as const) {
    presetSwitches.push(await switchPreset(from, to));
  }
  await setQuality('balanced');
  await lab.eval("lab.lab.set({ showPerf: false });");
  await lab.settle(300);

  const validationMs = await lab.eval<number>(`
    const scene = lab.lab.get().scene;
    const atom = [...scene.atoms.values()][0];
    let total = 0;
    // A fresh scene each time, since the rule-based report is cached per scene.
    for (let i = 0; i < 20; i++) {
      lab.actions.setAtomPosition(atom.id, [atom.position[0] + 0.001 * (i + 1), atom.position[1], atom.position[2]]);
      const start = performance.now();
      lab.summary();
      total += performance.now() - start;
    }
    for (let i = 0; i < 20; i++) lab.actions.undo();
    return total / 20;`);
  const rdkitMs = await lab.eval<number>(`
    const scene = lab.lab.get().scene;
    return lab.chem.analyseScene(scene).then(() => {
      const start = performance.now();
      return lab.chem.analyseScene(scene).then(() => performance.now() - start);
    });`);
  const searchMs = await lab.eval<number>(`
    const library = lab.examples().map((e) => ({ id: e.id, smiles: e.smiles }));
    return lab.chem.searchStructures('similarity', 'CC(=O)Oc1ccccc1C(=O)O', library, 0).then(() => {
      const start = performance.now();
      return lab.chem.searchStructures('similarity', 'CC(=O)Oc1ccccc1C(=O)O', library, 0).then(() => performance.now() - start);
    });`);
  const dragMs = await timed("const a = [...lab.lab.get().scene.atoms.values()][3]; lab.stageApi.setTransient(new Map([[a.id, [a.position[0] + 0.3, a.position[1], a.position[2]]]]));");
  await lab.eval('lab.stageApi.setTransient(null);');
  const commitMs = await timed("const a = [...lab.lab.get().scene.atoms.values()][3]; lab.actions.setAtomPosition(a.id, [a.position[0] + 0.3, a.position[1], a.position[2]]);");
  const addMs = await timed('lab.actions.placeAtom([6, 0, 0]);');
  await lab.eval('lab.actions.undo(); lab.actions.undo();');
  const reopenSmallMs = await lab.eval<number>(`
    return lab.persistence.saveCurrentProject().then(() => lab.persistence.listProjects()).then((projects) => {
      lab.actions.newDocument();
      const start = performance.now();
      return lab.persistence.openProject(projects[0].id).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))));
    });`);

  // A calculation in a background thread must not hold up the view: caffeine RHF (several seconds) while orbiting.
  // Three times over, for the same reason as above.
  await lab.openExample('caffeine');
  const scfRuns: Array<Pacing & { calculationStillRunningAtEnd: boolean }> = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    await lab.eval('window.__scf = lab.quantum.runQuantum();');
    await page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { quantum: { useQuantum: { getState(): { progress: unknown } } } } }).__MATTERLAB__.quantum.useQuantum.getState().progress !== null);
    const pacing = await orbit(2000);
    const calculationStillRunningAtEnd = await lab.eval<boolean>('return lab.quantum.useQuantum.getState().running;');
    await lab.eval('lab.quantum.cancelQuantum(); return window.__scf;');
    await lab.settle(400);
    scfRuns.push({ ...pacing, calculationStillRunningAtEnd });
  }
  const stillRunning = scfRuns.every((run) => run.calculationStillRunningAtEnd);

  // ---------- synthetic scenes ----------
  const measureScene = async (size: number): Promise<SceneResult> => {
    const molecules = size / 5;
    await setQuality('balanced');
    const built = await lab.eval<{ buildMs: number; firstFrameMs: number; atoms: number; bonds: number }>(`
      const side = Math.ceil(Math.cbrt(${molecules}));
      const spacing = 4.1;
      // Methane: C-H 1.09 angstrom, tetrahedral.
      const h = 1.09 / Math.sqrt(3);
      const corners = [[h, h, h], [-h, -h, h], [-h, h, -h], [h, -h, -h]];
      lab.actions.newDocument();
      lab.lab.set({ autoHydrogens: false, tool: 'select', renderMode: 'ball-stick' });
      const start = performance.now();
      lab.actions.runEdit('Benchmark scene', (e) => {
        let made = 0;
        for (let x = 0; x < side && made < ${molecules}; x++) {
          for (let y = 0; y < side && made < ${molecules}; y++) {
            for (let z = 0; z < side && made < ${molecules}; z++) {
              const cx = (x - (side - 1) / 2) * spacing, cy = (y - (side - 1) / 2) * spacing, cz = (z - (side - 1) / 2) * spacing;
              const c = e.addAtom({ protons: 6, position: [cx, cy, cz] });
              for (const [dx, dy, dz] of corners) e.addBond(c, e.addAtom({ protons: 1, position: [cx + dx, cy + dy, cz + dz] }), 1);
              made++;
            }
          }
        }
      });
      const built = performance.now();
      lab.viewApi.fitAll(false);
      return new Promise((resolve) => {
        const before = lab.perf.snapshot().framesRendered;
        const wait = () => lab.perf.snapshot().framesRendered > before
          ? resolve({ buildMs: built - start, firstFrameMs: performance.now() - built, atoms: lab.lab.get().scene.atoms.size, bonds: lab.lab.get().scene.bonds.size })
          : requestAnimationFrame(wait);
        requestAnimationFrame(wait);
      });`);
    expect(built.atoms).toBe(size);
    expect(built.bonds).toBe(molecules * 4);
    expect((await lab.summary()).errors, 'the synthetic scene is chemically valid').toBe(0);

    const autosave = await lab.eval<{ ms: number; bytes: number }>('const start = performance.now(); const text = JSON.stringify(lab.persistence.buildProjectFile()); return { ms: performance.now() - start, bytes: text.length };');
    const dragStepMs = await timed('const a = [...lab.lab.get().scene.atoms.values()][7]; lab.stageApi.setTransient(new Map([[a.id, [a.position[0] + 0.4, a.position[1], a.position[2]]]]));');
    await lab.eval('lab.stageApi.setTransient(null);');
    await lab.settle(300);
    const commitMoveMs = await timed('const a = [...lab.lab.get().scene.atoms.values()][7]; lab.actions.setAtomPosition(a.id, [a.position[0] + 0.2, a.position[1], a.position[2]]);');
    const addAtomMs = await timed('lab.actions.placeAtom([0, 0, 500]);');
    const added = await lab.eval<number>('return Math.max(...lab.lab.get().scene.atoms.keys());');
    const deleteAtomMs = await timed(`lab.actions.eraseAtoms([${added}]);`);
    const undoMs = await timed('lab.actions.undo();');
    await lab.eval('lab.actions.undo(); lab.actions.undo(); lab.viewApi.fitAll(false);');

    const runs: Run[] = [];
    for (const quality of QUALITIES) {
      await setQuality(quality);
      await lab.eval("lab.lab.set({ renderMode: 'ball-stick' }); lab.viewApi.fitAll(false);");
      await lab.settle(500);
      await orbit(WARMUP_MS);
      runs.push({ quality, representation: 'ball and stick', ...(await orbit(MEASURE_MS)) });
    }
    await setQuality('balanced');
    await lab.eval("lab.lab.set({ renderMode: 'space-fill' }); lab.viewApi.fitAll(false);");
    await lab.settle(900);
    await orbit(WARMUP_MS);
    runs.push({ quality: 'balanced', representation: 'space-filling', ...(await orbit(MEASURE_MS)) });
    for (const run of runs) expect(run.frames, `${size} atoms, ${run.quality}: frames were drawn`).toBeGreaterThan(3);

    return { atoms: built.atoms, bonds: built.bonds, molecules, buildMs: built.buildMs, firstFrameMs: built.firstFrameMs, autosaveSerialiseMs: autosave.ms, autosaveBytes: autosave.bytes, dragStepMs, commitMoveMs, addAtomMs, deleteAtomMs, undoMs, runs };
  };

  // Several passes over all scenes, so that the measurements of one configuration lie minutes apart:
  // something else using the GPU for a few seconds then spoils one of them, not all.
  const passes: SceneResult[][] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    const measured: SceneResult[] = [];
    for (const size of SIZES) measured.push(await measureScene(size));
    passes.push(measured);
  }
  const middle = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const scenes: SceneSummary[] = passes[0]!.map((first, index) => {
    const repeats = passes.map((measured) => measured[index]!);
    const of = (pick: (scene: SceneResult) => number): number => middle(repeats.map(pick));
    return {
      ...first,
      buildMs: of((scene) => scene.buildMs),
      firstFrameMs: of((scene) => scene.firstFrameMs),
      autosaveSerialiseMs: of((scene) => scene.autosaveSerialiseMs),
      dragStepMs: of((scene) => scene.dragStepMs),
      commitMoveMs: of((scene) => scene.commitMoveMs),
      addAtomMs: of((scene) => scene.addAtomMs),
      deleteAtomMs: of((scene) => scene.deleteAtomMs),
      undoMs: of((scene) => scene.undoMs),
      runs: first.runs.map((_, configuration) => {
        const runs = repeats.map((scene) => scene.runs[configuration]!);
        return { ...[...runs].sort((a, b) => a.fps - b.fps)[Math.floor(runs.length / 2)]!, fpsRuns: runs.map((run) => run.fps) };
      }),
    };
  });

  // Reopening a saved scene of modest size (10,000 atoms) from the project library.
  await setQuality('balanced');
  const reopenTenThousandMs = await lab.eval<number>(`
    const side = 13, spacing = 4.1, h = 1.09 / Math.sqrt(3);
    const corners = [[h, h, h], [-h, -h, h], [-h, h, -h], [h, -h, -h]];
    lab.actions.newDocument();
    lab.lab.set({ autoHydrogens: false, tool: 'select', renderMode: 'ball-stick' });
    lab.actions.runEdit('Ten thousand atoms', (e) => {
      let made = 0;
      for (let x = 0; x < side && made < 2000; x++) for (let y = 0; y < side && made < 2000; y++) for (let z = 0; z < side && made < 2000; z++) {
        const c = e.addAtom({ protons: 6, position: [x * spacing, y * spacing, z * spacing] });
        for (const [dx, dy, dz] of corners) e.addBond(c, e.addAtom({ protons: 1, position: [x * spacing + dx, y * spacing + dy, z * spacing + dz] }), 1);
        made++;
      }
    });
    lab.lab.set({ projectName: 'Benchmark 10k' });
    return lab.persistence.saveCurrentProject().then(() => lab.persistence.listProjects()).then((projects) => {
      const saved = projects.find((p) => p.name === 'Benchmark 10k');
      lab.actions.newDocument();
      const start = performance.now();
      return lab.persistence.openProject(saved.id).then(() => new Promise((resolve) => {
        const before = lab.perf.snapshot().framesRendered;
        const wait = () => (lab.perf.snapshot().framesRendered > before && lab.lab.get().scene.atoms.size === 10000 ? resolve(performance.now() - start) : requestAnimationFrame(wait));
        requestAnimationFrame(wait);
      }));
    });`);

  const result = {
    generatedAt: new Date().toISOString(),
    command: 'npm run benchmark',
    machine: { ...device, ...environment },
    browser: `${testInfo.project.use.channel ?? 'bundled Chromium'} (headless), ANGLE Direct3D 11`,
    method: {
      scenes: 'Methane molecules (C-H 1.09 angstrom) on a simple cubic lattice, 4.1 angstrom apart: five atoms and four bonds per molecule, chemically valid.',
      camera: `The camera orbits the scene at 0.8 rad/s, one pose per animation frame, with the whole scene in view. ${WARMUP_MS} ms warm-up, then ${MEASURE_MS} ms measured.`,
      pacing: 'Intervals between animation frames, which the browser caps at the refresh rate of the display. CPU and GPU times are per frame, medians, from the application\'s own monitor (GPU time from EXT_disjoint_timer_query_webgl2 where the browser exposes it).',
      resolution: 'The application lowers the pixel ratio by itself when frames run long; the pixel ratio in force at the end of each run is reported.',
      statistics: `Every configuration of the large scenes was measured ${PASSES} times, once in each of ${PASSES} passes over all scenes, so that the measurements of one configuration lie minutes apart. The tables give the run with the middle frame rate and, beside it, the frame rate of every run in the order measured. The single timings (building, editing) are the middle one of the ${PASSES} passes. The typical molecule and the orbit during a calculation were measured three times in a row.`,
    },
    typicalMolecule: { atoms: 24, presets: typicalPresets },
    emptyStage: baseline,
    presetSwitches,
    budgets: {
      ruleBasedValidationMs: validationMs,
      rdkitCrossCheckMs: rdkitMs,
      similaritySearchSixteenStructuresMs: searchMs,
      dragStepToFrameMs: dragMs,
      commitMoveToFrameMs: commitMs,
      addAtomToFrameMs: addMs,
      reopenSavedCaffeineMs: reopenSmallMs,
      reopenSavedTenThousandAtomsMs: reopenTenThousandMs,
      orbitDuringHartreeFock: scfRuns,
    },
    scenes,
    scenePasses: passes,
  };

  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}render-benchmark.json`, `${JSON.stringify(result, null, 2)}\n`);

  // ---------- the report ----------
  const ms = (value: number | null, digits = 1): string => (value === null ? 'n/a' : value.toFixed(digits));
  const count = (value: number): string => value.toLocaleString('en-US');
  const lines: string[] = [];
  lines.push('# Rendering and responsiveness benchmark', '');
  lines.push('<!-- Generated by apps/web/e2e/render.bench.ts (`npm run benchmark`). Do not edit by hand; run the benchmark again. -->', '');
  lines.push(`Measured ${result.generatedAt.slice(0, 16).replace('T', ' ')} UTC in the running application. Raw numbers: [render-benchmark.json](render-benchmark.json).`, '');
  lines.push('## Machine', '');
  lines.push(`- Graphics: ${String(device.renderer)}`);
  lines.push(`- Software rasteriser: ${device.software ? 'yes (the numbers below then say little about a real GPU)' : 'no'}`);
  lines.push(`- Browser: ${result.browser}`);
  lines.push(`- Logical cores: ${environment.cores}; window ${environment.viewport[0]} x ${environment.viewport[1]} CSS pixels at device pixel ratio ${environment.devicePixelRatio}`);
  lines.push(`- GPU timing available: ${typical.gpuMs === null ? 'no' : 'yes'}`, '');
  lines.push('## How to read the numbers', '');
  for (const text of Object.values(result.method)) lines.push(`- ${text}`);
  lines.push('- "fps" is frames drawn per second during the orbit. A browser draws at most one frame per refresh of the display, so a result at the refresh rate means the cap was reached, not that the scene costs that much; the CPU and GPU columns show the actual cost of a frame.', '');
  lines.push('## Typical molecule', '');
  const each = (values: ReadonlyArray<number | null>, digits = 1): string => values.map((value) => ms(value, digits)).join(', ');
  lines.push('Caffeine (24 atoms). Each preset was measured three times in a row; the row gives the run with the middle frame rate, and the last two columns all three runs in the order measured.', '');
  lines.push('| Preset | fps | Median frame / ms | 95th pct / ms | CPU / ms | GPU / ms | Draw calls | Pixel ratio | fps of the three runs | Worst frame interval of each run / ms |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const preset of typicalPresets) {
    const run = preset.middle;
    lines.push(`| ${preset.quality} | ${ms(run.fps)} | ${ms(run.medianMs)} | ${ms(run.p95Ms)} | ${ms(run.cpuMs, 2)} | ${ms(run.gpuMs, 2)} | ${run.drawCalls} | ${run.pixelRatio.toFixed(2)} | ${each(preset.runs.map((repeat) => repeat.fps))} | ${each(preset.runs.map((repeat) => repeat.worstMs))} |`);
  }
  lines.push('');
  lines.push('## The empty stage', '');
  lines.push('What a frame costs with no atoms at all: the backdrop, the lighting environment and, in the Balanced and Quality presets, the post-processing chain. Whatever a scene costs comes on top of this, and no scene can be drawn faster than this on this machine in this browser.', '');
  lines.push('| Preset | fps | Median frame / ms | 95th pct / ms | Worst / ms | CPU / ms | GPU / ms | Draw calls | Pixel ratio |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const run of baseline) lines.push(`| ${run.quality} | ${ms(run.fps)} | ${ms(run.medianMs)} | ${ms(run.p95Ms)} | ${ms(run.worstMs)} | ${ms(run.cpuMs, 2)} | ${ms(run.gpuMs, 2)} | ${run.drawCalls} | ${run.pixelRatio.toFixed(2)} |`);
  lines.push('');
  lines.push('## Shader compilation and pipeline start-up', '');
  const firstSwitch = presetSwitches[0]!;
  const repeatedSwitch = presetSwitches[presetSwitches.length - 1]!;
  lines.push(
    `Time from choosing a quality preset to the animation frame after the first frame drawn with it, with caffeine on stage. Efficient draws straight to the screen; Balanced and Quality draw through the post-processing chain. Crossing between the two replaces the canvas and its graphics context, so that time covers creating the context, compiling every shader program, uploading the geometry and drawing one frame. It is paid once per switch, not per frame. The last row repeats the first switch: ${ms(repeatedSwitch.firstFrameMs, 0)} ms the second time against ${ms(firstSwitch.firstFrameMs, 0)} ms the first.`,
    '',
  );
  lines.push('| Switch | New graphics context | Time to first frame / ms | Shader programs in use |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const change of presetSwitches) lines.push(`| ${change.from} to ${change.to} | ${change.newContext ? 'yes' : 'no'} | ${ms(change.firstFrameMs, 0)} | ${change.programs} |`);
  lines.push('');
  lines.push('## Large scenes', '');
  lines.push(
    `Each configuration was measured ${PASSES} times, minutes apart. The row gives the run with the middle frame rate; the next column lists the frame rate of every run in the order measured. Where those differ widely, the difference comes from the state of the machine at that moment and not from the scene, which is the same each time.`,
    '',
  );
  lines.push(`| Atoms | Bonds | Preset | Representation | fps | fps of the ${PASSES} runs | Median frame / ms | 95th pct / ms | Worst / ms | CPU / ms | GPU / ms | Draw calls | Triangles | Pixel ratio | JS heap / MB |`);
  lines.push('| ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const scene of scenes) {
    for (const run of scene.runs) {
      lines.push(`| ${count(scene.atoms)} | ${count(scene.bonds)} | ${run.quality} | ${run.representation} | ${ms(run.fps)} | ${each(run.fpsRuns)} | ${ms(run.medianMs)} | ${ms(run.p95Ms)} | ${ms(run.worstMs)} | ${ms(run.cpuMs, 2)} | ${ms(run.gpuMs, 2)} | ${run.drawCalls} | ${count(run.triangles)} | ${run.pixelRatio.toFixed(2)} | ${ms(run.heapMb, 0)} |`);
    }
  }
  lines.push('', '## Building and editing large scenes', '');
  lines.push('| Atoms | Build scene / ms | First frame / ms | Drag step / ms | Commit a move / ms | Add an atom / ms | Delete an atom / ms | Undo / ms | Auto-save serialisation / ms | Auto-save size / MB |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const scene of scenes) {
    lines.push(`| ${count(scene.atoms)} | ${ms(scene.buildMs, 0)} | ${ms(scene.firstFrameMs, 0)} | ${ms(scene.dragStepMs)} | ${ms(scene.commitMoveMs)} | ${ms(scene.addAtomMs)} | ${ms(scene.deleteAtomMs)} | ${ms(scene.undoMs)} | ${ms(scene.autosaveSerialiseMs, 0)} | ${(scene.autosaveBytes / 1e6).toFixed(1)} |`);
  }
  lines.push('', `Each time runs from the call that changes what is shown to the end of the frame that shows the change, so it includes waiting for and drawing that frame. While an atom is dragged the view follows the pointer without editing the scene ("drag step"); releasing it commits one undoable edit ("commit a move"). "Build scene" is one edit that creates every atom and bond. Every value is the middle one of ${PASSES} passes.`, '');
  lines.push('## Budgets of the specification', '');
  lines.push('| Operation | Goal | Measured |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Interactive rendering, typical scene | 60 fps | caffeine, three runs in each preset: ${typicalPresets.map((preset) => `${preset.quality} ${each(preset.runs.map((run) => run.fps))} fps`).join('; ')} |`);
  lines.push(`| Atom dragging | immediate | ${ms(dragMs)} ms from a drag step to the frame that shows it; ${ms(commitMs)} ms to commit the move on release |`);
  lines.push(`| Atom add or remove | one or two frames | ${ms(addMs)} ms from the edit to the frame that shows it |`);
  lines.push(`| Small-molecule validation | under 100 ms | rule-based check with scene summary ${ms(validationMs, 2)} ms; RDKit cross-check in its worker ${ms(rdkitMs)} ms |`);
  lines.push(`| Cached search | under 100 ms | similarity search over the 16 built-in structures, fingerprints cached: ${ms(searchMs)} ms |`);
  lines.push(`| Reopening a saved scene | under 1 s for modest projects | caffeine ${ms(reopenSmallMs, 0)} ms; 10,000 atoms ${ms(reopenTenThousandMs, 0)} ms |`);
  lines.push(
    `| Simulations never block editing | asynchronous | orbiting during a Hartree–Fock run on caffeine, three runs: ${each(scfRuns.map((run) => run.fps))} fps, worst frame intervals ${each(scfRuns.map((run) => run.worstMs))} ms${stillRunning ? '' : ' (in at least one run the calculation finished before the measurement ended)'} |`,
  );
  lines.push('');
  await writeFile(`${OUT}render-benchmark.md`, `${lines.join('\n')}\n`);

  testInfo.annotations.push({ type: 'benchmark', description: `${scenes.length} scene sizes, ${scenes.reduce((n, s) => n + s.runs.length, 0) * PASSES} runs; renderer ${String(device.renderer)}` });
  // Keep the numbers honest: a result is only worth reporting if the scene really was on screen.
  expect(scenes.every((scene) => scene.runs.every((run) => run.triangles > scene.atoms))).toBe(true);
  expect(round(typical.fps)).toBeGreaterThan(1);
});
