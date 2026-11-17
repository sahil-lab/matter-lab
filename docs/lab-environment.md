# The 3D laboratory environment (Agent 02)

Owned surface: `apps/web/src/lab/environment/**`. This module provides the immersive room/studio
shell, lighting, cameras and multi-station layout that the rest of the Astra lab (apparatus,
interaction, simulation, gameplay) is built inside of. It contains **no apparatus geometry and no
chemistry**: everything here is presentation, and the module is usable on its own (see the harness
below) before any other agent's work lands.

## Quick start

```
npm run dev --workspace @matterlab/web      # http://127.0.0.1:5273/lab-environment.html
```

The harness (`src/lab/environment/harness/`) is a self-contained page — not wired into the main
app's `App.tsx`/workspace switcher, since that is Agent 01/04/07's integration call to make. It
mounts `<LabWorld>` with `dev/DevApparatusStub` standing in for Agent 03's real apparatus, and
exposes a `window.__LAB_ENV__` test hook (installed only in dev/e2e builds), mirroring the main
app's `window.__MATTERLAB__` convention.

Tests:

```
npm run typecheck --workspace @matterlab/web
npx vitest run src/lab/environment --project web                                  # unit tests
npx playwright test -c playwright.lab-environment.config.ts lab-environment.spec.ts   # e2e
npx playwright test -c playwright.lab-environment.config.ts lab-environment.shots.ts  # screenshots
```

`playwright.lab-environment.config.ts` exists because several agents' dev servers may share this
machine; set `LAB_ENV_URL` if port 5291 is unavailable. Screenshots go to
`docs/screenshots/lab-environment/`.

## Coordinate system (`coordinates.ts`, `types.ts`)

- **Metres** are the canonical spatial unit; Y is up — matching the shared contract's
  `Transform { positionM, quaternion }`, which `WorldTransform` mirrors field-for-field so it can be
  used interchangeably once `packages/contracts` exists.
- `REFERENCE_HEIGHTS_M` gives a plausible scale for a stand/clamp/burette/flask assembly (bench top
  at 0.9 m, etc.). This is **not** an apparatus definition — Agent 03 owns real dimensions — it only
  calibrates this module's own camera/lighting work and the dev placeholder.
- `rotateVector`, `composeTransforms`, `worldToLocal`, `stationToWorld`/`worldToStation` are
  dependency-free quaternion math (no Three.js), so they're unit-tested directly and reusable from
  a worker if needed.
- `snapToGrid`/`snapPointToGrid`/`GRID_CELL_M` are the numeric half of the placement grid; Agent 04
  can call them directly while dragging. `ViewportGrid.tsx` only draws the matching visual.

## Multi-station layout (`stations.ts`)

A **station** is `{ id, name }` (identical shape to the shared contract's
`ExperimentScene.stations[i]`). `layoutStations(stations, mode)` is a pure function of the station
list's **order** — not of station identity — so reordering the list is the only thing that reflows
positions, and reopening a saved scene reproduces the same layout deterministically. `room` mode
lays stations out in a row; `studio` mode uses a roughly square grid. `layoutBounds` gives the
plan-view footprint for sizing a room around the layout (`RoomConfig.roomDimensionsFor`).

