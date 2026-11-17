/**
 * Agent 02's own visual test harness: not part of the production app (Agents 01/04/07 haven't
 * wired a "lab" workspace into `App.tsx` yet), but a real, running scene used to verify and
 * screenshot this module directly. Mounted at `/lab-environment.html`. Apparatus shown here is
 * `dev/DevApparatusStub`, a placeholder — see that file's header comment.
 */
import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import { AgXToneMapping, NoToneMapping } from 'three';
import { detectDevice } from '../../../render/quality';
import type { DeviceInfo } from '../../../render/quality';
import { AdaptiveResolution } from '../AdaptiveResolution';
import { CAMERA_MODE_CONFIG } from '../cameraModes';
import { cameraDirectorApi } from '../cameraDirectorApi';
import { DevTitrationStub } from '../dev/DevApparatusStub';
import * as actions from '../environmentActions';
import { useEnvironment } from '../environmentStore';
import { DirectRender, PerfBegin, PerfEnd, PerfMonitor } from '../FrameInstrumentation';
import type { PerfSnapshot } from '../FrameInstrumentation';
import { LabWorld } from '../LabWorld';
import { introWaypoints } from './introPath';
import { LIGHTING_PRESETS } from '../RoomConfig';
import { recommendSceneQuality, SCENE_QUALITY } from '../SceneQuality';
import type { CameraMode, EnvironmentMode, LightingPresetId, SceneQualityId } from '../types';

const monitor = new PerfMonitor();
let device: DeviceInfo | null = null;

export function getHarnessDeviceInfo(): DeviceInfo | null {
  return device;
}

export function harnessPerfMonitor(): PerfMonitor {
  return monitor;
}

const CAMERA_MODES: readonly CameraMode[] = ['orbit', 'inspect', 'top-down', 'first-person', 'cinematic'];
const QUALITIES: readonly SceneQualityId[] = ['efficient', 'balanced', 'quality'];
const LIGHTING_IDS: readonly LightingPresetId[] = ['daylight-lab', 'night-lab', 'studio-neutral'];

function Scene({ showRig, showApparatus }: { showRig: boolean; showApparatus: boolean }) {
  const qualityId = useEnvironment((s) => s.qualityId);
  const quality = SCENE_QUALITY[qualityId];
  return (
    <>
      <PerfBegin monitor={monitor} />
      <LabWorld forceLightingTestRig={showRig} renderStationContent={showApparatus ? () => <DevTitrationStub /> : undefined} />
      {!quality.postprocessing && <DirectRender />}
      <AdaptiveResolution dprRange={quality.dpr} monitor={monitor} />
      <PerfEnd monitor={monitor} />
    </>
  );
}

function usePerfSnapshot(open: boolean): PerfSnapshot | null {
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setSnapshot(monitor.snapshot()), 400);
    return () => window.clearInterval(id);
  }, [open]);
  return snapshot;
}

function PerfHud() {
  const snapshot = usePerfSnapshot(true);
  if (!snapshot) return null;
  return (
    <div className="lab-harness__perf" data-testid="perf-hud">
      <div>{snapshot.idle ? 'idle' : `${snapshot.fps.toFixed(0)} fps`}</div>
      <div>{snapshot.frameMs.toFixed(1)} ms/frame (p95 {snapshot.frameMsP95.toFixed(1)})</div>
      <div>{snapshot.drawCalls} draws Â· {snapshot.triangles.toLocaleString()} tris</div>
      <div>dpr {snapshot.pixelRatio.toFixed(2)}{snapshot.heapMb ? ` Â· ${snapshot.heapMb.toFixed(0)} MB heap` : ''}</div>
    </div>
  );
}

