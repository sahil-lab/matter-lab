/**
 * Standalone regression/dev harness for `lab/fluids`, served at `/fluids-lab.html` (see
 * `dev/main.tsx` and the project's `fluids-lab.html`). It renders the same production components
 * (`GlassVessel`, `LiquidBody`, `GraduationMarks`, `DropletStream`, `InstrumentReadout`,
 * `FluidVessel`) against local fixtures (`fixtures.ts`) instead of a real Agent 06/07 runtime, so
 * this module and everything under `lab/fluids/{geometry,color,materials,components}` can be
 * developed, screenshotted and regression-tested in isolation before those agents' work lands.
 *
 * The lighting rig below (a procedural studio built from `<Environment>` + `<Lightformer>`, with no
 * external HDR/image files) is a placeholder for Agent 02's real environment; it exists only so the
 * PBR glass/liquid materials have something plausible to reflect and refract in this harness.
 */
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import { Vector3 } from 'three';
import { blendLiquidColor, indicatorColorForPh } from '../color/indicatorColor';
import type { IndicatorId } from '../color/indicatorColor';
import { genericAqueousTint } from '../color/liquidTint';
import { DropletStream } from '../components/DropletStream';
import { FluidVessel } from '../components/FluidVessel';
import type { ContainerContents, Observation } from '../contracts';
import { volumeAtHeight } from '../geometry/vesselProfile';
import { FLUID_QUALITY } from '../quality/fluidQuality';
import type { FluidQualityTier } from '../quality/fluidQuality';
import { MAX_DELIVERED_ML, devProjection, devTelemetry, useDevStore } from './devStore';
import {
  BURETTE_CAPACITY_ML,
  DEFAULT_TITRATION_FIXTURE,
  SCENARIO_IDS,
  SCENARIO_TITLES,
  buretteLevelsScene,
  clearLiquidScene,
  devOnlyTitrationPh,
  endpointTitrationProfiles,
  equivalenceVolumeMl,
  swirlingScene,
  tintedLiquidScene,
} from './fixtures';
import type { ScenarioId, VesselFixture } from './fixtures';
import './fluidsDev.css';

const TITRANT_FLOW_ML_PER_S = 2.2;
const WATER_TINT = '#eef6fb';

const projectionVector = new Vector3();

/** Refreshes `devProjection.project` every frame from the live camera, for Playwright pixel sampling (see `devStore.ts`). */
function ProjectionBridge() {
  useFrame(({ camera, gl }) => {
    devProjection.project = (point) => {
      projectionVector.set(point[0], point[1], point[2]).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      const x = (projectionVector.x * 0.5 + 0.5) * rect.width + rect.left;
      const y = (-projectionVector.y * 0.5 + 0.5) * rect.height + rect.top;
      return [x, y];
    };
  });
  return null;
}

function contentsOf(volumeL: number): ContainerContents {
  return { volumeL, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'dev-fixture' };
}

/** A small procedural studio (no external image/HDR files) — a stand-in for Agent 02's real environment. */
function DevLightingRig() {
  return (
    <>
      <color attach="background" args={['#0a0f1a']} />
      <hemisphereLight args={['#cbe0ff', '#0a1220', 0.4]} />
      <directionalLight position={[2, 3, 2]} intensity={1.2} />
      <Environment resolution={128} frames={1} background={false}>
        <Lightformer form="rect" intensity={2.6} color="#eaf2ff" position={[-2, 2.4, 2]} scale={[3, 2, 1]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={1.1} color="#55e2d1" position={[0, -2, -1]} scale={2.4} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.4} color="#ffb66b" position={[2, 1, -2]} scale={[2, 1.4, 1]} target={[0, 0, 0]} />
      </Environment>
    </>
  );
}

