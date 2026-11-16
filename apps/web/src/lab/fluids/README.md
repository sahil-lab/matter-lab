# State-driven glass, liquids and instruments

Agent05 owns only this directory. Contracts are the installed `@matterlab/contracts`
**1.1.0**. There is no production apparatus/reagent catalog, new Canvas, simulation
store, scientific solver, inventory writer, or independent animation loop here.
The approved parent apparatus registry/calibrations are injected as definitions.

## Integration API

Import components and factories from `lab/fluids/index.ts`; the pure modules can
also be imported directly. `ApparatusModel` owns the authoritative transform
**exactly once**. `VesselLiquid` and `VesselFluidSlot` are its **local children**.
`FluidTransferLayer`/`TransferStream` belong at world level, not inside that transform.

```tsx
// Create/subscribe in the runtime owner's effect, not during React rendering.
const presentation = createTransferPresentation(runtime.reader.getSnapshot());
const unsubscribe = connectTransferPresentation(runtime.reader, presentation);
// On owner teardown: unsubscribe(); presentation.dispose();

// Within the existing LabCanvas / LabWorld, driven by the current snapshot:
<ApparatusModel instance={instance} definition={definition}
  quality={settings.quality} glassMaterial={ownedGlassMaterial}>
  <VesselFluidSlot snapshot={snapshot} instance={instance} definition={definition}
    settings={settings} indicatorId={selectedIndicatorId} onStatus={showFluidStatus} />
</ApparatusModel>
<FluidTransferLayer snapshot={snapshot} definitions={apparatusRegistry}
  presentation={presentation} settings={settings} />
```

Keep the controller stable across snapshot updates. Recreate it for a new runtime,
or `sync(snapshot)` to adopt a checkpoint **without replaying historical flow**.
Do not initialize it from only the latest transfer event: an initial ledger
baseline and **every** ordered reader event are required. `connectTransferPresentation`
does not dispose the caller's controller or runtime; its return value unsubscribes.

| Export | Exact inputs / ownership |
|---|---|
| `createGlassMaterial(options?)` | Returns caller-owned `MeshPhysicalMaterial`; options: `quality?`, `lowPower?`, `reducedMotion?`, `materialMode?: 'physical'\|'opacity'`, `enabled?`, `thicknessM?`. Call `dispose()` once no shell uses it. |
| `VesselLiquid(props)` | `definition`, `instance`, `contents?`, `scope`, `observations`, `stirring?`, `indicatorId?`, `settings?`, `onStatus?`. Creates only liquid, not glass or a transform. |
| `VesselFluidSlot(props)` | `snapshot`, `instance`, `definition`, `settings?`, `indicatorId?`, `onStatus?`. Derives contents, scope and one unambiguous enabled CONTROL-linked stirrer; still local. |
| `FluidScope` | `{runId, stationId, epoch, simulationTimeS, status: StationStatus, lastSequence}`; use `fluidScope(snapshot, stationId)`. `lastSequence` is a cutoff, **not** a vessel solve cursor. |
| `createTransferPresentation(initialSnapshot?, options?)` | Local presentation state only. Options: `{nowS?: () => number, motionEnabled?: boolean}`. Methods: `sync`, `ingest(snapshot,event)`, `sample(query)`, `clearLink(source,receiver)`, `setMotionEnabled`, `dispose`. |
| `TransferStream(props)` | `presentation`, `sourceInstanceId`, `receiverInstanceId`, `connectionId?`, `sourceM`, `receiverM`, `scope`, `settings?`. Endpoints are world meters. |
| `FluidTransferLayer(props)` | `snapshot`, `definitions: ApparatusDefinitionReader`, `presentation`, `stationId?`, `settings?`. Derives world endpoints from actual socket transforms. Mount once; max 64 visible links. |
| `VesselGraduations` | Optional local `{calibration}` tick mesh. Do not add if the apparatus shell already includes markings. |
| `InstrumentOverlay` / `InstrumentLabel` | `{reading: InstrumentReading}` / `{reading, positionM}`. DOM / R3F Html; pointer-transparent, no synthetic measurements. |
| `VesselVolumeOverlay` | `{readings: vesselReadings(definition, contents, apparatusRuntimeState)}`. Canonical remaining/delivered inventory, not geometric estimates. |

