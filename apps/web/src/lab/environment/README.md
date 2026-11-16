# Laboratory environment — Agent02 integration/API

## Ownership and current verification

All implementation is contained in this directory. The existing molecular canvas,
angstrom coordinates, molecular camera store, quantum layers and WebGL
postprocessing are untouched. This module never imports a simulation store, edits
an apparatus instance, dispatches a chemical action, or derives chemical volume
from geometry.

**Verified locally:** full existing web TypeScript check; 38 focused Node/Vitest
tests covering actual CPU mesh bounds, perspective/orthographic projection,
rotated/tilted placement planes, camera ownership/locks/bookmarks/cinematics,
renderer selection/failure policy, resource disposal, quality math and
serialization. A non-emitting Vite library build of `index.ts` also passed:
3 JavaScript chunks and 1 CSS asset, held in memory with `write:false`;
React/R3F/Three were external dependencies. No dependency installation,
root manifest/lock changes, server,
browser, GPU test, screenshot or power-setting change was performed.

**Not yet verified:** actual WebGPU rendering, actual WebGL2 fallback rendering,
graphics-context recovery, final apparatus transparency/lighting, integrated
drag/camera behavior, viewport screenshots, frame times, draw calls or GPU memory
on target hardware. The renderer's `ready` status means initialization succeeded,
not visual certification or a measured 60 FPS. WebGPU is explicitly labelled
experimental. GPU checks must wait for the parent's verification window.

Installed APIs inspected: Three **0.187.0**, R3F **9.8.2**, Drei **10.7.9**.
R3F accepts asynchronous renderer factories and owns/disposes their results,
including awaiting async disposal. Its `RootState.gl` declaration still says
`WebGLRenderer`; runtime discrimination is therefore explicit.

## Entry and composition

Public exports are in `index.ts`. Agent10 owns the separate `lab/Laboratory.tsx`
entry and app navigation. Do not replace `render/MatterCanvas`.

```tsx
const [camera] = useState(() => createLabCameraController());

<LabCanvas
  cameraController={camera}
  quality="balanced"
  rendererPreference="auto"
  reducedMotion={userReducedMotion}
  onRendererStatus={recordRendererStatus}
  onMetrics={recordMeasuredWindow}
>
  <LabWorld
    mode={worldMode}
    roomPreset="teaching"
    lightingPreset="daylight"
    stations={stationDescriptors}
    activeStationId={activeStationId}
    isolateStation={isolateStation}
    placementSurfaces={benchSurfaces}
    showGrid={showGrid}
  >
    {stationDescriptors.map((station) => (
      <LabStationGroup key={station.id} stationId={station.id}>
        {renderAuthoritativeStationApparatus(station.id)}
      </LabStationGroup>
    ))}
  </LabWorld>
</LabCanvas>
```

`LabStation` is **render metadata**, not a replacement domain station:
`{id, label, boundsM: {minM, maxM}, accent?}`. Derive bounds from Agent03 definitions
and the authoritative transforms. Camera and room mode changes do not transform
children. Wrap station content in `LabStationGroup` for visual isolation:
inactive content unmounts rather than leaving invisible raycast targets.
Domain state remains in Agent07, so hidden stations continue independently.
There is a 32-descriptor limit. Supply stable IDs and memoized descriptor arrays.

### Main component props

| Component | API / defaults |
|---|---|
| `LabCanvas` | `cameraController?`; `quality='balanced'`; `rendererPreference='auto'`; `reducedMotion?`; `adaptiveResolution=true`; `frameloop='always'`; `navigationBoundsM?`; `children?` |
| Canvas DOM hooks | `onRendererStatus?`; `onMetrics?`; `onPointerMissed?`; `fallback?` for a caller-provided accessible list; `overlay?`; `className?`; `style?`; `showRendererStatus=true` |
| Canvas entry/controls | `cinematicEntry=false`; `entryStorageKey='matterlab.lab.entry.v1'`; `showControls=false` |
| `LabWorld` | `mode='room'`; `roomPreset='teaching'`; `lightingPreset='daylight'`; `stations=[]`; `activeStationId?`; `isolateStation=false`; `showGrid=false`; `showStationMarkers=true`; `placementSurfaces=[]`; `children?` |
| `Workbench` | Local geometry only: `instanceId?`, `stationId?`, `quality?`, `accent?`, `ref?: Ref<Group>`, `onSurfacePointerDown?`, `children?` |
| `EnvironmentLighting` | `preset='daylight'`; uses canvas quality context |
| `ViewportGrid` | `widthM=12`, `depthM=10`; major lines 1 m, minor lines 0.1 m |
| `LabViewportControls` | Optional `controller`; otherwise uses `LabCameraProvider`; keyboard-accessible modes, station focus and bookmarks |
| `CameraDirector` | Mounted internally exactly once by `LabCanvas`; do not add another director or OrbitControls to the same canvas |

