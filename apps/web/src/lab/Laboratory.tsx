import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import type { ApparatusInstance, RuntimeSnapshot } from '@matterlab/contracts';
import { selectCurrentObservation, selectProbeObservation } from '@matterlab/lab-runtime';
import { getIndicatorDefinitions, getReagentDefinitions, getScienceMethod, getScienceSources, prepareSolution } from '@matterlab/lab-science';
import type { Material } from 'three';
import {
  LabButton, LabComponentGallery, LabDialog, LabEntry, LabSection, LabShell, LabStateNotice,
  ObservationTimeline, ScientificExplanationPanel, TitrationHUD,
} from '../design-system/lab';
import type { LabPanelVisibility } from '../design-system/lab/types';
import type { ScienceClient } from '../services/science-client';
import { saveDownload } from '../services/science-client';
import { notify } from '../state/actions';
import { BackendPanel } from '../ui/backend';
import { ApparatusModel } from './apparatus/ApparatusModel';
import { apparatusRegistry } from './apparatus/registry';
import { LabGuidedTutorial, LabLearningPanel } from './challenges';
import type { LearningActionRequest, LearningHighlight } from './challenges/types';
import { LabEditorInspector, LabEditorPalette, LabEditorScene, LabEditorToolbar, useLabEditorState } from './editor';
import type { EditorSaveTicket } from './editor/types';
import {
  LabCanvas, LabWorld, LabViewportControls, createWorkbenchSurface, transformBounds, useCameraSnapshot,
} from './environment';
import type { LabFrameMetrics, LabRendererPreference, LabStation, LabWorldMode, SceneQualityPreset } from './environment';
import { useLabRuntimeSnapshot } from './experiments';
import { FluidTransferLayer, VesselFluidSlot, createGlassMaterial } from './fluids';
import type { FluidVisualSettings } from './fluids';
import { LabApiClient, LabPersistencePanel } from './persistence';
import type { SceneDraft, SceneResource } from './persistence';
import {
  PREPARATION, REFERENCE_TITRATION, createLaboratoryDraft, createLaboratorySession, readLastLaboratoryDraft,
  stationRoles, storeLaboratoryDraft,
} from './session';
import type { LaboratorySession } from './session';
import './laboratory.css';

declare global {
  interface Window {
    __MATTERLAB_LAB__?: {
      session: LaboratorySession;
      snapshot(): RuntimeSnapshot;
      metrics(): LabFrameMetrics | null;
    };
  }
}

const jsonDownload = (name: string, value: unknown) =>
  saveDownload({ filename: name, blob: new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }) });
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const references = getScienceSources();
const method = getScienceMethod();
const noProgress = () => null;
const noSubscription = () => () => {};

function sceneStations(snapshot: RuntimeSnapshot): LabStation[] {
  return snapshot.scene.stations.map((station) => {
    const bounds = snapshot.scene.apparatus.filter((instance) => instance.stationId === station.id).map((instance) => {
      const definition = apparatusRegistry.getDefinition(instance.definitionId);
      if (!definition) throw new Error(`No registered apparatus definition for ${instance.definitionId}.`);
      return transformBounds({ minM: definition.boundsM.min, maxM: definition.boundsM.max }, instance.transform);
    });
    return {
      id: station.id, label: station.name,
      boundsM: {
        minM: bounds.length ? [Math.min(...bounds.map((box) => box.minM[0])), 0, Math.min(...bounds.map((box) => box.minM[2]))] : [-1.2, 0, -0.525],
        maxM: bounds.length ? [Math.max(...bounds.map((box) => box.maxM[0])), Math.max(1.2, ...bounds.map((box) => box.maxM[1])), Math.max(...bounds.map((box) => box.maxM[2]))] : [1.2, 1.2, 0.525],
      },
    };
  });
}