`FluidVisualSettings` are `{quality?: 'low'|'balanced'|'high', lowPower?,
reducedMotion?, materialMode?: 'physical'|'opacity', enabled?}`. Components inherit
environment quality and honor OS reduced motion **OR** the requested preference.
The pure factories have no browser/settings subscriptions.

## Scientific boundaries and stale-data handling

* Liquid height is interpolated **only** from the declared monotonic
  `volumeHeightCurve` in **L → local m**. There is no linear `volume/capacity`
  shortcut for conical vessels. Height changes immediately with inventory, so
  the meniscus does not lag the textual reading.
* A frustum integral checks that the actual supplied interior profile agrees with
  the curve within **0.5% of capacity** (including intermediate samples).
  Invalid/missing calibration, over/negative/nonfinite volumes, mismatched
  capacities, nonnormalized orientations, or non-upright vessels are not drawn.
  `onStatus`/`evaluateVesselFill` explains why; the integrating inspector must
  expose that reason, not leave an apparently filled tilted vessel.
* Upright includes arbitrary yaw; tilt beyond **0.001 rad** is unsupported. No
  spill, gravity-level tilted surface, or fluid redistribution is invented.
* An empty vessel draws no liquid. Exactly-full has no surface motion or
  out-of-range meniscus. The declared BOTTOM/TOP meniscus keeps its center on the
  calibration reference; offset is bounded down near empty/full. Parent's current
  zero-offset calibrations produce a flat reference surface, not invented wetting.
* Indicator color is the exact `INDICATOR.indicatorState.colorSrgb`, with matching
  indicator identity, base fraction and source IDs. PH and INDICATOR must share
  **run/station/epoch/apparatus/time AND record.sequence** from one solve. A newer
  inventory observation invalidates an older solve, including same-time fills.
  FAILED/UNSUPPORTED, ambiguous multiple indicators, missing optional state, or
  old/future records produce **no indicator tint**. There is no pH-to-color
  equation, threshold, reagent-name heuristic, or shader chemistry.
* Only optional 180 ms appearance interpolation within a continuing running
  scope uses past/current **real** colors. Reset, missing/unsupported color,
  pause, reduced motion and low-power snap immediately; numerical readouts never
  interpolate. Optical opacity `0.24 + 0.38 * baseFraction` is explicitly
  **ILLUSTRATIVE**, not Beer–Lambert absorbance or measured concentration.
* `selectProbeReading` resolves the actual bound same-station container, because
  canonical PH is recorded against the container, not the physical probe.
  `selectInstrumentReading` returns record/provenance or an explicit unavailable
  state. Displayed pH, temperature, mass and concentrations come only from records.
* Remaining and delivered amounts come from `ContainerContents.volumeL` and
  `ApparatusRuntimeState.deliveredVolumeL`. A descending burette's **nominal scale**
  is `capacity - remaining`; it equals actual delivery only if initially filled
  to the calibrated zero. A partial refill does not rewrite delivered inventory.

## Accepted flow, animation and resource limits

Agent07 publishes callbacks with the **final immutable snapshot** for all events
in an operation: ADVANCE, accepted TRANSFER, inventory observations, then science.
The controller tracks unclaimed positive `transferTotals` deltas in that final
snapshot and consumes them only when the matching **APPLIED ACTION/TRANSFER**
arrives. ADVANCE alone, valve opening, requested volume, rejected transfers and
rehydrated historical totals never create a droplet.

