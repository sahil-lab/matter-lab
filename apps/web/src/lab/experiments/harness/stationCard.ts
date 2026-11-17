/**
 * One station's interactive card: wraps direct calls into `ExperimentEngine` (the actual
 * authoritative runtime — nothing here reimplements reducer/inventory/solver logic) with a small
 * vanilla-DOM UI so the vertical slice can be clicked through and screenshotted without any 3D
 * renderer, which is Agent 02/05's surface, not this one's.
 */
import type { ApparatusKind, Observation } from '@matterlab/contracts';
import {
  buildFillAction,
  buildResetStationAction,
  buildSetValveAction,
  type EngineEvent,
  type ExperimentEngine,
} from '../runtime';
import type { TitrationRigIds } from '../testFixtures';

/** Section 6 step 3: 25.00 mL of 0.100 mol/L HCl and 0.100 mol/L NaOH titrant (educational, virtual reagents). */
const HCL_PRESET = { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' };
const NAOH_PRESET = { volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' };
const RUN_INTERVAL_MS = 260;
const PLOT_WIDTH = 260;
const PLOT_HEIGHT = 120;
const PLOT_MAX_ML = 55;

export interface StationCardDeps {
  readonly getEngine: () => ExperimentEngine;
  readonly rig: TitrationRigIds;
  readonly name: string;
  readonly onDuplicate: () => void;
  readonly onLog: (message: string) => void;
}

export interface StationCardController {
  readonly root: HTMLElement;
  update(): void;
  handleEngineEvent(event: EngineEvent): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatML(volumeL: number): string {
  return `${(volumeL * 1000).toFixed(2)} mL`;
}

export function createStationCard(deps: StationCardDeps): StationCardController {
  const { rig } = deps;
  let running = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let phHistory: { mL: number; pH: number }[] = [];
  let initialBuretteVolumeL = 0;

  const root = el('section', 'station-card');
  const header = el('div', 'station-card__header');
  const nameEl = el('span', 'station-card__name', deps.name);
  const supportBadge = el('span', 'badge');
  header.append(nameEl, supportBadge);

  const setupRow = el('div', 'station-card__row');
  const fillFlaskBtn = el('button', undefined, 'Fill flask: 25.00 mL 0.100 M HCl');
  const fillBuretteBtn = el('button', undefined, 'Fill burette: 50.00 mL 0.100 M NaOH');
  setupRow.append(fillFlaskBtn, fillBuretteBtn);

  const valveRow = el('div', 'station-card__row');
  const valveLabel = el('span', undefined, 'Stopcock');
  const valveInput = document.createElement('input');
  valveInput.type = 'range';
  valveInput.min = '0';
  valveInput.max = '100';
  valveInput.value = '0';
  const valveReadout = el('span', undefined, '0%');
  valveRow.append(valveLabel, valveInput, valveReadout);

  const clockRow = el('div', 'station-card__row');
  const tickBtn = el('button', undefined, 'Tick once');
  const runBtn = el('button', undefined, 'Run');
  const pauseBtn = el('button', undefined, 'Pause');
  const resetBtn = el('button', undefined, 'Reset station');
  const duplicateBtn = el('button', undefined, 'Duplicate station');
  clockRow.append(tickBtn, runBtn, pauseBtn, resetBtn, duplicateBtn);

  const readout = document.createElement('dl');
  readout.className = 'station-card__readout';

  const plotWrap = el('div', 'station-card__plot');
  const plotSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
  plotSvg.setAttribute('viewBox', `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`);
  plotSvg.setAttribute('width', '100%');
  plotSvg.setAttribute('height', '140');
  plotWrap.append(plotSvg);

  root.append(header, setupRow, valveRow, clockRow, readout, plotWrap);

  function engine(): ExperimentEngine {
    return deps.getEngine();
  }

  function stopRunning(): void {
    running = false;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  fillFlaskBtn.addEventListener('click', () => {
    const record = engine().dispatch(buildFillAction(rig.flaskId, HCL_PRESET));
    deps.onLog(`FILL flask -> ${record.outcome}${record.rejectionReason ? `: ${record.rejectionReason}` : ''}`);
    update();
  });

  fillBuretteBtn.addEventListener('click', () => {
    const record = engine().dispatch(buildFillAction(rig.buretteId, NAOH_PRESET));
    deps.onLog(`FILL burette -> ${record.outcome}${record.rejectionReason ? `: ${record.rejectionReason}` : ''}`);
    initialBuretteVolumeL = engine().getScene().containerStates[rig.buretteId]?.volumeL ?? 0;
    update();
  });

  valveInput.addEventListener('input', () => {
    const opening = Number(valveInput.value) / 100;
    valveReadout.textContent = `${valveInput.value}%`;
    engine().dispatch(buildSetValveAction(rig.buretteId, opening));
  });

  tickBtn.addEventListener('click', () => {
    engine().resumeStation(rig.stationId);
    engine().tick(rig.stationId);
    engine().pauseStation(rig.stationId);
    update();
  });

  runBtn.addEventListener('click', () => {
    if (running) return;
    running = true;
    engine().resumeStation(rig.stationId);
    intervalId = setInterval(() => {
      engine().tick(rig.stationId);
      update();
    }, RUN_INTERVAL_MS);
    update();
  });

  pauseBtn.addEventListener('click', () => {
    stopRunning();
    engine().pauseStation(rig.stationId);
    update();
  });

  resetBtn.addEventListener('click', () => {
    stopRunning();
    const record = engine().dispatch(buildResetStationAction(rig.stationId));
    deps.onLog(`RESET station -> ${record.outcome}`);
    phHistory = [];
    initialBuretteVolumeL = 0;
    update();
  });

  duplicateBtn.addEventListener('click', () => {
    deps.onDuplicate();
  });

  function renderPlot(): void {
    while (plotSvg.firstChild) plotSvg.removeChild(plotSvg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const axis = document.createElementNS(ns, 'line');
    axis.setAttribute('x1', '0');
    axis.setAttribute('y1', String(PLOT_HEIGHT - (7 / 14) * PLOT_HEIGHT));
    axis.setAttribute('x2', String(PLOT_WIDTH));
    axis.setAttribute('y2', String(PLOT_HEIGHT - (7 / 14) * PLOT_HEIGHT));
    axis.setAttribute('stroke', 'rgba(135,170,198,0.35)');
    axis.setAttribute('stroke-dasharray', '3,3');
    plotSvg.append(axis);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '4');
    label.setAttribute('y', String(PLOT_HEIGHT - (7 / 14) * PLOT_HEIGHT - 2));
    label.textContent = 'pH 7 (equivalence reference)';
    plotSvg.append(label);

    if (phHistory.length > 0) {
      const points = phHistory
        .map((p) => `${((p.mL / PLOT_MAX_ML) * PLOT_WIDTH).toFixed(1)},${(PLOT_HEIGHT - (p.pH / 14) * PLOT_HEIGHT).toFixed(1)}`)
        .join(' ');
      const polyline = document.createElementNS(ns, 'polyline');
      polyline.setAttribute('points', points);
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', '#55e2d1');
      polyline.setAttribute('stroke-width', '2');
      plotSvg.append(polyline);
    }
  }

  function update(): void {
    const scene = engine().getScene();
    const support = engine().getStationSupport(rig.stationId);
    supportBadge.textContent = support.supported ? 'supported' : `unsupported: ${support.reason ?? ''}`;
    supportBadge.className = `badge ${support.supported ? 'badge--ok' : 'badge--warn'}`;

    const burette = scene.containerStates[rig.buretteId];
    const flask = scene.containerStates[rig.flaskId];
    const clock = engine().getClock(rig.stationId);
    const latestPh = engine().getLatestObservation(rig.flaskId, 'PH');

    readout.replaceChildren(
      el('dt', undefined, 'Clock'),
      el('dd', undefined, clock ? `${clock.status} · t=${clock.simulationS.toFixed(2)} s · tick #${clock.tickIndex}` : 'n/a'),
      el('dt', undefined, 'Burette volume'),
      el('dd', undefined, burette ? formatML(burette.volumeL) : 'n/a'),
      el('dt', undefined, 'Flask volume'),
      el('dd', undefined, flask ? formatML(flask.volumeL) : 'n/a'),
      el('dt', undefined, 'Flask pH (latest observation)'),
      el('dd', undefined, latestPh ? renderPhCell(latestPh) : 'no observation yet'),
    );

    runBtn.dataset.active = String(running);
    plotWrap.title = 'pH vs. delivered volume (mL) — illustrative test-solver output, not Agent 06\'s validated model';
    renderPlot();
  }

  function renderPhCell(observation: Observation): string {
    return `${observation.quantity.value.toFixed(3)} (${observation.evidence})`;
  }

  function handleEngineEvent(event: EngineEvent): void {
    if (event.kind !== 'OBSERVATION_RECORDED' || event.apparatusId !== rig.flaskId) return;
    const burette = engine().getScene().containerStates[rig.buretteId];
    if (initialBuretteVolumeL <= 0 && burette) initialBuretteVolumeL = burette.volumeL;
    const deliveredML = burette ? Math.max(0, (initialBuretteVolumeL - burette.volumeL) * 1000) : 0;
    const ph = event.observations[event.observations.length - 1];
    if (ph && ph.type === 'PH') phHistory.push({ mL: deliveredML, pH: ph.quantity.value });
    update();
  }

  update();

  return {
    root,
    update,
    handleEngineEvent,
    dispose: stopRunning,
  };
}

/** Recovers a rig's instance ids from a reopened/replayed scene by apparatus kind (one of each per station in the vertical slice). */
export function findRigIdsByKind(
  apparatus: readonly { readonly id: string; readonly kind: ApparatusKind; readonly stationId: string }[],
  stationId: string,
): TitrationRigIds {
  const inStation = apparatus.filter((a) => a.stationId === stationId);
  const byKind = (kind: ApparatusKind) => inStation.find((a) => a.kind === kind)?.id ?? '';
  return {
    stationId,
    benchId: byKind('BENCH'),
    standId: byKind('STAND'),
    clampId: byKind('CLAMP'),
    buretteId: byKind('BURETTE'),
    flaskId: byKind('FLASK'),
    stirrerId: byKind('STIRRER'),
    probeId: byKind('PH_PROBE'),
  };
}
