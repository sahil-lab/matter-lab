/**
 * Orchestrates the harness: one shared `ExperimentEngine`, a station card per station, a global
 * event log, and Save/Reopen/Replay-check demonstrating the snapshot and replay machinery in
 * `runtime/snapshot.ts`. Every control here calls the real `ExperimentEngine` API — there is no
 * separate "demo" state machine to keep in sync with the real one.
 */
import type { UUID } from '@matterlab/contracts';
import { createDefaultPlugins } from '../plugins';
import { createDefinitionRegistry, VERTICAL_SLICE_DEFINITIONS } from '../registry';
import { ExperimentEngine, type EngineSnapshot, type ExperimentEngineDeps } from '../runtime';
import { assembleTitrationStation, buildEmptyExperimentScene, createFakeStrongAcidStrongBaseSolverClient } from '../testFixtures';
import { createStationCard, findRigIdsByKind, type StationCardController } from './stationCard';
import './harness.css';

const SNAPSHOT_STORAGE_KEY = 'matterlab.lab.experiments-harness.snapshot.v1';
const MAX_LOG_LINES = 300;

function createDeps(): ExperimentEngineDeps {
  return {
    registry: createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS),
    solver: createFakeStrongAcidStrongBaseSolverClient(),
    plugins: createDefaultPlugins(),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountHarness(root: HTMLElement): void {
  let engine = new ExperimentEngine(buildEmptyExperimentScene(1), createDeps());
  let unsubscribe: (() => void) | null = null;
  const cards = new Map<UUID, StationCardController>();
  const logLines: string[] = [];

  root.replaceChildren();
  const container = el('div', 'harness');
  const title = el('h1', 'harness__title', 'MATTER LAB — Experiment Graph & Simulation Runtime');
  const subtitle = el(
    'p',
    'harness__subtitle',
    'A non-3D harness driving Agent 07\u2019s ExperimentEngine directly: PLACE/ATTACH/FILL/SET_VALVE/TRANSFER, the fixed-tick simulation clock, pause/resume/reset, save/reopen/replay, and two independent stations.',
  );
  const banner = el('div', 'harness__banner');
  banner.innerHTML =
    'The pH shown here comes from <strong>testFixtures/fakeSolverClient.ts</strong>, a closed-form strong-acid/strong-base ' +
    'charge-balance calculation (with water autoionization, Kw = 1.0\u00d710\u207b\u00b9\u2074 at 298.15 K) used only to exercise this ' +
    'reducer-to-solver integration seam. It is <strong>not</strong> Agent 06\u2019s validated solver, which is a sibling branch not ' +
    'available here \u2014 every observation is tagged evidence <strong>UNVERIFIED</strong> for exactly that reason.';

  const toolbar = el('div', 'harness__toolbar');
  const saveBtn = el('button', undefined, 'Save scene');
  const reopenBtn = el('button', undefined, 'Reopen saved scene');
  const replayBtn = el('button', undefined, 'Check replay determinism');
  const replayStatus = el('span', 'replay-check', '');
  toolbar.append(saveBtn, reopenBtn, replayBtn, replayStatus);

  const stationsEl = el('div', 'harness__stations');
  const logTitle = el('h2', 'harness__title', 'Event log');
  logTitle.style.fontSize = '15px';
  const logPanel = el('div', 'log-panel');

  container.append(title, subtitle, banner, toolbar, stationsEl, logTitle, logPanel);
  root.append(container);

  function log(message: string): void {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    logPanel.textContent = logLines.join('\n');
    logPanel.scrollTop = logPanel.scrollHeight;
  }

  function stationIdsInOrder(): UUID[] {
    return engine.getScene().stations.map((s) => s.id);
  }

  function addStationCard(stationId: UUID): void {
    const scene = engine.getScene();
    const station = scene.stations.find((s) => s.id === stationId);
    const rig = findRigIdsByKind(scene.apparatus, stationId);
    const card = createStationCard({
      getEngine: () => engine,
      rig,
      name: station?.name ?? stationId,
      onLog: log,
      onDuplicate: () => {
        const newStationId = engine.duplicateStation(stationId);
        log(`Duplicated ${station?.name ?? stationId} -> new station ${newStationId}.`);
        addStationCard(newStationId);
      },
    });
    cards.set(stationId, card);
    stationsEl.append(card.root);
  }

  function rebuildStationsFromScene(): void {
    for (const card of cards.values()) card.dispose();
    cards.clear();
    stationsEl.replaceChildren();
    for (const stationId of stationIdsInOrder()) addStationCard(stationId);
  }

  function attachEngine(nextEngine: ExperimentEngine): void {
    unsubscribe?.();
    engine = nextEngine;
    unsubscribe = engine.subscribe((event) => {
      if (event.kind === 'ACTION_RECORDED') {
        const r = event.record;
        log(`${r.action.type} (${r.action.actionId.slice(0, 12)}) -> ${r.outcome}${r.rejectionReason ? `: ${r.rejectionReason}` : ''}`);
      }
      for (const card of cards.values()) card.handleEngineEvent(event);
      for (const card of cards.values()) card.update();
    });
    rebuildStationsFromScene();
  }

  saveBtn.addEventListener('click', () => {
    const snapshot = engine.createSnapshot();
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
    log(`Saved a snapshot (${snapshot.events.length} logged actions, ${snapshot.observations.length} observations) to localStorage.`);
  });

  reopenBtn.addEventListener('click', () => {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      log('Reopen: no saved snapshot found in localStorage yet — click "Save scene" first.');
      return;
    }
    const snapshot = JSON.parse(raw) as EngineSnapshot;
    void ExperimentEngine.replay(snapshot, createDeps()).then((reopened) => {
      attachEngine(reopened);
      log('Reopened the saved snapshot: connection graph and contents restored.');
    });
  });

  replayBtn.addEventListener('click', () => {
    const snapshot = engine.createSnapshot();
    void ExperimentEngine.replay(snapshot, createDeps()).then((replayed) => {
      const mismatches: string[] = [];
      for (const stationId of stationIdsInOrder()) {
        const rig = findRigIdsByKind(engine.getScene().apparatus, stationId);
        const original = engine.getLatestObservation(rig.flaskId, 'PH');
        const check = replayed.getLatestObservation(rig.flaskId, 'PH');
        if ((original?.quantity.value ?? null) !== (check?.quantity.value ?? null)) mismatches.push(stationId);
      }
      const ok = mismatches.length === 0;
      replayStatus.textContent = ok
        ? `\u2713 replay reproduced identical pH observations for all ${stationIdsInOrder().length} station(s).`
        : `\u2717 replay mismatch for ${mismatches.length} station(s).`;
      replayStatus.className = `replay-check ${ok ? 'replay-check--match' : 'replay-check--mismatch'}`;
      log(`Replay check: ${ok ? 'identical' : 'MISMATCH'} (${replayed.getEventLog().length} actions replayed).`);
    });
  });

  attachEngine(engine);
  const stationA = assembleTitrationStation(engine, 'Station A');
  addStationCard(stationA.stationId);
  const stationB = assembleTitrationStation(engine, 'Station B');
  addStationCard(stationB.stationId);
  log('Assembled two independent titration stations (bench, stand, clamp, burette, flask, stirrer, pH probe).');
}