The parent viewport slot must have a nonzero height; the canvas fills it and has a
240 px minimum. CSS selectors are limited to `lab-environment` / `lab-view-controls`
classes. No global theme or store changes are needed.

### Stable view enums

```ts
type LabWorldMode = 'room' | 'studio';
type LabCameraMode = 'orbit' | 'first-person' | 'top-down' | 'inspection';
type SceneQualityPreset = 'low' | 'balanced' | 'high';
type LightingPreset = 'daylight' | 'evening' | 'neutral';
type RoomPreset = 'compact' | 'teaching' | 'gallery';
type LabRendererPreference = 'auto' | 'webgl2' | 'webgpu';
```

The room is an original procedural cutaway (no ceiling/front wall blocking the
top/inspection views), with storage cabinets and suspended light fixtures.
Studio mode uses a fog-blended 200 m visual floor, with a finite 40 m placement
domain. Neither mode adds any BENCH apparatus.

Room footprints/heights are 6×5×3.2 m, 9×7×3.6 m and 12×9×4.2 m.
`ROOM_PRESETS` exports their first-person navigation bounds;
`STUDIO_NAVIGATION_BOUNDS` provides the studio bounds. `LabWorld` sets the
controller's navigation bounds; `LabCanvas.navigationBoundsM` can override them.
`stationLayoutAnchors(0..8)` suggests floor-pivot transforms only, not IDs or
instances. Eight anchors require the gallery footprint. Existing scene transforms
remain authoritative and are never rearranged by these presets.

## Agent03: one BENCH render path and measured geometry

Agent03 owns `bench-standard`, the BENCH definition, socket/capability metadata and
registry dispatch. Its BENCH model should delegate to `Workbench` **once**, inside
the authoritative instance transform:

```tsx
<group position={[...instance.transform.positionM]}
       quaternion={[...instance.transform.quaternion]}>
  <Workbench instanceId={instance.id} stationId={instance.stationId} />
</group>
```

`LabWorld` never spawns benches. Do not render `Workbench` separately in
`Laboratory.tsx` when `ApparatusModel` already delegates to it.
`Workbench.children` are in the bench's **local** coordinate system.

Agreement with Agent03:

| Metric | Meters |
|---|---:|
| Width / depth | 2.4 / 1.05 |
| Floor/base pivot | `[0, 0, 0]` |
| Tabletop / slab thickness | 0.9 / 0.055 |
| Complete local minimum | `[-1.2, 0, -0.525]` |
| Complete local maximum | `[1.2, 0.9, 0.525]` |
| `work-surface` socket | `[0, 0.9, 0]`, normal `+Y` |
| Safe flat-surface edge inset | 0.01 on each side (2.38×1.03 usable rectangle) |

The same conservative edge inset applies at every quality so placement does not
change with LOD. Agent04 adds apparatus footprint clearance on top of it.

Actual `Box3.setFromObject(..., true)` and triangle measurements:

| Quality | Geometry triangles | Meshes | Measured tabletop Y |
|---|---:|---:|---:|
| low | 144 | 12 | 0.900000000000 |
| balanced | 516 | 19 | 0.899999999851 |
| high | 804 | 19 | 0.899999999851 |

Bevelled mesh bounds differ from the agreed bounds by less than `5e-8 m`
(Float32 geometry). These are **CPU geometry counts**, not GPU frame-time or
draw-call benchmarks; shadows and reflection passes can add draw calls.
`WORKBENCH_METRICS` exports nominal calibration. `measureWorkbenchModel(quality)`
measures real generated geometry and disposes the temporary model.

## Agent04: camera, pointer capture and placement

`WorldPointM`, `LabQuaternion`, `LabTransform` and `LabBoundsM` are readonly
render-only structural types. Their tuples/transform shapes are compatible with
Agent07's `Vec3M`, `Quaternion`, `Transform`; no parallel apparatus DTOs or
simulation schema are defined here. No dependency on a not-yet-linked contracts
workspace is necessary for these view-only interfaces.

### Camera controller