function EquipmentScene({ session, snapshot, quality, reducedMotion, stationId }: {
  session: LaboratorySession; snapshot: RuntimeSnapshot; quality: SceneQualityPreset; reducedMotion: boolean; stationId?: string;
}) {
  const [glass, setGlass] = useState<Material | null>(null);
  const settings = useMemo<FluidVisualSettings>(() => ({ quality, reducedMotion, lowPower: quality === 'low' }), [quality, reducedMotion]);
  useLayoutEffect(() => {
    const material = createGlassMaterial(settings);
    setGlass(material);
    return () => { material.dispose(); setGlass(null); };
  }, [settings]);
  const renderApparatus = useCallback((instance: ApparatusInstance) => (
    <ApparatusModel instance={instance} quality={quality} glassMaterial={glass ?? undefined} state={snapshot.apparatusStates[instance.id]}>
      <VesselFluidSlot
        instance={instance} snapshot={snapshot} definition={apparatusRegistry.getDefinition(instance.definitionId)!} settings={settings}
        indicatorId={typeof instance.config.indicatorId === 'string' && instance.config.indicatorId !== 'none' ? instance.config.indicatorId : undefined}
      />
    </ApparatusModel>
  ), [quality, glass, snapshot, settings]);
  return <>
    <LabEditorScene editor={session.editor} renderApparatus={renderApparatus} stationId={stationId} />
    <FluidTransferLayer snapshot={snapshot} definitions={apparatusRegistry} presentation={session.presentation} settings={settings} stationId={stationId} />
  </>;
}

function PreparationControls({ session, instance, report }: { session: LaboratorySession; instance: ApparatusInstance; report: (error: unknown) => void }) {
  const [reagentId, setReagentId] = useState(instance.kind === 'BURETTE' ? 'naoh' : 'hcl');
  const [volumeMl, setVolumeMl] = useState(instance.kind === 'BURETTE' ? '50' : '25');
  const [concentration, setConcentration] = useState('0.1');
  const definition = apparatusRegistry.getDefinition(instance.definitionId)!;
  if (!instance.capabilities.includes('CONTAINER')) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const prepared = prepareSolution({ ...PREPARATION, reagentId, volumeL: Number(volumeMl) / 1000, concentrationMolL: Number(concentration) });
    if (prepared.status !== 'SUCCEEDED') { report(prepared.error.detail); return; }
    if (!await session.editor.fill(instance.id, prepared.contents, reagentId)) report(session.editor.getSnapshot().feedback.message);
  }
  return <div className="lab-preparation" data-control-id="prepare">
    <form onSubmit={(event) => void submit(event).catch(report)}>
      <label>Virtual reagent<select aria-label="Virtual reagent" value={reagentId} onChange={(event) => setReagentId(event.target.value)}>
        {getReagentDefinitions().map((reagent) => <option key={reagent.id} value={reagent.id}>{reagent.label}</option>)}
      </select></label>
      <label>Initial volume / mL<input aria-label="Initial volume in milliliters" type="number" min="0.001" max={(definition.capacityL ?? 0) * 1000} step="any" required value={volumeMl} onChange={(event) => setVolumeMl(event.target.value)} /></label>
      <label>Concentration / mol L⁻¹<input aria-label="Initial molar concentration" type="number" min="0" max="0.1" step="any" required value={concentration} onChange={(event) => setConcentration(event.target.value)} /></label>
      <button type="submit" data-testid="lab-fill">Prepare in selected vessel</button>
      <small>298.15 K · well mixed · preparation is logged; not a physical laboratory protocol.</small>
    </form>
    <label>Trace indicator<select aria-label="Trace indicator" value={String(instance.config.indicatorId ?? 'none')}
      onChange={(event) => void session.configureIndicator(instance.id, event.target.value).catch(report)}>
      <option value="none">None</option>
      {getIndicatorDefinitions().map((indicator) => <option key={indicator.id} value={indicator.id}>{indicator.label}</option>)}
    </select></label>
  </div>;
}

