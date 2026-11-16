# Laboratory editor — Agent04

This directory owns interaction and **editor-only** metadata. It does not own an
apparatus catalog, a camera, a simulation store, solution preparation, pH,
inventories, persistence endpoints, fluid rendering or the application's entry.
All domain types are imported from the approved `@matterlab/contracts/lab` 1.1
contract. Coordinates are meters; the older molecular editor's angstroms never
enter this module.

## Composition

```tsx
const [camera] = useState(() => createLabCameraController());
const editor = useLabEditor({
  runtime,                        // canonical LabRuntimeAdapter
  definitions: apparatusRegistry, // canonical ApparatusDefinitionReader
  camera,
  surfaces: [floorSurface, ...benchSurfaces],
  dispatchBatch: actions => runtime.dispatchBatch(actions),
  onDuplicateStation: proposedScene => openNewRuntime(proposedScene),
  onReplay: stationId => replayRecordedStation(stationId),
});

// DOM shell slots:
<LabEditorPalette editor={editor} />
<LabEditorToolbar editor={editor} />
<LabEditorInspector editor={editor} preparationControls={sciencePreparationUI} />

// Exactly once inside the ONE LabCanvas/LabWorld:
<LabEditorScene
  editor={editor}
  renderApparatus={instance => (
    <ApparatusModel instance={instance}>
      {/* optional Agent05 local vessel content */}
    </ApparatusModel>
  )}
/>
```

`LabEditorScene` is not a canvas or a top navigation. It is mounted once per
canvas, not once per station. `stationId?: string` optionally filters it for
isolated viewing. The apparatus renderer owns `instance.transform` **exactly
once**. The editor's identity wrapper changes only during a transient drag and
is restored after commit/cancel. BENCH geometry remains the parent's
`ApparatusModel` → Agent02 `Workbench` path.

Provide the floor's actual finite placement domain. Bench surfaces are refreshed
from authoritative BENCH transforms with Agent02's `createWorkbenchSurface`:
floor pivot `[0,0,0]`, tabletop `0.9 m`, `2.4 × 1.05 m`, `0.01 m` edge inset.
The entire rotated footprint is checked, not just its center.

The equivalent non-React API is `createLabEditorController(options)`. Dispose it
when finished. `useLabEditor(options)` handles Strict Mode effect
connect/disconnect, gesture cancellation and camera release. Replacing the
runtime or camera creates a new controller; definitions/surfaces/callbacks can
be updated without replacing it.

## Public interaction API

All async methods return `Promise<boolean>` and report rejections in
`editor.getSnapshot().feedback`; no failed calculation is turned into a number.

| API | Purpose |
| --- | --- |
| `beginPlacement(definitionId)` | Palette click/keyboard entry; no domain action yet |
| `hoverPlacement(rayM, precise?)` | Surface/mount pointer preview |
| `previewPlacementOnSurface(surfaceId, xM, zM, yawDeg?)` | Keyboard placement in the surface's local frame |
| `previewPlacementOnSocket(target, sourceSocketId?)` | Metadata-only mounting preview |
| `previewPlacement(transform)` / `commitPreview()` / `cancel()` | Explicit preview/commit/cancel |
| `select(ids, {extend?, toggle?})`, `selectStation(id?)` | Multi-selection and workstation grouping |
| `setActiveStation(id)`, `setMode(mode)` | Mode: select/translate/rotate/connect/operate/place |
| `translateSelection(deltaM)`, `rotateSelection(axis, degrees)` | Group/subtree-preserving validated transforms |
| `setSelectionTransform(transform)`, `resetTransforms()` | Numeric editing and original-placement restoration |
| `alignSelection(axis, 'min' \| 'center' \| 'max')` | Bounds alignment; normal placement/connection checks still apply |
| `beginConnection(endpoint)`, `connect(source, target)` | Canonical mechanical/fluid/sensor/control sockets |
| `detach(connectionId, supportSurfaceId?)` | Mechanical detach must retain support; no floating orphan |
| `reparent(connectionId, targetEndpoint)` | Atomic detach/move/attach |
| `copySelection()`, `paste(offsetM?)`, `duplicateSelection(offsetM?)` | Empty geometry/internal connections only; new UUIDs |
| `groupSelection(name?)`, `ungroupSelection()`, `lockSelection(boolean)` | Editor-only metadata |
| `deleteSelection()` | Runtime-validated empty, never-started removal; no liquid disposal |
| `setValve(id, fraction)`, `startStirrer(id, enabled, frequencyHz)` | Typed authoritative operations |
| `setProbe(id, containerId \| null)` | Runtime binding; does not fabricate a sensor reading |
| `fill(id, contents, sourceId)` | Science-prepared canonical contents → runtime FILL |
| `transfer(sourceId, receiverId, volumeL, connectionId)` | Canonical TRANSFER only |
| `controlStation('PAUSE' \| 'RESUME' \| 'SET_SPEED', speed?)` | Canonical runtime controls |
| `resetStation()`, `replayStation()` | Explicit experiment lifecycle, never preparation undo |
| `setTutorialHighlight(ids)`, `focusSelection()` | Non-mutating learning/camera hooks |