Create one stable controller with `createLabCameraController({initialView?,
reducedMotion?, bookmarks?})`. A controller cannot own two independent canvases.
The internal canvas owner token permits only its own fresh-renderer fallback
handoff while an old R3F root is asynchronously tearing down.

| Command | Behavior |
|---|---|
| `getSnapshot()`, `subscribe(listener)` | Stable external-store snapshot; UI can use `useCameraSnapshot(controller)` |
| `getView()` | Copy of the current actual camera pose, including in-flight motion; no public mutable Three camera |
| `setMode(mode)` | Orbit, walk, orthographic top or fixed-target inspection |
| `setView(view, {animate?, durationS?})` | Explicit view; reduced motion forces an immediate move |
| `focusBounds(boundsM, {mode?, padding?, animate?})` | Perspective sphere fit / orthographic XZ fit using the real aspect |
| `focusStation(id)` | Focus a registered station without altering it |
| `saveBookmark(name)` | Returns a UUID, or null for invalid/over-capacity names; max 32 bookmarks, 64-character names |
| `restoreBookmark(id)`, `removeBookmark(id)` | Restore/delete a view-only bookmark |
| `acquireControlLock(reason)` | Synchronously stops motion and returns an idempotent release callback |
| `getWorldRay(clientX, clientY)` | Current ray in meters, or null before camera initialization |
| `projectPoint(pointM)` | `{clientX, clientY, visible}`, or null before initialization |
| `startCinematic(views, durationPerLegS=1.4)` | At most eight explicit waypoints; 0.1–5 s per leg |
| `skipCinematic()` | Immediately reaches the final view unless editing has locked the camera |

`LabCameraView` contains `{mode, positionM, targetM, fovDeg,
orthographicHeightM}`. Orthographic height is the full vertical span in meters,
not pixel height or `camera.zoom`. No simulation truth belongs in it.

Acquire a lock **before** apparatus pointer capture. Release on pointer-up,
pointer-cancel, Escape/cancel, failed placement and component unmount:

```ts
const release = camera.acquireControlLock(`drag:${instanceId}`);
try {
  // Agent04 captures the pointer and performs its own validated edit.
  // Later move events use clientX/clientY, not offsetX/offsetY.
  const ray = camera.getWorldRay(event.clientX, event.clientY);
  const hit = ray && intersectPlacementSurface(ray, surface, {
    snapM: 0.01,
    insetM: apparatusFootprintClearanceM,
  });
  // Dispatch a validated MOVE via Agent07; do not mutate mesh/simulation truth here.
} finally {
  // In a real multi-event drag, retain this callback until its end/cancel/unmount.
  release();
}
```

Overlapping locks are reference-counted. Focus/mode/bookmark commands return
false while locked; they are **not queued** to jump the camera after release.
Camera inertia is disabled; explicit scripted moves use bounded smoothstep
interpolation. Renderer controls/listeners are recreated after a lock so an old
held pointer cannot resume an orbit. React snapshots publish at completed
navigation/commands, not per frame.

Keyboard controls apply only to the focused canvas: 1–4 modes, arrows to pan,
+/− to zoom, F to focus, Home to reset, Escape to skip entry. Walk uses drag-to-look,
W/A/S/D movement, Q/E vertical movement and Shift for faster movement.
No global pointer-lock request or document-wide keyboard ownership is taken.

### Placement surfaces

```ts
const benchSurfaces = benches.map((bench) => createWorkbenchSurface({
  id: bench.id, stationId: bench.stationId, transform: bench.transform,
}));
```

`PlacementSurface`:
`{id, kind:'floor'|'tabletop', instanceId?, stationId?, transform, sizeM,
edgeInsetM?}`. Its local origin is on the plane, local +Y is the normal and X/Z
are its axes. There is **no scale**: transforms require normalized quaternions.
`createWorkbenchSurface` transforms the local `[0, 0.9, 0]` point correctly under
bench rotation/translation; surface IDs are `${instanceId}:work-surface`.

`intersectPlacementSurface(ray, surface, {snapM?, insetM?, doubleSided?})` returns
`{surfaceId, pointM, localPointM, normal, distanceM}` or null. It rejects parallel,
behind-ray, underside and out-of-bounds hits, snaps in the local frame, then
rechecks bounds. `distanceM` is the unsnapped ray-plane distance. `insetM` is
additional to the built-in bevel margin. Complete rotated footprint/collision
validation and valid/invalid highlighting remain Agent04's responsibility.

