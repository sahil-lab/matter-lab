/**
 * PROVISIONAL STUB — owned by Agent 01 (titration HUD / scientific explanation panel) per
 * `Agent_01_Creative_Direction_and_UI.md` items 5-6, and Agent 07/09 for the save/reopen affordance
 * (persistence). Written only so the full vertical slice (Section 6) is operable and observable
 * end to end with real controls, not a static mock: every number shown is read from `actionSink`
 * (the installed reducer), never computed here. Replace with Agent 01's real HUD; nothing else
 * depends on this file's markup.
 */
import { useEffect, useRef, useState } from 'react';
import { actionSink } from '../actionSink';
import type { ApparatusInstance } from '../contracts';
import { duplicateInstances, removeInstances, setLocked, undo, redo } from '../commands';
import { labEditor, useLabEditor } from '../editorStore';
import { fillContainer, resetExperiment, setValve, startStirrer } from '../operationalActions';
import { buildSavedSession, loadSessionFromLocalStorage, restoreSavedSession, saveSessionToLocalStorage } from '../serialization';
import type { LabReducer } from '../../experiments/labReducer';

const POLL_MS = 150;
const SESSION_KEY = 'default';

export interface HudProps {
  /** The concrete reducer instance, for things no `LabActionSink` method covers yet (pause/resume/export/import). Optional so the HUD still renders sensibly before one is installed. */
  readonly reducer: LabReducer | null;
}