function ActiveLaboratory({ session, initial, onExit, replace }: {
  session: LaboratorySession; initial: SceneDraft; onExit?: () => void; replace: (draft: SceneDraft, revision?: number | null) => Promise<void>;
}) {
  const snapshot = useLabRuntimeSnapshot(session.runtime.reader);
  const editing = useLabEditorState(session.editor);
  const cameraState = useCameraSnapshot(session.camera);
  const stationId = editing.activeStationId;
  const station = snapshot.stationStates[stationId]!;
  const roles = stationRoles(snapshot, stationId);
  const challenge = session.challenges.get(stationId);
  const progress = useSyncExternalStore(challenge?.subscribe ?? noSubscription, challenge?.getSnapshot ?? noProgress);
  const referencePrepared = ['aliquot', 'titrant'].every((id) => progress?.evaluation.goals.some((goal) => goal.id === id && goal.state === 'complete'));
  const selected = snapshot.scene.apparatus.find((instance) => instance.id === editing.selectedIds[0]);
  const receiver = selected?.capabilities.includes('CONTAINER') ? selected : roles.receiver;
  const scope = { runId: snapshot.runId, stationId, epoch: station.epoch, apparatusId: roles.receiver?.id };
  const ph = roles.receiver && selectCurrentObservation(snapshot, roles.receiver.id, 'PH');
  const remaining = roles.burette && selectCurrentObservation(snapshot, roles.burette.id, 'VOLUME');
  const indicator = roles.receiver && selectCurrentObservation(snapshot, roles.receiver.id, 'INDICATOR');
  const probe = roles.probe && selectProbeObservation(snapshot, roles.probe.id);
  const transferred = snapshot.transferTotals.find((total) => total.sourceInstanceId === roles.burette?.id && total.receiverInstanceId === roles.receiver?.id)?.deliveredVolumeL ?? 0;
  const support = session.getSupport(stationId);
  const [title, setTitle] = useState(initial.title);
  const [quality, setQuality] = useState<SceneQualityPreset>('balanced');
  const [worldMode, setWorldMode] = useState<LabWorldMode>('room');
  const [renderer, setRenderer] = useState<LabRendererPreference>('auto');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [panels, setPanels] = useState<LabPanelVisibility>({ library: true, inspector: false, timeline: true });
  const [tab, setTab] = useState<'apparatus' | 'science' | 'learning'>('apparatus');
  const [issue, setIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState('Local experiment. Nothing has been saved to a server.');
  const [busy, setBusy] = useState(false);
  const [notebook, setNotebook] = useState<SceneDraft | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [service, setService] = useState<ScienceClient | null>(null);
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(initial.scene.revision > 0 ? initial.scene.revision : null);
  const [newSetup, setNewSetup] = useState<'assembled' | 'empty' | null>(null);
  const [doseMl, setDoseMl] = useState('0.05');
  const metrics = useRef<LabFrameMetrics | null>(null);
  const saveTicket = useRef<EditorSaveTicket | null>(null);
  const saving = useRef(false);
  const latestTitle = useRef(title);
  latestTitle.current = title;
  const lastSavedRevision = useRef(-1);
  const report = useCallback((error: unknown) => setIssue(describeError(error)), []);
  const api = useMemo(() => service ? new LabApiClient(service) : null, [service]);
  const stations = useMemo(() => sceneStations(snapshot), [snapshot.scene.apparatus, snapshot.scene.stations]);
  const surfaces = useMemo(() => snapshot.scene.apparatus.filter((instance) => instance.kind === 'BENCH')
    .map((instance) => createWorkbenchSurface({ id: instance.id, stationId: instance.stationId, transform: instance.transform })), [snapshot.scene.apparatus]);

  const saveLocal = useCallback(async () => {
    const draft = await session.snapshotDraft(latestTitle.current);
    storeLaboratoryDraft(draft, confirmedRevision);
    lastSavedRevision.current = draft.runtimeCheckpoint!.snapshot.revision;
    return draft;
  }, [session, confirmedRevision]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (saving.current || session.editor.getSnapshot().busy || session.runtime.reader.getSnapshot().revision === lastSavedRevision.current) return;
      saving.current = true;
      void saveLocal().then(() => setNotice('Draft saved on this device; remote save is unconfirmed.'))
        .catch(report).finally(() => { saving.current = false; });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [session, saveLocal, report]);
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1')) return;
    window.__MATTERLAB_LAB__ = { session, snapshot: session.runtime.reader.getSnapshot, metrics: () => metrics.current };
    return () => { if (window.__MATTERLAB_LAB__?.session === session) delete window.__MATTERLAB_LAB__; };
  }, [session]);

  async function perform(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setIssue(null);
    try { await operation(); } catch (error) { report(error); } finally { setBusy(false); }
  }
  async function openNotebook() {
    await session.pauseAll();
    saveTicket.current = session.editor.prepareSave();
    setNotebook(await saveLocal());
  }
  async function openReplacement(draft: SceneDraft, revision: number | null = null) {
    await saveLocal();
    await replace(draft, revision);
  }
  const focusControls = (request: LearningActionRequest) => {
    if (request.kind === 'reset') { void perform(() => session.editor.resetStation()); return; }
    if (request.instanceIds.length) session.editor.select(request.instanceIds);
    if (request.kind === 'place') session.editor.setMode('place');
    if (request.kind === 'connect') session.editor.setMode('connect');
    if (request.kind === 'operate') session.editor.setMode('operate');
    setTab('apparatus'); setPanels((value) => ({ ...value, inspector: true }));
  };
  const highlight = ({ instanceIds, focus }: LearningHighlight) => {
    session.editor.setTutorialHighlight(instanceIds);
    if (focus && instanceIds.length) { session.editor.select(instanceIds); session.editor.focusSelection(); }
  };
  const currentScience = receiver ? snapshot.observations.filter((record) => record.runId === snapshot.runId && record.stationId === stationId &&
    record.epoch === station.epoch && record.observation.apparatusId === receiver.id &&
    record.sequence === selectCurrentObservation(snapshot, receiver.id, 'PH')?.sequence).map((record) => record.observation) : [];
  const scientificStatus = station.status === 'FAILED' ? 'error' : station.status === 'UNSUPPORTED' ? 'unsupported' : ph ? 'ready' : 'empty';
  const actions = <>
    <LabButton size="sm" variant={station.status === 'RUNNING' ? 'outline' : 'primary'} disabled={busy || editing.busy || support.status !== 'SUPPORTED'}
      onClick={() => void perform(async () => {
        const ok = await session.editor.controlStation(station.status === 'RUNNING' ? 'PAUSE' : 'RESUME');
        if (!ok) throw new Error(session.editor.getSnapshot().feedback.message);
      })} data-testid="lab-play">{station.status === 'RUNNING' ? 'Pause' : 'Run'}</LabButton>
    <LabButton size="sm" disabled={busy} onClick={() => void perform(openNotebook)} data-testid="lab-notebook">Save / notebook</LabButton>
    <LabButton size="sm" onClick={() => setConnectionOpen(true)}>Connect science</LabButton>
    <LabButton size="sm" onClick={() => setNewSetup('empty')}>New empty lab</LabButton>
    <LabButton size="sm" onClick={() => setNewSetup('assembled')}>Titration setup</LabButton>
  </>;
  return <div className="instrument-laboratory" data-testid="instrument-laboratory">
    <LabShell
      title={title} stationLabel={snapshot.scene.stations.find((item) => item.id === stationId)?.name}
      onExit={() => void perform(async () => { await session.pauseAll(); await saveLocal(); onExit?.(); })}
      panels={panels} onPanelsChange={setPanels} quality={quality} onQualityChange={setQuality}
      viewMode={cameraState.view.mode} onViewModeChange={(mode) => session.camera.setMode(mode)} onReducedMotionChange={setReducedMotion}
      interaction={{ mode: editing.pointerCaptured ? 'dragging' : editing.mode === 'place' ? 'placing' : editing.mode === 'connect' ? 'connecting' : 'idle',
        pointerCaptured: editing.pointerCaptured, detail: editing.feedback.message }}
      toolbar={<div className="laboratory-toolbar">{actions}</div>}
      status={<span role="status">{busy ? 'Working...' : notice}</span>}
      gallery={<LabComponentGallery />}
      onRequestTutorial={() => challenge?.dismissGuide(false)}
      entry={<LabEntry onEnter={(choice) => session.setMode(choice === 'guided' ? 'guided' : 'free')} />}
      viewport={<LabCanvas cameraController={session.camera} quality={quality} reducedMotion={reducedMotion} rendererPreference={renderer}
        onMetrics={(value) => { metrics.current = value; }} cinematicEntry={false}>
        <LabWorld mode={worldMode} roomPreset="gallery" stations={stations} activeStationId={stationId} isolateStation={false}
          placementSurfaces={surfaces} showGrid={editing.mode === 'place' || cameraState.view.mode === 'top-down'}>
          <EquipmentScene session={session} snapshot={snapshot} quality={quality} reducedMotion={reducedMotion} stationId={isolate ? stationId : undefined} />
        </LabWorld>
      </LabCanvas>}
      library={<>
        <LabSection title="Station">
          <select aria-label="Active laboratory station" value={stationId} onChange={(event) => session.editor.setActiveStation(event.target.value)}>
            {snapshot.scene.stations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div className="laboratory-quick">
            <LabButton size="sm" disabled={busy} onClick={() => void perform(() => session.prepareReference(stationId))} data-testid="lab-prepare-reference">Prepare reference solutions</LabButton>
            <LabButton size="sm" disabled={busy} onClick={() => void perform(() => session.immerseProbe(stationId))} data-testid="lab-immerse-probe">Immerse &amp; connect probe</LabButton>
            <LabButton size="sm" onClick={() => { if (roles.burette) session.editor.select([roles.burette.id]); setPanels((value) => ({ ...value, inspector: true })); }}>Burette controls</LabButton>
          </div>
          <p className="mlab-caption">Virtual HCl/NaOH, 0.100 mol/L at 298.15 K. Reference preparation is logged as real FILL actions.</p>
          {roles.burette && <label className="laboratory-field">Stopcock opening
            <input type="range" aria-label="Burette stopcock opening" min="0" max="1" step="0.01"
              value={snapshot.apparatusStates[roles.burette.id]?.valveOpeningFraction ?? 0} disabled={busy || editing.busy}
              onChange={(event) => void session.editor.setValve(roles.burette!.id, Number(event.target.value))} data-testid="lab-valve" />
          </label>}
          <div className="laboratory-metrics" aria-label="Authoritative instrument readings">
            <span>Delivered <output data-testid="lab-delivered-ml">{(transferred * 1000).toFixed(3)}</output> mL</span>
            <span>pH <output data-testid="lab-current-ph">{ph?.observation.quantity.value.toFixed(4) ?? 'Unavailable'}</output></span>
            <span>Probe <output data-testid="lab-probe-ph">{probe?.observation.quantity.value.toFixed(4) ?? 'Not immersed'}</output></span>
          </div>
          <label className="laboratory-field">Metered dose / mL<input aria-label="Metered dose in milliliters" type="number" min="0.001" step="any"
            value={doseMl} onChange={(event) => setDoseMl(event.target.value)} /></label>
          <div className="laboratory-quick">
            <LabButton size="sm" disabled={!roles.burette || busy} onClick={() => roles.burette && void session.editor.setValve(roles.burette.id, 0)}>Close stopcock</LabButton>
            <LabButton size="sm" disabled={!roles.burette || !roles.receiver || busy || editing.busy || station.status !== 'RUNNING' || !doseMl.trim() || !Number.isFinite(Number(doseMl)) || Number(doseMl) <= 0} data-testid="lab-dose-drop" onClick={() => void perform(async () => {
              const edge = snapshot.scene.connections.find((connection) => connection.kind === 'FLUID' && connection.enabled &&
                connection.from.instanceId === roles.burette?.id && connection.to.instanceId === roles.receiver?.id);
              if (!edge || !roles.burette || !roles.receiver) throw new Error('Connect the burette to a receiving flask.');
              if (!await session.editor.transfer(roles.burette.id, roles.receiver.id, Number(doseMl) / 1000, edge.id)) throw new Error(session.editor.getSnapshot().feedback.message);
            })}>Meter dose</LabButton>
          </div>
          <p className="mlab-caption">Run the station to meter liquid. For manual increments, leave the stopcock closed. Pause stops every transfer.</p>
          {support.status === 'UNSUPPORTED' && <p className="mlab-caption" role="status">{support.reasons.join(' ')}</p>}
          {issue && <LabStateNotice status="error" compact action={{ label: 'Dismiss', onPress: () => setIssue(null) }}>{issue}</LabStateNotice>}
        </LabSection>
        <details className="laboratory-view-options"><summary>World &amp; camera</summary>
          <label>Environment<select aria-label="Laboratory environment" value={worldMode} onChange={(event) => setWorldMode(event.target.value as LabWorldMode)}><option value="room">Laboratory room</option><option value="studio">Studio</option></select></label>
          <label>Rendering backend<select aria-label="Laboratory rendering backend" value={renderer} onChange={(event) => setRenderer(event.target.value as LabRendererPreference)}>
            <option value="auto">Automatic</option><option value="webgl2">WebGL 2</option><option value="webgpu">WebGPU (experimental)</option>
          </select></label>
          <label><input type="checkbox" checked={isolate} onChange={(event) => setIsolate(event.target.checked)} />Show only active station</label>
          <LabViewportControls controller={session.camera} />
        </details>
        <LabEditorPalette editor={session.editor} />
      </>}
      inspector={<>
        <div className="laboratory-tabs" role="group" aria-label="Laboratory inspector tab">
          {(['apparatus', 'science', 'learning'] as const).map((choice) => <LabButton key={choice} size="sm" active={tab === choice} onClick={() => setTab(choice)}>{choice}</LabButton>)}
        </div>
        {tab === 'apparatus' && <LabEditorInspector editor={session.editor} preparationControls={selected && <PreparationControls key={selected.id} session={session} instance={selected} report={report} />} />}
        {tab === 'science' && <ScientificExplanationPanel run={null} observations={currentScience}
          provenance={{ methodId: method.id, methodVersion: method.version, assumptions: method.assumptions, limitations: method.limitations, sourceIds: references.map((ref) => ref.id), warnings: [], diagnostics: {} }}
          methodLabel="Ideal aqueous acid-base equilibrium" references={references}
          summary="These are current, recorded solver observations. A captured notebook or independently replayed server run supplies the frozen experiment record."
          conditions={[{ label: 'Temperature', value: '298.15', unit: 'K' }, { label: 'Volume and moles', value: 'Conserved by accepted runtime transfers' }]}
          equations={[{ label: 'Electroneutrality and mass balance', expression: '[H3O+] + [Na+] + [NH4+] = [OH-] + [Cl-] + [acetate-]\n[H3O+] [OH-] = Kw\npH = -log10([H3O+] / (1 mol/L))',
            explanation: 'Only the selected single weak family is included. The root is solved numerically; this is not a predetermined curve.' }]}
        />}
        {tab === 'learning' && challenge && <LabLearningPanel controller={challenge} onHighlight={highlight} onActionRequest={focusControls}
          onExportNotebook={(document) => jsonDownload('matterlab-trial-notebook.json', document)}
          onExportTemplate={(assembly) => jsonDownload('matterlab-assembly.json', assembly)} />}
      </>}
      tutorial={challenge && <LabGuidedTutorial controller={challenge} onHighlight={highlight} onActionRequest={focusControls} />}
      hud={<TitrationHUD scope={scope} ph={ph} remaining={remaining} sourceInstanceId={roles.burette?.id} indicator={indicator}
        status={scientificStatus} statusMessage={station.error?.detail}
        equivalence={REFERENCE_TITRATION.status === 'SUCCEEDED' && referencePrepared ? { state: Math.abs(transferred - REFERENCE_TITRATION.equivalenceVolume.value) < 1e-9 ? 'reached' : 'pending',
          evidence: 'MODEL_CALCULATED', detail: 'Reference target for the recorded 25.00 mL / 0.100 mol/L HCl and NaOH preparations.' } : { state: 'unknown', detail: 'No preparation-matched reference is established for this trial.' }}
        onExplain={() => { setTab('science'); setPanels((value) => ({ ...value, inspector: true })); }} />}
      timeline={<div className="laboratory-timeline">
        <LabEditorToolbar editor={session.editor} />
        <ObservationTimeline records={snapshot.observations} scope={scope} status={scientificStatus === 'empty' ? 'ready' : scientificStatus} />
      </div>}
    />
    <div className="ml-lab" style={{ display: 'contents' }}>
      <LabDialog open={connectionOpen} title="Connected science" size="large" onClose={() => setConnectionOpen(false)}>
        <BackendPanel onClientChange={setService} />
      </LabDialog>
      <LabDialog open={notebook !== null} title="Laboratory notebook" size="large" onClose={() => setNotebook(null)}>
        {notebook && <>
          <label className="laboratory-field">Notebook title<input value={title} onChange={(event) => { setTitle(event.target.value); setNotebook({ ...notebook, title: event.target.value }); }} /></label>
          <LabPersistencePanel api={api} draft={notebook} confirmedRevision={confirmedRevision}
            onOpen={(resource: SceneResource) => { setNotebook(null); void perform(() => openReplacement(resource, resource.scene.revision)); }}
            onImportDraft={(draft) => { setNotebook(null); void perform(() => openReplacement(draft)); }}
            onSaved={(resource) => {
              setConfirmedRevision(resource.scene.revision);
              if (saveTicket.current) session.editor.acknowledgeSave(saveTicket.current, resource.scene.revision);
              setNotice(`PostgreSQL confirmed revision ${resource.scene.revision}.`);
            }} />
        </>}
      </LabDialog>
      <LabDialog open={newSetup !== null} title="Start another laboratory?" onClose={() => setNewSetup(null)}>
        <p>The current run will be saved as a local draft first. The new laboratory has its own scene and run IDs; it does not erase the previous run.</p>
        <LabButton onClick={() => void perform(async () => {
          await session.pauseAll(); await openReplacement(createLaboratoryDraft(newSetup === 'empty')); setNewSetup(null);
        })} data-testid="lab-confirm-new">Save draft and start</LabButton>
      </LabDialog>
    </div>
  </div>;
}