export function LabEnvironmentHarness() {
  const mode = useEnvironment((s) => s.mode);
  const qualityId = useEnvironment((s) => s.qualityId);
  const lightingPresetId = useEnvironment((s) => s.lightingPresetId);
  const cameraMode = useEnvironment((s) => s.cameraMode);
  const stations = useEnvironment((s) => s.stations);
  const activeStationId = useEnvironment((s) => s.activeStationId);
  const bookmarks = useEnvironment((s) => s.bookmarks);
  const gridVisible = useEnvironment((s) => s.gridVisible);
  const rigVisible = useEnvironment((s) => s.lightingTestRigVisible);
  const reducedMotion = useEnvironment((s) => s.reducedMotion);

  const [showPerf, setShowPerf] = useState(false);
  const [showApparatus, setShowApparatus] = useState(true);
  const [introRunning, setIntroRunning] = useState(false);

  const quality = SCENE_QUALITY[qualityId];
  const toneMapping = quality.postprocessing ? NoToneMapping : AgXToneMapping;

  const playIntro = async () => {
    setIntroRunning(true);
    await cameraDirectorApi.playIntro(introWaypoints());
    actions.markIntroPlayed();
    setIntroRunning(false);
  };

  const [panelVisible, setPanelVisible] = useState(true);

  return (
    <div className="lab-harness" data-testid="lab-harness">
      <Canvas
        frameloop="always"
        dpr={Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, quality.dpr[1])}
        gl={{ antialias: !quality.postprocessing, alpha: false, stencil: false, powerPreference: 'high-performance', toneMapping }}
        onCreated={({ gl }) => {
          device = detectDevice(gl.getContext());
        }}
      >
        <Scene showRig={rigVisible} showApparatus={showApparatus} />
      </Canvas>

      <button
        type="button"
        className="lab-harness__panel-toggle"
        data-testid="toggle-panel"
        onClick={() => setPanelVisible((v) => !v)}
      >
        {panelVisible ? 'hide panel' : 'show panel'}
      </button>

      {panelVisible && (
      <div className="lab-harness__panel" data-testid="harness-panel">
        <section>
          <h2>Environment</h2>
          <div className="lab-harness__row">
            {(['room', 'studio'] as EnvironmentMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} data-testid={`mode-${m}`} onClick={() => actions.setEnvironmentMode(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="lab-harness__row">
            {LIGHTING_IDS.map((id) => (
              <button key={id} type="button" aria-pressed={lightingPresetId === id} data-testid={`lighting-${id}`} onClick={() => actions.setLightingPreset(id)}>
                {LIGHTING_PRESETS[id].label}
              </button>
            ))}
          </div>
          <div className="lab-harness__row">
            {QUALITIES.map((id) => (
              <button key={id} type="button" aria-pressed={qualityId === id} data-testid={`quality-${id}`} onClick={() => actions.setQuality(id)}>
                {id}
              </button>
            ))}
            <button
              type="button"
              data-testid="quality-recommend"
              onClick={() => {
                const info = getHarnessDeviceInfo();
                if (info) actions.setQuality(recommendSceneQuality(info));
              }}
            >
              auto
            </button>
          </div>
          <label className="lab-harness__row">
            <input type="checkbox" checked={gridVisible} data-testid="toggle-grid" onChange={(e) => actions.setGridVisible(e.target.checked)} /> grid
          </label>
          <label className="lab-harness__row">
            <input type="checkbox" checked={showApparatus} data-testid="toggle-apparatus" onChange={(e) => setShowApparatus(e.target.checked)} /> placeholder apparatus
          </label>
          <label className="lab-harness__row">
            <input type="checkbox" checked={rigVisible} data-testid="toggle-rig" onChange={(e) => actions.setLightingTestRigVisible(e.target.checked)} /> reflection test rig
          </label>
          <label className="lab-harness__row">
            <input type="checkbox" checked={reducedMotion} data-testid="toggle-reduced-motion" onChange={(e) => actions.setReducedMotion(e.target.checked)} /> reduced motion
          </label>
        </section>

        <section>
          <h2>Camera</h2>
          <div className="lab-harness__row">
            {CAMERA_MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={cameraMode === m}
                data-testid={`camera-${m}`}
                title={CAMERA_MODE_CONFIG[m].label}
                onClick={() => actions.setCameraMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="lab-harness__row">
            <button type="button" data-testid="focus-active" onClick={() => actions.focusActiveStation(true)}>
              focus active
            </button>
            <button type="button" data-testid="fit-all" onClick={() => actions.fitAllStations(true)}>
              fit all
            </button>
            <button type="button" data-testid="play-intro" disabled={introRunning} onClick={playIntro}>
              {introRunning ? 'playingâ€¦' : 'play intro'}
            </button>
            <button type="button" data-testid="skip-intro" onClick={() => cameraDirectorApi.skipIntro()}>
              skip intro
            </button>
          </div>
          <div className="lab-harness__row">
            <button type="button" data-testid="save-bookmark" onClick={() => actions.saveBookmarkHere(`Bookmark ${bookmarks.length + 1}`)}>
              save bookmark here
            </button>
            {bookmarks.map((b) => (
              <button key={b.id} type="button" data-testid={`bookmark-${b.id}`} onClick={() => actions.goToBookmark(b.id)}>
                {b.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Stations ({stations.length})</h2>
          <div className="lab-harness__row">
            <button type="button" data-testid="add-station" onClick={() => actions.addStation()}>
              add station
            </button>
            <button
              type="button"
              data-testid="remove-station"
              disabled={stations.length <= 1}
              onClick={() => activeStationId && actions.removeStation(activeStationId)}
            >
              remove active
            </button>
          </div>
          <div className="lab-harness__row">
            {stations.map((s) => (
              <button key={s.id} type="button" aria-pressed={activeStationId === s.id} data-testid={`station-${s.id}`} onClick={() => actions.setActiveStation(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label className="lab-harness__row">
            <input type="checkbox" checked={showPerf} data-testid="toggle-perf" onChange={(e) => setShowPerf(e.target.checked)} /> performance HUD
          </label>
        </section>
      </div>
      )}

      {showPerf && <PerfHud />}
    </div>
  );
}