`useLabEditorState(editor)` / `getSnapshot()` publish discrete selection, mode,
busy, feedback, history availability, locks, groups and capture state.
High-frequency pointer preview geometry is separate:
`getPreview()` / `subscribePreview()`. `LabEditorScene` applies preview matrices
imperatively, not with a React state update per frame. Runtime view subscriptions
can use `useLabRuntimeSelector(editor, selector, equals?)`.

Agent01 may replace the provided palette with its own browser:
`onPlace={definitionId => editor.beginPlacement(definitionId)}`. The supplied
palette additionally supports mouse/pen/touch pointer-captured dragging; clicking
then using the canvas or accessible placement form remains available.

## Commands, transactions and scientific authority

The controller creates and validates **fresh** action IDs with the target
station's current simulation time and epoch. A single domain edit calls
`runtime.actions.dispatch`. An atomic multi-edit calls the supplied
`dispatchBatch` adapter. The first child has the current **runtime** revision;
later children omit it. The runtime validates the final geometry and publishes
one coherent result.

No batch adapter means multi-object/placement-and-mount edits are explicitly
unavailable, not sequentially simulated with fake rollback. Maximum 64 child
actions per edit. Agent07's outer `CUSTOM/BATCH` audit event is recognized by its
pending child IDs so it does not erroneously invalidate the editor's own history.

Mechanical `from` is parent and `to` is child. Snapping uses
`parentWorldSocket × inverse(childLocalSocket)`, with no implicit 180° flip.
Compatibility uses both sockets' kind/direction/gender, accepted keys, required
capabilities/kinds/tags, capacity, same-station ownership, one parent, cycles and
declared alignment tolerance. Runtime validation remains authoritative.
Fluid/sensor/control connections **never teleport** equipment.

Supported surfaces and oriented-bounds collisions are checked before commit.
`requires-mount` is catalog metadata, not a hardcoded apparatus catalog.
Mechanical relatives can geometrically intersect at their mounts. Other
overlapping footprints and unsupported floating placement are rejected.
Capacity/load warnings use canonical definition metadata and existing runtime
contents; they do not predict chemistry or turn visual geometry into liters.

Preparation history contains inverse **new actions**, not saved chemical state.
PLACE inverses use Agent07's registered
`CUSTOM {pluginId:'matterlab:editor-v1', actionType:'REMOVE_EMPTY_APPARATUS', data:{}}`.
FILL/TRANSFER/RESET and outside graph changes form history barriers; starting a
run invalidates its preparation history. FILL/TRANSFER are never inverted.
Deletion is blocked for nonempty vessels, even if removal might look visually
convenient.

Station duplication requires `onDuplicateStation`. It proposes a validated new
scene ID/revision, preserving existing apparatus and adding new station/apparatus/
connection IDs with **no copied inventories or observations**. The runtime owner
must open a new runtime/scene; the editor does not splice a station into a running
store. This callback is intentionally explicit because canonical actions have
no ADD_STATION operation. The existing run is untouched.

## Capture, selection and accessibility

Native capture-phase canvas handlers run before camera/R3F handlers. They
acquire Agent02's camera lock **before** pointer capture. Pointer up, cancel,
lost capture, Escape, blur, failed capture and unmount all release it. No second
OrbitControls or global keyboard listener is installed. Multiple camera locks
remain reference counted.

Picking uses a bounded sparse meter-space broad phase followed by actual
Three.js model raycasts on candidate objects. Hidden stations have no registered
raycast roots. Selection outlines/socket markers do not intercept picking.
The editor bounds grid supports the canonical 512-apparatus scene limit.