export function Laboratory({ onExit }: { readonly onExit?: () => void }) {
  const [request, setRequest] = useState<{ draft: SceneDraft | null; key: number }>({ draft: null, key: 0 });
  const [ready, setReady] = useState<{ session: LaboratorySession; draft: SceneDraft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const replace = useCallback(async (draft: SceneDraft, revision: number | null = null) => {
    storeLaboratoryDraft(draft, revision);
    setRequest((previous) => ({ draft, key: previous.key + 1 }));
  }, []);
  useEffect(() => {
    let closed = false;
    let session: LaboratorySession | undefined;
    setReady(null); setProblem(null);
    void (async () => {
      const draft = request.draft ?? readLastLaboratoryDraft() ?? createLaboratoryDraft();
      session = await createLaboratorySession(draft, (message) => { if (!closed) setProblem(message); }, replace);
      if (closed) { await session.stopAndClose(); return; }
      setReady({ session, draft });
    })().catch((error) => { if (!closed) setProblem(describeError(error)); });
    return () => {
      closed = true;
      if (session) void session.stopAndClose().catch((error) => notify('error', 'Laboratory cleanup failed', describeError(error)));
    };
  }, [request, replace]);
  if (!ready) return <div className="ml-lab laboratory-loading">
    <LabStateNotice status={problem ? 'error' : 'loading'} title={problem ? 'The laboratory could not open' : 'Opening the laboratory'}
      action={onExit ? { label: 'Return to molecules', onPress: onExit } : undefined}>
      {problem ?? 'Starting the authoritative scientific worker. No simulated values are generated by the graphics.'}
    </LabStateNotice>
    {problem && <LabButton onClick={() => setRequest((previous) => ({ draft: createLaboratoryDraft(), key: previous.key + 1 }))}>Open a fresh laboratory without deleting the saved draft</LabButton>}
  </div>;
  return <>
    <ActiveLaboratory key={request.key} session={ready.session} initial={ready.draft} replace={replace} onExit={onExit} />
    {problem && <div className="ml-lab laboratory-runtime-error" role="alert"><LabStateNotice status="error" action={{ label: 'Dismiss', onPress: () => setProblem(null) }}>{problem}</LabStateNotice></div>}
  </>;
}