function SimpleVesselScene({ vessels }: { readonly vessels: readonly VesselFixture[] }) {
  const qualityTier = useDevStore((s) => s.qualityTier);
  const reducedMotion = useDevStore((s) => s.reducedMotion);
  const quality = FLUID_QUALITY[qualityTier];
  return (
    <>
      {vessels.map((v) => (
        <group key={v.key} position={[v.positionM[0], v.positionM[1], v.positionM[2]]}>
          <FluidVessel profile={v.profile} contents={contentsOf(v.volumeL)} colorHex={v.colorHex} quality={quality} agitation={v.agitation} reducedMotion={reducedMotion} />
        </group>
      ))}
    </>
  );
}

const BURETTE_POSITION_M: readonly [number, number, number] = [-0.05, 0.22, 0];
const FLASK_POSITION_M: readonly [number, number, number] = [0.025, 0, 0];
/** Approximate world point of the burette's stopcock tip and the flask's neck opening, for the droplet stream. Illustrative placements for this harness only — Agent 03/04 own real socket positions. */
const BURETTE_TIP_WORLD_M: readonly [number, number, number] = [BURETTE_POSITION_M[0], BURETTE_POSITION_M[1] + 0.001, BURETTE_POSITION_M[2]];
const FLASK_OPENING_WORLD_M: readonly [number, number, number] = [FLASK_POSITION_M[0], FLASK_POSITION_M[1] + 0.118, FLASK_POSITION_M[2]];

function EndpointTitrationScene() {
  const deliveredMl = useDevStore((s) => s.deliveredMl);
  const dripping = useDevStore((s) => s.dripping);
  const resetCounter = useDevStore((s) => s.resetCounter);
  const indicator = useDevStore((s) => s.indicator);
  const qualityTier = useDevStore((s) => s.qualityTier);
  const reducedMotion = useDevStore((s) => s.reducedMotion);
  const quality = FLUID_QUALITY[qualityTier];

  const { burette, flask } = useMemo(() => endpointTitrationProfiles(), []);

  const deliveredL = deliveredMl / 1000;
  const ph = useMemo(() => devOnlyTitrationPh(DEFAULT_TITRATION_FIXTURE, deliveredL), [deliveredL]);
  const indicatorResult = useMemo(() => indicatorColorForPh(indicator, ph), [indicator, ph]);
  const flaskColorHex = useMemo(
    () => blendLiquidColor(genericAqueousTint().colorHex, indicatorResult, indicator === 'none' ? 0 : 0.85),
    [indicatorResult, indicator],
  );

  // The burette's TOTAL liquid volume at "0 delivered" is its full graduated-zone capacity PLUS the
  // unmarked dead volume below the stopcock (profile.graduation.bottomHeightM) — not just
  // BURETTE_CAPACITY_ML/1000 — otherwise the displayed reading would disagree with the delivered
  // amount by exactly that dead volume (a real bug caught by `e2e/fluids.spec.ts`).
  const buretteDeadVolumeL = useMemo(() => volumeAtHeight(burette.points, burette.graduation!.bottomHeightM), [burette]);
  const buretteFullVolumeL = useMemo(() => volumeAtHeight(burette.points, burette.graduation!.topHeightM), [burette]);
  const buretteRemainingL = Math.max(buretteFullVolumeL - deliveredL, buretteDeadVolumeL);
  const flaskVolumeL = DEFAULT_TITRATION_FIXTURE.acidVolumeL + deliveredL;

  // Advances the delivered volume while "dripping" is on, at the same rate reported to the droplet
  // stream below, so the meniscus/readout and the visible drops can never disagree about the flow.
  // A dev-harness simplification: production fluid components (DropletStream, LiquidBody) already
  // do their per-frame work imperatively via refs; this top-level harness orchestration uses plain
  // React state for readability since it is not the code path under performance scrutiny.
  useFrame((_, delta) => {
    if (!dripping) return;
    const store = useDevStore.getState();
    const next = store.deliveredMl + TITRANT_FLOW_ML_PER_S * delta;
    if (next >= MAX_DELIVERED_ML) {
      store.setDeliveredMl(MAX_DELIVERED_ML);
      store.setDripping(false);
    } else {
      store.setDeliveredMl(next);
    }
  });

  const outflow = dripping && buretteRemainingL > 0 ? { fromPointM: BURETTE_TIP_WORLD_M, toPointM: FLASK_OPENING_WORLD_M, flowRateMlPerS: TITRANT_FLOW_ML_PER_S } : null;

  const probeObservation: Observation = {
    type: 'PH',
    timeS: 0,
    quantity: { value: ph, unit: 'pH' },
    // A dev-harness fixture, not Agent 06's real solver — never UNVERIFIED/MODEL_CALCULATED is
    // claimed for anything production code would show; see fixtures.ts's file-level comment.
    evidence: 'UNVERIFIED',
    methodId: 'dev-fixture-strong-acid-strong-base',
    sourceIds: [],
  };

  return (
    <>
      <group position={[BURETTE_POSITION_M[0], BURETTE_POSITION_M[1], BURETTE_POSITION_M[2]]}>
        <FluidVessel
          profile={burette}
          contents={contentsOf(buretteRemainingL)}
          colorHex={WATER_TINT}
          quality={quality}
          reducedMotion={reducedMotion}
          onCurrentReadingRendered={(value) => {
            devTelemetry.buretteReadingML = value;
          }}
        />
      </group>
      <group position={[FLASK_POSITION_M[0], FLASK_POSITION_M[1], FLASK_POSITION_M[2]]}>
        <FluidVessel
          profile={flask}
          contents={contentsOf(flaskVolumeL)}
          colorHex={flaskColorHex}
          quality={quality}
          agitation={0.35}
          reducedMotion={reducedMotion}
          showGraduations={false}
          probeObservation={probeObservation}
          probePositionM={[0, 0.15, 0]}
        />
      </group>
      <DropletStream
        outflow={outflow}
        colorHex={WATER_TINT}
        quality={quality}
        resetSignal={resetCounter}
        onActiveCountChange={(count) => {
          devTelemetry.activeDroplets = count;
        }}
      />
    </>
  );
}