Move/rotate gizmos, context-menu arrows, normal focusable controls, numeric
transforms, surface/socket selectors and multi-selection provide non-3D
alternatives. Text inputs keep native editing shortcuts. `Shift` gives 1 mm /
1° precision; the camera still owns ordinary wheel/trackpad zoom when not
captured. Palette touch dragging uses a single primary pointer.

Operate-mode click/drag sends SET_VALVE for a declared stopcock; click toggles
a declared stirrer; dragging a non-valve transfer source onto an already
connected receiver requests its metadata-declared metered volume. It is not a
fluid-dynamics pour model. The inspector exposes exact-volume TRANSFER in mL,
converted explicitly to L at dispatch. Unsupported operations stay unavailable.
Model controls can identify their hit meshes with `userData.labControlId`
(`stopcock`, etc.); they need not install competing event handlers.

## Editor-only save/open metadata

`serialize()` / `restore(valueOrJson)` and
`serializeEditorState` / `deserializeEditorState` preserve selection, groups,
locks, active station, mode, precision and original transforms. Validation binds
metadata to the scene ID, bounds array/string sizes, rejects domain fields and
cross-station/overlapping groups, prunes removed instance IDs, and validates
transforms through canonical apparatus contracts. Undo stacks and active
gestures are deliberately not serialized.

Agent09 can import **`editor/serialization.ts` directly in native Node**, not the
React `editor/index.ts` barrel. It exports
`parseEditorState(value, sceneOrSceneId)`,
`validateEditorState(value, sceneOrSceneId): ValidationResult<EditorSerializedState>`,
`EditorSerializedState` and `EDITOR_STATE_JSON_SCHEMA`
(`urn:matterlab:editor-state:1`, JSON Schema 2020-12). Scene-ID validation is pure
structural/identity validation; passing the complete canonical scene also
checks station/group references and prunes removed selection IDs. The schema
reuses canonical Transform/Vec3M/Quaternion definitions, with normalized
quaternion checks supplied by the parser.

`prepareSave()` returns `{id, scene, editor, ifMatch, runtimeRevision,
editorRevision}`. **ifMatch is the last acknowledged durable scene revision,
not the local runtime revision.** Save `ticket.editor` in Agent09's separate
nullable **`editorState` sidecar** under the same optimistic durable revision.
Do not inject editor metadata into `checkpoint.snapshot.scene.viewport` only
at save time: that would change the scene/checkpoint/hash relationship.
On success call
`acknowledgeSave(theSameTicket, serverRevision)`. An out-of-order/stale response
is rejected, and edits made while saving remain dirty.
`markSaveConflict()` reports a conflict without retrying or overwriting.
`getSaveStatus()` reports durable revision/dirty/conflict. No API route is
implemented or bypassed here.

## Verification and honest remaining gates

Run from the repository root after `. .\env.ps1 -Quiet`:

```powershell
& .\node_modules\.bin\vitest.cmd run --project web --maxWorkers 1 editor.test.ts
npm run typecheck --workspace @matterlab/web
```

Focused tests exercise real controller/pointer/camera/geometry code against
canonical validated apparatus/scene fixtures, including empty titration
assembly, atomic history, rejection/retry, cross-station copies, preserved
inventories, save revision races, capture cancellation, keyboard dispatch,
static accessible control rendering and a reported 128-object CPU broad-phase
timing sample. The recording adapter is **not** a scientific runtime; those
fixtures and server-rendered HTML are **not** mouse/keyboard browser acceptance.

Local verification before the persistence follow-up: **21/21 tests**, full web TypeScript check, and a non-emitting
Vite library build of `editor/index.ts` (one JS chunk and one CSS asset) passed.
The 128-object/500-query sample on Windows, Node 24.14.1 reported **0.0266 ms
mean / 0.0538 ms p95** for CPU broad-phase picking only. Shared-machine load,
model-triangle raycasting, rendering, frame time and GPU memory are not included.
The timing test reports a fresh measurement each run instead of asserting a
hardware-independent performance promise.

Actual runtime/solver integration, rendered apparatus picking, touch gestures,
two simultaneous stations, save/reopen through Agent09, transparent glass depth,
screenshots/recordings, target-hardware frame time and GPU memory must be
verified in the parent's allocated integrated window. This agent does not start
servers, claim a measured 60 FPS or create fake screenshots.