Other exports: `createFloorSurface`, `surfaceLocalToWorld`,
`surfaceWorldToLocal`, `transformBounds`, `boundsCenter`, `rayFromViewport`,
`projectWorldPoint`. These are pure geometry, not chemistry or scene mutation.
`usePlacementSurfaces()` reads the floor plus the caller's surfaces beneath
`LabWorld`; `PlacementSurfaceProvider` also works independently.
`PlacementSurfaceMesh` optionally creates a finite invisible editor hit target
with typed pointer handlers and `debug` visualization. It does not capture the
pointer, stop propagation or dispatch actions on behalf of the editor.

## Entry, focus and reduced motion

`cinematicEntry` is opt-in and remembers the first visit in sessionStorage when
available. The introduction does not autofocus or steal focus. Its skip button
is a normal focusable DOM button, and Escape also skips it. System
`prefers-reduced-motion` **OR** the user preference is honored; a false prop
cannot override the OS preference.

Agent01's `LabEntry` should drive controller commands through Agent10 instead of
enabling a second automatic introduction. Keep `cinematicEntry={false}` when
that shell owns the entry stages. `useReducedMotion`, `LabCameraProvider` and the
optional `LabViewportControls` are exported for integration.

## Lighting, renderer compatibility and asset provenance

All room geometry and HDR radiance textures are original procedural work. There
are **no downloaded HDRIs, stock images, generated mockups or external font
requests**. The installed Three RoundedBoxGeometry addon is used under Three's
existing MIT license; no third-party source or artwork has been copied.

An original, deterministic half-float equirectangular HDR softbox rig supplies
PBR reflections. Three's active renderer handles its own PMREM prefiltering.
Directional/hemisphere lights, matte surfaces and restrained ACES tone mapping
provide readable geometry without bloom. A single shadow-casting key light uses
WebGL PCF-soft or modern-renderer PCF shadow maps, with small normal bias for
meter-scale contacts. Low quality disables shadows. No screen-space AO, mirror
render targets, contact-shadow postprocess or WebGL-only EffectComposer is run
against WebGPU. Reflection/shadow appearance is still a visual QA requirement.

Agent05 should use standard supported materials or explicitly gate custom GLSL
materials to WebGL2. This module does not assume `MeshTransmissionMaterial` or a
WebGL postprocessing package supports the node-based WebGPU renderer.

`auto` tries the lazily loaded WebGPURenderer when `navigator.gpu` is present;
otherwise it explicitly requests a **WebGL2** context and uses WebGLRenderer.
`webgpu` is a preference, not a guarantee. The actual initialized backend is
inspected, including Three's internal WebGL2 fallback. Initialization/renderer
errors or context/device loss allow one fresh-canvas WebGL2 retry. A second
failure exposes an accessible fallback and explicit Retry button. The old canvas
is not reused after a GPU context might have claimed it.

Status hooks:

```ts
type LabRendererStatus = {
  phase: 'initializing'|'ready'|'fallback'|'lost'|'unavailable';
  preference: LabRendererPreference;
  backend: 'webgl2'|'webgpu'|null;
  implementation: 'three-webgl'|'three-webgpu'|null;
  reason?: string;
};
```

DOM instrumentation: `data-lab-units`, `data-lab-renderer-backend`,
`data-lab-renderer-phase`, `data-lab-renderer-implementation`,
`data-lab-renderer-fallback`, `data-lab-quality`, `data-lab-reduced-motion`.
The accessible renderer output never advertises a benchmark or certification.
Mocked factory tests prove selection/failure policy only; they are **not**
evidence that either graphics backend rendered successfully.

## Quality, resource lifecycle and profiling

| Preset | DPR range | Shadow map | HDR texture width | Decorative LOD distance |
|---|---|---:|---:|---:|
| low | 0.75–1 | disabled | 128 | 7 m |
| balanced | 0.85–1.5 | 1024 | 256 | 11 m |
| high | 1–2 | 2048 | 512 | 16 m |

Adaptive resolution caps its ceiling at the device pixel ratio and decreases only
after two >23 ms mean-frame windows and increases after six <15 ms windows.
It is disabled for `frameloop='demand'`; deterministic screenshots should pass
`adaptiveResolution={false}`. Quality changes adjust DPR, geometry, lighting
and shadows live. Context MSAA is selected at renderer creation; changing a
quality prop does not silently recreate the canvas just to change MSAA.