function SceneForScenario({ scenario }: { readonly scenario: ScenarioId }) {
  switch (scenario) {
    case 'clear-liquid':
      return <SimpleVesselScene vessels={clearLiquidScene()} />;
    case 'tinted-liquid':
      return <SimpleVesselScene vessels={tintedLiquidScene()} />;
    case 'burette-levels':
      return <SimpleVesselScene vessels={buretteLevelsScene()} />;
    case 'swirling':
      return <SimpleVesselScene vessels={swirlingScene()} />;
    case 'endpoint-titration':
      return <EndpointTitrationScene />;
  }
}

const CAMERA_BY_SCENARIO: Readonly<Record<ScenarioId, { readonly position: readonly [number, number, number]; readonly target: readonly [number, number, number] }>> = {
  'clear-liquid': { position: [0.22, 0.14, 0.26], target: [0, 0.05, 0] },
  'tinted-liquid': { position: [0.22, 0.14, 0.26], target: [0, 0.05, 0] },
  'burette-levels': { position: [0, 0.16, 0.42], target: [0, 0.14, 0] },
  swirling: { position: [0.2, 0.12, 0.24], target: [0, 0.05, 0] },
  'endpoint-titration': { position: [0.28, 0.2, 0.34], target: [-0.01, 0.1, 0] },
};