Apparatus/interaction code should get a station's world transform from `layoutStations`/`findSlot`
(or `LabWorld`'s exported `useStationSlot` hook) and compose apparatus-local transforms onto it with
`coordinates.composeTransforms` — never hardcode a station's position.

## Cameras (`CameraDirector.tsx`, `cameraModes.ts`, `cameraDirectorApi.ts`)

Five modes, selected by the `mode` prop on `<CameraDirector>` (a controlled value — see below):
`orbit`, `inspect` (a tight close-range orbit), `top-down` (locked orthographic, pan/zoom only, no
spin), `first-person` (WASD + drag-to-look at a fixed eye height), `cinematic` (scripted, not
user-controllable). Orbit/inspect/top-down/cinematic ride on `camera-controls`, the same library
`render/CameraRig.tsx` uses for the molecular editor; first-person is a small custom rig layered on
top since it needs free movement rather than orbiting a target.

**Mode is a controlled prop, not something the imperative API sets.** This mirrors how the
molecular editor's `projection` lives in its own store rather than in `viewApi`: whoever renders
`<CameraDirector mode={...}>` (here, `LabWorld`, reading `useEnvironment`) is the single source of
truth for which mode is active. To change it, call `environmentActions.setCameraMode(mode)`.

Everything else goes through **`cameraDirectorApi`** (`import { cameraDirectorApi } from
'lab/environment'`), an idle/install singleton exactly like `render/viewApi.ts`: calls before the
canvas mounts are harmless no-ops.

```ts
cameraDirectorApi.getPose(): CameraPoseData | null
cameraDirectorApi.goToPose(pose, animate?)
cameraDirectorApi.focus({ center, radiusM }, animate?)        // frame one sphere
cameraDirectorApi.fitAll(targets, animate?)                   // frame every sphere at once
cameraDirectorApi.pause(ownerId) / .resume(ownerId) / .isPaused()
cameraDirectorApi.project(point): [x, y] | null                // world metres -> CSS pixels
cameraDirectorApi.redraw()
cameraDirectorApi.playIntro(waypoints): Promise<void> / .skipIntro()
```

**Agent 04 integration point:** call `cameraDirectorApi.pause('apparatus-drag')` on pointer-down
over apparatus and `cameraDirectorApi.resume('apparatus-drag')` on release. Pausing is reference
counted by reason string, so independent callers (e.g. a running cinematic intro) don't fight each
other. Covered by `e2e/lab-environment.spec.ts`'s "Agent 04 drag contract" test: dragging the canvas
while paused leaves the pose exactly unchanged; the same drag after resuming moves it.

**A real subtlety, already handled for you:** drei recreates the entire underlying
`camera-controls` instance whenever the *default camera itself* changes — i.e. every time a mode
switch also changes projection (perspective ↔ orthographic, such as orbit ↔ top-down). A naive
implementation loses the current view at that point. `CameraDirector` carries the view across this
recreation by tracking direction + **visible height at the target** (not raw zoom/distance, which
mean different things in each projection) every frame, and restores it whenever `controls` is
(re)created — see the `carried` ref and `perspectiveDistanceFor`/`perspectiveVisibleHeight` in
`CameraDirector.tsx`. If you need the same conversion elsewhere, use `cameraModes.ts`'s
`orthoZoomForHeight`/`visibleHeightForZoom`.

Bookmarks (`CameraBookmark`) are plain data (`cameraModes.ts`: `createBookmark`, `addBookmark`,
`removeBookmark`, `renameBookmark`, `findBookmark`), stored in `useEnvironment`, and applied with
`cameraDirectorApi.goToPose`. `environmentActions.saveBookmarkHere`/`goToBookmark` wire the two
together.

Reduced motion: every animated API call is wrapped in `cameraModes.effectiveAnimate(requested,
reducedMotion)`, and `playIntro` resolves immediately (no path playback) when reduced motion is on.
`useEnvironment`'s `reducedMotion` field defaults from `prefers-reduced-motion`.

## Scene quality, LOD and profiling

- `SceneQuality.ts`: `SCENE_QUALITY` (`efficient`/`balanced`/`quality`) presets DPR range, shadow
  strategy (contact shadows only vs. real-time shadow maps too), post-processing, HDRI resolution
  and `lodDistancesM`/`maxLoadedStations`. `recommendSceneQuality(device)` is a sibling policy to
  `render/quality.ts`'s `recommendQuality` (same heuristic, independent so the two scenes can be
  tuned separately), sharing only the generic `detectDevice`/`DeviceInfo` probe.
- `shouldLoadStation(index, activeIndex, maxLoaded)` and `lodLevelForDistance` are the on-demand
  loading/LOD decisions; `LabWorld` already gates `renderStationContent` through
  `shouldLoadStation`, so apparatus content Agent 03/04 render into a station gets this for free.
- `SceneResourceManager`: a small ref-counted cache for geometries/materials/textures shared across
  stations (`acquire(key, create, dispose)` / `release(key)`), plus `isBeyondCullDistance`. `LabWorld`
  creates one instance and provides it on `SceneResourceContext`; call `useSceneResources()` from
  inside a station's content to share resources through it instead of creating your own.