Zero-accepted ADVANCE, pause/resume, reset/epoch change, changed apparatus,
disabled motion, stale scope and a 350 ms wall-clock expiry clear bursts.
Sequences are deduplicated. A new run/checkpoint seeds rather than replays.
Automatic actual clipped amounts and manual tolerance clipping are reconciled
with accepted totals; no inventory is written by the visual controller.

Drop count accumulates a **10 µL illustrative visual quantum**; quality caps can
coalesce larger transfers. Radius is a bounded **0.8–2 mm** optical mapping of
accepted flow, not a physical drop-volume measurement. Falls last 220 ms along an
illustrative quadratic path. High accepted flow can show a thin bounded ribbon.
These paths are not hydrodynamics; uphill/zero-gap/>2 m paths are unsupported.
Use state/observations, not droplet counts, for all numerical measurements.

| Mode | Angular segments / surface rings | Max drops/link | Surface update ceiling |
|---|---|---|---|
| low | 24 / 4 | 8 | 15 Hz |
| balanced | 40 / 6 | 24 | 30 Hz |
| high | 64 / 8 | 48 | 30 Hz |
| low-power | low geometry; no transmission, waves or ribbon | 8 | static |
| reduced-motion | unchanged calibrated level and current numerical values | **0** | static |

The liquid is one indexed mesh; ticks use one line mesh. Motion is bounded by
liquid depth/headroom/radius, zero at center/contact line, and zero angular mean.
Its frequency is a capped decorative rendering of an authoritative enabled
stirrer, not a CFD model. No motion writes volume, species or mixing state.
Geometry has a **5 µm radial inset** to avoid coincident glass/liquid surfaces;
polygon tessellation and declared meniscus shape are graphical approximations.

R3F's existing `useFrame` drives presentation; there is no React state update per
frame, timer, independent RAF, render target or second canvas. Geometry/materials
are created in layout effects (including StrictMode cleanup), disposed on quality
change/unmount, and do not dispose injected apparatus/glass/runtime resources.
Presentation storage is capped at 64 links × 48 drops. Hidden-tab return cannot
replay a backlog. Low-power is a render preference, never an OS/GPU power change.

## Renderer compatibility and remaining GPU checks

Materials are stock Three `MeshPhysicalMaterial` and `LineBasicMaterial`; there
is no `onBeforeCompile`, custom GLSL, unsupported Drei transmission shader, or
postprocessing. They use the environment's original HDR/lighting and meter scale.
Three's `three-webgpu` implementation can have a WebGL2 backend: **do not** select
legacy shader code based solely on `backend === 'webgl2'`.

`materialMode='opacity'` disables transmission as a caller-controlled compile/
transparency fallback and is selected automatically for low-power. The environment
owns actual renderer failure/retry/WebGL2 fallback. No claim of successful GPU
compilation or optical correctness is made by CPU tests.

`FluidRegressionFixture` composes **supplied real runtime snapshots**, injected
apparatus renderers and these exact fluid components inside the existing canvas.
It creates only supplied vessels/transfer paths, **no bench or generated chemistry**.
`renderVessel(instance, definition, localChildren)` must apply the transform once.
`FLUID_VISUAL_CASES` describes clear/tinted, near-empty/full, overlap, stirring,
endpoint, accepted-flow and unsupported-tilt cases; `caseId` never fabricates state.
Use with Agent02's `LightingReferenceRig` (or `EnvironmentTestScene`, which already
has its own fixture bench), not alongside a duplicate rendering of those vessels.

Still required in the parent's shared GPU window: actual WebGPU and forced
WebGL2/opacity first frames; close/mid/rotating dark/light transparency and ordering;
1920×1080/1366×768 numerical/meniscus agreement; actual solver endpoint transitions;
pause/reset/zero-flow/reduced-motion visuals; repeated mount/quality/backend
resource checks; measured frame times/draw calls/memory. No server, browser,
screenshot, GPU benchmark, power change or performance claim is part of unit tests.