function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function Hud({ reducer }: HudProps): React.JSX.Element {
  useTick(POLL_MS); // forces a re-read of actionSink below every tick; actionSink is not itself a React store
  const selection = useLabEditor((s) => s.selection);
  const scene = useLabEditor((s) => s.scene);
  const selectedId = selection.size === 1 ? [...selection][0]! : null;
  const selectedInstance: ApparatusInstance | undefined = selectedId ? actionSink.getApparatus().find((a) => a.id === selectedId) : undefined;
  const editorInstance = selectedId ? scene.apparatus.get(selectedId) : undefined;

  const initialBuretteVolumeL = useRef<Map<string, number>>(new Map());
  const [phSamples, setPhSamples] = useState<Array<{ deliveredMl: number; pH: number }>>([]);
  const receiverId = [...scene.connections.values()].find((c) => c.kind === 'FLUID' && c.from.instanceId === selectedInstance?.id)?.to.instanceId;

  // Sampling reads `actionSink` (a live mutable reducer, not a React store) on a timer; doing that
  // in an effect, not inline during render, keeps render itself pure.
  useEffect(() => {
    if (!selectedInstance?.capabilities.includes('FLOW_SOURCE')) return;
    const volumeL = actionSink.getContainerStates()[selectedInstance.id]?.volumeL ?? 0;
    const knownMax = initialBuretteVolumeL.current.get(selectedInstance.id) ?? 0;
    if (volumeL > knownMax + 1e-9) {
      // Volume only ever rises on a (re)fill, never on delivery: treat it as a fresh baseline and
      // start a new curve, so a titration repeated after FILL/RESET is not plotted against stale
      // "delivered" numbers from the previous run.
      initialBuretteVolumeL.current.set(selectedInstance.id, volumeL);
      setPhSamples([]);
      return;
    }
    if (!receiverId) return;
    const initial = initialBuretteVolumeL.current.get(selectedInstance.id);
    const current = actionSink.getContainerStates()[selectedInstance.id]?.volumeL;
    // The vertical slice's "plot pH vs delivered mL" (Section 6 step 5): delivered volume is the
    // titrant's own loss, pH is the receiving flask's most recent reading.
    const ph = actionSink.getObservations(receiverId).filter((o) => o.type === 'PH').at(-1);
    if (initial == null || current == null || !ph) return;
    const deliveredMl = (initial - current) * 1000;
    setPhSamples((prev) => {
      const last = prev.at(-1);
      if (last && Math.abs(last.deliveredMl - deliveredMl) <= 1e-6) return prev;
      return [...prev, { deliveredMl, pH: ph.quantity.value }].slice(-500);
    });
  });

  function handleSave(): void {
    const experiment = reducer?.exportScene() ?? null;
    const session = buildSavedSession(scene, labEditor.get().stations, labEditor.get().activeStationId, experiment);
    saveSessionToLocalStorage(SESSION_KEY, session);
  }

  function handleLoad(): void {
    const session = loadSessionFromLocalStorage(SESSION_KEY);
    if (!session) return;
    const restored = restoreSavedSession(session);
    labEditor.set({ scene: restored.scene, stations: [...restored.stations], activeStationId: restored.activeStationId, selection: new Set() });
    if (restored.experiment && reducer) reducer.loadScene(restored.experiment);
  }

  return (
    <aside data-testid="lab-editor-hud" style={{ width: 300, padding: 12, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', color: '#e7edf5', fontSize: 13 }}>
      <section>
        <h3 style={sectionTitleStyle}>Experiment</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => undo()} data-testid="btn-undo">Undo</button>
          <button type="button" onClick={() => redo()} data-testid="btn-redo">Redo</button>
          <button type="button" onClick={() => reducer?.pause()} data-testid="btn-pause">Pause</button>
          <button type="button" onClick={() => reducer?.resume()} data-testid="btn-resume">Resume</button>
          <button
            type="button"
            onClick={() => {
              resetExperiment('all');
              setPhSamples([]);
              initialBuretteVolumeL.current.clear();
            }}
            data-testid="btn-reset"
          >
            Reset
          </button>
          <button type="button" onClick={handleSave} data-testid="btn-save">Save</button>
          <button type="button" onClick={handleLoad} data-testid="btn-load">Reopen</button>
        </div>
      </section>

      {selectedInstance && editorInstance && (
        <section>
          <h3 style={sectionTitleStyle}>{selectedInstance.kind} selected</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => duplicateInstances([selectedInstance.id])} data-testid="btn-duplicate">Duplicate</button>
            <button type="button" onClick={() => removeInstances([selectedInstance.id])} data-testid="btn-delete">Delete</button>
            <button type="button" onClick={() => setLocked([selectedInstance.id], !scene.locked.has(selectedInstance.id))} data-testid="btn-lock">
              {scene.locked.has(selectedInstance.id) ? 'Unlock' : 'Lock'}
            </button>
          </div>

          {selectedInstance.capabilities.includes('CONTAINER') && (
            <FillControl instanceId={selectedInstance.id} />
          )}

          {selectedInstance.capabilities.includes('FLOW_SOURCE') && (
            <label style={rowStyle}>
              Stopcock
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={Number(selectedInstance.config['valveOpenFraction'] ?? 0)}
                onChange={(e) => setValve(selectedInstance.id, Number(e.target.value))}
                data-testid="valve-slider"
              />
              <span>{fmt(Number(selectedInstance.config['valveOpenFraction'] ?? 0), 2)}</span>
            </label>
          )}

          {selectedInstance.capabilities.includes('STIRRING') && (
            <label style={rowStyle}>
              Stir speed
              <input type="range" min={0} max={1} step={0.05} value={Number(selectedInstance.config['speed'] ?? 0)} onChange={(e) => startStirrer(selectedInstance.id, Number(e.target.value))} data-testid="stirrer-slider" />
            </label>
          )}

          {selectedInstance.capabilities.includes('CONTAINER') && (
            <div style={{ marginTop: 6 }}>
              <div>Volume: {fmt((actionSink.getContainerStates()[selectedInstance.id]?.volumeL ?? 0) * 1000, 3)} mL</div>
              {actionSink
                .getObservations(selectedInstance.id)
                .filter((o) => o.type === 'PH')
                .slice(-1)
                .map((o, i) => (
                  <div key={i}>
                    pH: {fmt(o.quantity.value, 3)} <EvidenceBadge evidence={o.evidence} />
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {phSamples.length > 1 && (
        <section>
          <h3 style={sectionTitleStyle}>Titration curve (pH vs. delivered mL)</h3>
          <TitrationPlot samples={phSamples} />
        </section>
      )}

      <section>
        <h3 style={sectionTitleStyle}>Method &amp; limitations</h3>
        <p style={{ opacity: 0.8, lineHeight: 1.4 }}>
          pH is the positive root of the strong-acid/base charge balance with water autoionization
          at 298.15 K (<code>Kw = 1.0×10⁻¹⁴</code>), assuming complete dissociation and instantaneous
          mixing. Only HCl/HNO₃/HBr/HI and NaOH/KOH are recognised; anything else is reported as
          unsupported rather than guessed. Every pH value here is labelled <EvidenceBadge evidence="UNVERIFIED" />{' '}
          because Agent 06's solver has not reviewed this stand-in model.
        </p>
      </section>
    </aside>
  );
}

function FillControl({ instanceId }: { instanceId: string }): React.JSX.Element {
  const [speciesId, setSpeciesId] = useState('HCl');
  const [concentration, setConcentration] = useState(0.1);
  const [volumeMl, setVolumeMl] = useState(25);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
      <select value={speciesId} onChange={(e) => setSpeciesId(e.target.value)} data-testid="fill-species">
        <option value="HCl">HCl</option>
        <option value="HNO3">HNO₃</option>
        <option value="NaOH">NaOH</option>
        <option value="KOH">KOH</option>
      </select>
      <input type="number" step={0.01} value={concentration} onChange={(e) => setConcentration(Number(e.target.value))} style={{ width: 56 }} aria-label="Concentration, mol/L" />
      mol/L ×
      <input type="number" step={0.1} value={volumeMl} onChange={(e) => setVolumeMl(Number(e.target.value))} style={{ width: 56 }} aria-label="Volume, mL" />
      mL
      <button type="button" onClick={() => fillContainer(instanceId, speciesId, concentration, volumeMl / 1000)} data-testid="btn-fill">
        Fill
      </button>
    </div>
  );
}

function EvidenceBadge({ evidence }: { evidence: string }): React.JSX.Element {
  return (
    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#2a3444', letterSpacing: '0.03em' }} data-testid="evidence-badge">
      {evidence}
    </span>
  );
}

function TitrationPlot({ samples }: { samples: Array<{ deliveredMl: number; pH: number }> }): React.JSX.Element {
  const width = 260;
  const height = 120;
  const maxMl = Math.max(...samples.map((s) => s.deliveredMl), 1);
  const points = samples.map((s) => `${(s.deliveredMl / maxMl) * width},${height - (s.pH / 14) * height}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label="pH versus delivered titrant volume" data-testid="titration-plot">
      <polyline points={points} fill="none" stroke="#55e2d1" strokeWidth={2} />
      <line x1={0} y1={height - (7 / 14) * height} x2={width} y2={height - (7 / 14) * height} stroke="#6b7c93" strokeDasharray="3,3" />
    </svg>
  );
}

const sectionTitleStyle: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6, margin: '0 0 6px' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 };