- `FrameInstrumentation.tsx` (`PerfBegin`/`PerfEnd`, reusing `render/perf.ts`'s `PerfMonitor`) and
  `AdaptiveResolution.tsx` (the same dynamic-DPR technique as `render/FrameHooks.tsx#FrameEnd`,
  generalised) are opt-in — the harness wires them in as a worked example for Agent 10's benchmark
  harness. **Remember to set `gl.info.autoReset = false`** in whatever calls `PerfMonitor.begin`
  before any post-processing composer runs, or draw-call/triangle counts will read near zero (the
  composer's internal render passes reset them); `PerfBegin` already does this.
- Measured (not asserted) frame data from `e2e/lab-environment.spec.ts`'s perf test and the harness,
  Balanced preset, one furnished station, integrated GPU: ~45-55 fps, 83 draw calls, ~1,280
  triangles. This is the only hardware measured so far; it is not a promise for other machines.

## Lighting, reflections and postprocessing (`EnvironmentLighting.tsx`, `LabEffects.tsx`, `RoomConfig.ts`)

Three lighting presets (`daylight-lab`, `night-lab`, `studio-neutral`), each a label + palette
(key/ambient/rim colour and intensity, background/floor/wall colour, fog density) and a
`bloomThreshold` kept close to 1 so glass highlights read as bright rather than glowing — the
`night-lab` preset is the deliberate check for "glass readable against a dark environment without
unrealistic glow" (see `docs/screenshots/lab-environment/06-lighting-night-lab.png`).

The environment map is **procedural** (drei `<Lightformer>` shapes inside `<Environment>`), the same
technique `render/Stage.tsx` uses for the molecular editor — no licensed HDR image file, and the
scene renders identically offline/in CI. Contact shadows (`<ContactShadows>`) run at every quality
tier; real-time shadow maps are added for `balanced`/`quality`. `LabEffects.tsx` is restrained
post-processing (ambient occlusion, bloom gated by the preset's threshold, AgX tone mapping, SMAA,
a light vignette) — mirrors `render/Effects.tsx`'s structure.

**`LightingTestRig.tsx`** is the lighting/reflection test rig for Agent 05: a mirror sphere, a glass
sphere (the same `MeshPhysicalMaterial` family real glass/fluid materials should use) and a matte
diffuse sphere, under whatever lighting preset/quality is active. Toggle it with
`environmentActions.setLightingTestRigVisible(true)` or `<LabWorld forceLightingTestRig>`. See
`docs/screenshots/lab-environment/08-lighting-test-rig.png`.

## Serialization (`RoomConfig.ts`)

`EnvironmentSettings` is the **only** thing this module persists: `mode`, `lightingPresetId`,
`qualityId`, `activeStationId`, camera `{ mode, pose, bookmarks }`, `gridVisible`, `introPlayed`.
`serializeEnvironment`/`deserializeEnvironment` convert it to/from a plain JSON value meant for
`ExperimentScene.viewport`. **Apparatus, connections and container contents must never be written
through here** — that is Agent 07/09's data. `deserializeEnvironment` never throws: every field
that is missing, the wrong type, or otherwise unrecognised falls back to its default individually,
so a scene saved by an older or foreign client still opens (see `RoomConfig.test.ts` for the
exact fallback behaviour, including malformed bookmarks being filtered out one at a time rather
than discarding the whole list).

`environmentActions.currentEnvironmentSettings()` / `loadEnvironmentSettings(settings)` are the
load/save entry points Agent 07/09 should call; they don't need to understand the shape, only pass
it through `scene.viewport`.

## Accessibility

- Reduced motion is respected everywhere animation is optional (see above); the cinematic intro is
  always skippable (`cameraDirectorApi.skipIntro()`, bound to Escape in the harness).
- Camera-mode buttons use `aria-pressed` and are real `<button>` elements, so they're keyboard
  reachable and screen-reader legible; focus rings are not suppressed (`harness.css`).

## Known limitations / remaining work

- First-person's look-direction math is hand-derived (not reused from `cameraModes.ts`'s tested
  helpers) and verified visually (screenshots, manual browser testing) rather than unit-tested;
  if it needs to change, add a pure yaw/pitch helper and test it the way `coordinates.ts` is tested.
- Room/studio wall and floor materials are flat colours, not textured; acceptable for the
  "restrained effects" bar but a likely place for Agent 01's art direction to extend.
- On-demand loading is index-proximity based (`shouldLoadStation`), not camera-distance based;
  `isBeyondCullDistance` exists for a future distance-based pass once real apparatus bounding
  volumes exist.
- No automated visual-regression (pixel diff) checks yet — screenshots are generated and reviewed,
  not compared frame-to-frame; that's a natural fit for Agent 10's benchmark/QA harness.
- The harness is intentionally not wired into `App.tsx`; integrating a "lab" workspace entry is a
  decision for Agent 01/04/07/10 once their own pieces exist.