`LabDistanceLOD` switches decorative groups imperatively with hysteresis;
Three's normal frustum culling remains enabled. Room furnishing code loads only
for the furnished non-low room. It never unloads or edits authoritative state.
`SceneResourceScope` deduplicates owned disposables; `createSceneAssetPool`
supports reference-counted lazy loads and disposes late results after release.
Release each lease on unmount/cancel and do not attach a released lease's result.
Only own environment resources, not arbitrary apparatus subtrees.
Workbench model allocation/cleanup occurs inside mount effects, including
StrictMode setup/cleanup. HDR textures, shadow targets, geometry, controls and
document listeners are cleaned up; R3F disposes renderer roots.

`onMetrics` receives roughly one callback per measured second, not per frame:
backend, quality, sampleCount, elapsedS, meanFrameMs, p95FrameMs, FPS, drawCalls,
triangles, geometries, textures, reported GPU bytes or null, DPR, CSS viewport
size, visibility, frameloop and `measurement:'render-cadence'`. Long visible
frames are included. Hidden documents stop the render loop and reset the sample
window. These are browser-render cadence measurements, **not GPU timer queries**;
demand-mode idle intervals cannot be treated as an FPS benchmark. WebGL memory
counts do not get converted into invented byte estimates.

## Environment persistence

`defaultEnvironmentSnapshot()`, `parseEnvironmentSnapshot(unknown)` and
`serializeEnvironmentSnapshot(snapshot)` handle:

`{schemaVersion:1, units:'m', mode, roomPreset, lightingPreset, quality, showGrid,
isolateStation, activeStationId?, view, bookmarks, benchLayout}`.

`benchLayout` is a bounded array of `{instanceId, stationId, transform}` capturing
render layout metadata. It is **not** a second source of apparatus truth and is
never auto-spawned or applied by `LabWorld`. Agent09/10 may namespace this data
under the approved scene viewport JSON; derive bench layout from the authoritative
scene when saving. Unknown simulation fields are stripped. Unsupported versions,
non-meter units, invalid transforms, nonfinite views and duplicate IDs are rejected.
No schema/package files outside Agent02 ownership were changed.

## Agent10 validation fixtures and remaining integration work

`EnvironmentTestScene` is an explicit **standalone** fixture, not the production
world. It creates one fixture bench except for `empty-room`;
`apparatusChildren` must therefore exclude BENCH. Inject Agent03/05's actual
calibrated apparatus and vessel materials in local floor coordinates.
For authoritative scenes that already contain BENCH, compose `LabWorld`
directly instead of using this fixture.

`ENVIRONMENT_VISUAL_CASES`:
`empty-room`, `assembled-station`, `top-down`, `glass-close-up`, `quality-low`,
`quality-high`. `LightingReferenceRig` supplies opaque diffuse/metal references
and dark/light backdrops; Agent05 supplies the glass specimens.

After the shared verification window is assigned:

1. Build the separate Laboratory entry using the real runtime and apparatus
   registry. Exercise two independent stations and confirm one bench per BENCH.
2. Capture empty room, assembled titration, orthographic layout, vessel close-up,
   studio and low/high comparison at 1920×1080 and 1366×768.
3. Force `rendererPreference='webgl2'` on actual hardware; verify first frame,
   transparency, keyboard navigation, pointer capture and context recovery.
4. Exercise `auto`/`webgpu` with both an adapter and a blocked/unavailable adapter.
   Check the **actual backend** fields, fresh-canvas fallback, and no lingering
   device/context errors. WebGPU remains unverified until these checks pass.
5. Mid-transition drag: freeze the camera, cancel the drag, release every lock,
   and verify no queued focus or old held-pointer movement appears afterward.
6. Test reduced-motion/returning-session entry, skip button focus, bookmarks,
   panel resizing, and hidden/visible-tab restoration.
7. Profile ordinary and multi-station scenes using actual `onMetrics` windows;
   record hardware/browser, backend, quality, DPR, apparatus count and shader
   compilation warmup. Compare GPU resource counts before/after repeated mode,
   station, quality and renderer mount/unmount cycles. No 60 FPS claim is made now.

Commands run from the Agent02 worktree:

```powershell
. .\env.ps1 -Quiet
npm run typecheck --workspace @matterlab/web
npm exec -- vitest run --project web apps\web\src\lab\environment --no-cache
```

Use `--reporter=verbose --disableConsoleIntercept` to also print the measured
Workbench geometry table. No browser/GPU fixture is executed by those tests.