function ScenarioControls() {
  const scenario = useDevStore((s) => s.scenario);
  const deliveredMl = useDevStore((s) => s.deliveredMl);
  const dripping = useDevStore((s) => s.dripping);
  const indicator = useDevStore((s) => s.indicator);
  const qualityTier = useDevStore((s) => s.qualityTier);
  const reducedMotion = useDevStore((s) => s.reducedMotion);
  const { setScenario, setDeliveredMl, setDripping, reset, setIndicator, setQualityTier, setReducedMotion } = useDevStore.getState();
  const equivalenceMl = equivalenceVolumeMl(DEFAULT_TITRATION_FIXTURE);

  return (
    <div className="fluids-dev-panel" data-testid="fluids-dev-panel">
      <h1>lab/fluids regression harness</h1>
      <p className="fluids-dev-panel__note">
        Agent 05 dev harness. Every value shown comes from a local fixture (see <code>dev/fixtures.ts</code>), not a live simulation — it exists only
        to exercise the real rendering components in isolation.
      </p>
      <div className="fluids-dev-panel__row" role="tablist" aria-label="Scenario">
        {SCENARIO_IDS.map((id) => (
          <button key={id} type="button" data-testid={`scenario-${id}`} aria-pressed={scenario === id} className={scenario === id ? 'is-active' : ''} onClick={() => setScenario(id)}>
            {SCENARIO_TITLES[id]}
          </button>
        ))}
      </div>

      <div className="fluids-dev-panel__row">
        <label>
          Quality
          <select data-testid="quality-select" value={qualityTier} onChange={(e) => setQualityTier(e.target.value as FluidQualityTier)}>
            <option value="efficient">Efficient (alpha fallback)</option>
            <option value="balanced">Balanced (glass transmission)</option>
            <option value="quality">Quality (full transmission)</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /> Reduced motion
        </label>
      </div>

      {scenario === 'endpoint-titration' && (
        <div className="fluids-dev-panel__row fluids-dev-panel__row--titration">
          <label>
            Indicator
            <select data-testid="indicator-select" value={indicator} onChange={(e) => setIndicator(e.target.value as IndicatorId)}>
              <option value="none">None</option>
              <option value="phenolphthalein">Phenolphthalein</option>
              <option value="bromothymol-blue">Bromothymol blue</option>
              <option value="methyl-orange">Methyl orange</option>
              <option value="methyl-red">Methyl red</option>
              <option value="universal">Universal</option>
            </select>
          </label>
          <label>
            Delivered: <span data-testid="delivered-ml">{deliveredMl.toFixed(2)}</span> / {BURETTE_CAPACITY_ML.toFixed(2)} mL (equivalence {equivalenceMl.toFixed(2)} mL)
            <input
              type="range"
              min={0}
              max={BURETTE_CAPACITY_ML}
              step={0.01}
              value={deliveredMl}
              data-testid="delivered-ml-slider"
              onChange={(e) => {
                setDripping(false);
                setDeliveredMl(Number(e.target.value));
              }}
            />
          </label>
          <button type="button" data-testid="drip-toggle" onClick={() => setDripping(!dripping)} disabled={deliveredMl >= BURETTE_CAPACITY_ML && !dripping}>
            {dripping ? 'Stop drip' : 'Open stopcock'}
          </button>
          <button type="button" data-testid="reset-button" onClick={reset}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export function FluidsDevApp() {
  const scenario = useDevStore((s) => s.scenario);
  const camera = CAMERA_BY_SCENARIO[scenario];
  return (
    <div className="fluids-dev-root">
      <ScenarioControls />
      {/* preserveDrawingBuffer lets Playwright tests read back real rendered pixels via drawImage/getImageData for
          the chemistry-driven-color acceptance test (e2e/fluids.spec.ts); otherwise the browser clears the WebGL
          buffer right after presenting a frame. This harness-only cost does not apply to the production app. */}
      <Canvas camera={{ position: [...camera.position], fov: 32, near: 0.01, far: 10 }} dpr={[1, 2]} gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}>
        <DevLightingRig />
        <SceneForScenario scenario={scenario} />
        <OrbitControls target={[...camera.target]} makeDefault minDistance={0.05} maxDistance={2} />
        <ProjectionBridge />
      </Canvas>
    </div>
  );
}
