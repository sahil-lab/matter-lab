# Agent 04 — Interaction and Laboratory Editor

Owned surface: `apps/web/src/lab/editor/**`. This is the brief's required handoff documentation:
what is implemented, the action dispatch contract, the command stack, provisional stand-ins and
what replaces them, and honestly-stated remaining work. See the root status report for the
`implemented files | tests run | interfaces changed | integration blockers | remaining work`
summary; this file is the durable reference for whoever integrates or continues this surface.

## What this owns, and what it deliberately does not

Per `00_SHARED_INTEGRATION_CONTRACT.md` Section 4 and the role brief: the editor converts
pointer/keyboard gestures into typed `LabAction`s and owns **placement, snapping, selection and
undo** of the scene graph. It never mutates `ContainerContents` / chemical inventory directly —
every chemistry-relevant change is dispatched through `actionSink` to the authoritative reducer
(Agent 07's surface) and only the dispatch result is read back.

```
apps/web/src/lab/editor/
  contracts.ts          shared domain model mirror (Section 3) — not canonical, see below
  types.ts              editor-local types: EditorSceneState, GestureMode, SnapResult, ...
  actionPayloads.ts      typed payload shapes for each LabAction.type
  actionSink.ts          the dispatch seam to Agent 07's reducer (installable singleton)
  sceneEditor.ts / history.ts   invertible EditorPatch + undo/redo, mirrors packages/core's
                         editScene/ScenePatch pattern
  footprint.ts           world-space geometry: AABBs, quaternion math, ray/plane/AABB intersection
  spatialIndex.ts        uniform-grid spatial index for picking/collision/snap-candidate lookups
  picking.ts             ray-vs-apparatus picking (pruned by the spatial index)
  snapping.ts            resolves Agent 03 socket metadata to world space; proposes/validates snaps
  collision.ts           AABB overlap warnings
  placement.ts           combines snap + collision + support into one PlacementPreview
  gizmo.ts               rigid multi-select transform math (move/rotate), grid snapping
  editorStore.ts         zustand store: EditorSceneState, history, selection, gesture, clipboard
  commands.ts            every undoable editing command; the patch<->LabAction translator;
                         undo()/redo() that stay in sync with the reducer
  operationalActions.ts  FILL/SET_VALVE/TRANSFER/START_STIRRER/SET_PROBE/RESET builders —
                         experiment events, never on the undo stack
  GestureController.ts   pointer/keyboard state machine; owns gesture-mode mutual exclusion
                         with the camera
  keyboard.ts            global shortcuts (undo/redo/duplicate/copy/paste/group/lock/nudge/Tab)
  serialization.ts       editor-scene (de)serialization + optimistic revision (If-Match) check
  components/            React/R3F: ApparatusMesh, PlacementGhost, LabEditorScene (Canvas host +
                         camera gating), ApparatusPalette, Hud, LabEditorHarness
  dev/                   standalone demo harness entry + browser test hook
```

Every `*.test.ts` file sits beside the module it tests. 204 vitest cases + 14 Playwright e2e cases
pass as of this handoff (see "Verification" below).

## Action dispatch contract

A `LabAction` (`contracts.ts`, verbatim from the shared contract) is the only thing that can change
anything the shared contract calls simulation truth. This directory produces `LabAction`s two ways:

1. **Editing commands** (`commands.ts`) — place/move/attach/detach/remove/duplicate/copy/paste/
   group/ungroup/lock/align/resetRotation/duplicateStation. Each commits one `EditorPatch` against
   the local, undo-tracked `EditorSceneState`, translates that *same* patch into the equivalent
   `LabAction`(s) via `labActionsForPatch`, and dispatches them through `actionSink`. If the reducer
   rejects any of them, the local patch (and whatever the reducer had already accepted) is rolled
   back — the editor and the reducer are never allowed to drift apart. `undo()`/`redo()` reuse the
   exact same translator on the (already-inverted) patch `history.ts` hands back, so undoing a
   placement also tells the reducer to forget it, and undoing a delete re-places the precise
   instance that was removed, with its original id.
2. **Operational events** (`operationalActions.ts`) — `setValve`/`fillContainer`/`transfer`/
   `startStirrer`/`setProbe`/`resetExperiment`. These dispatch straight to `actionSink` and **never**
   touch `EditorSceneState` or the undo stack — brief item 5's required separation. A running
   experiment is paused/resumed/reset, never undone.

`LabActionSink` (`actionSink.ts`) is the seam: `dispatch`, `getContainerStates`, `getObservations`,
`getApparatus` (added here, beyond the shared contract's draft, so rendering can read live
operational config — valve/stirrer/probe — without duplicating it into editor state), `reset`. It
mirrors `render/viewApi.ts`'s "always-installed, swappable singleton" pattern. Swapping in Agent 07's
real reducer is exactly one call to `installLabActionSink(impl)`; nothing else here needs to change.

## The command stack / undo-redo

Mirrors `packages/core`'s `editScene`/`ScenePatch` design on purpose, so both editors in the app
behave identically: `EditorSceneEditor` (`sceneEditor.ts`) collects changes against a scratch copy
and commits one reversible `EditorPatch`; `history.ts` stores patches (not snapshots) in
`past`/`future` stacks. **What is undo-tracked:** apparatus placement/transform, the connection
graph, groups, locks. **What is never undo-tracked:** `ContainerContents` — there is no code path
by which undo/redo can touch chemical inventory, by construction (not just convention).

## Gesture modes and camera/editing mutual exclusion

`GestureMode` (`types.ts`): `idle | camera | placing | dragging | gizmo | marquee | connecting |
operating`. Only `idle`/`camera` let the camera orbit. `GestureController` mirrors
`interaction/InteractionController.ts`'s pattern exactly: a capture-phase `pointerdown` listener
decides ownership before any camera control sees the event, and calls `stopPropagation` +
`preventDefault` + `setPointerCapture` the instant the editor claims it. Implemented:

- click select / shift-click toggle / click-empty clears selection
- shift+drag-from-empty marquee select (screen-space projection test against the spatial index)
- drag-move of the current selection as a rigid group, with a live snap/collision preview shown via
  **transient** (non-committed) transforms — mirrors `StageApi.setTransient`'s "shows other
  positions than the scene's, nothing is written until released" convention — committed as one undo
  step on release, auto-attaching if a valid snap was found
- placement arm/preview/commit/cancel, shared by a keyboard-only flow (click a palette item or
  focus+Enter, click the viewport to commit, Escape to cancel) and native HTML5 drag-and-drop
  (`dragover`/`drop`) — two accessible input paths into the same code
- a small control-hotspot registry so dragging a stopcock lever begins `'operating'` (mapped to
  `setValve`) instead of moving the apparatus

**Not implemented:** a manual "drag a wire between two sockets" connect gesture. The `'connecting'`
`GestureMode` variant exists for it, but every connection currently gets made through
snap-and-auto-attach on placement/drag instead (which is what the shared vertical slice actually
asks for — "snap... attach" together). Manual rewiring of an already-connected graph is the clearest
next increment here.

## Provisional stand-ins (not this agent's real surface — flagged for reconciliation)

Per the role's instruction to "stub anything missing additively" rather than block on other
agents' branches that do not exist in this worktree:

| File | Stands in for | Replace with |
|---|---|---|
| `lab/apparatus/catalog.ts` | Agent 03's apparatus registry | Agent 03's real definitions/sockets/glTF. Minimal set (bench, stand, clamp, burette, flask, beaker, pipette, stirrer, pH probe) sized for the Section 6 vertical slice only |
| `lab/experiments/strongAcidBaseModel.ts` | Agent 06's validated solver | A real call into `services/science`. Real closed-form strong-acid/base equation (charge balance + water autoionization), not fabricated — but labelled `UNVERIFIED`, not `MODEL_CALCULATED`, because Agent 06 has not reviewed it |
| `lab/experiments/labReducer.ts` | Agent 07's authoritative reducer | Agent 07's real experiment graph/reducer. Implements the full `LabActionSink` contract (conservation, idempotency by `actionId`, fixed-tick metered flow, pause/resume/reset, export/import) but not Agent 07's full scope (plugin-based capability registry, append-only persisted event log, arbitrary experiment templates) |
| `lab/editor/components/ApparatusPalette.tsx` | Agent 01's apparatus browser | Agent 01's real palette. Draggable *and* click-to-arm, so it is reachable by keyboard too |
| `lab/editor/components/Hud.tsx` | Agent 01's titration HUD + explanation panel | Agent 01's real HUD. Every number is read from `actionSink`, none computed here |
| `lab/editor/components/LabEditorScene.tsx`'s lighting/ground/OrbitControls | Agent 02's environment/camera | Agent 02's real `LabWorld`/`CameraDirector`. `LabEditorContents` is exported separately so a future host can embed it directly instead of this file's own `<Canvas>` |
| `lab/editor/serialization.ts`'s `saveSessionToLocalStorage`/`loadSessionFromLocalStorage` | Agent 09's persistence API | `POST/PATCH/GET /api/v1/lab/scenes/{id}`. `checkRevision` already mirrors the API's documented `If-Match` semantics so swapping the transport is mechanical |

None of this is wired into the production app shell (`apps/web/src/App.tsx`, the existing molecule
editor) — it is mounted from its own Vite entry, `apps/web/lab-editor.html` /
`lab/editor/dev/main.tsx`, specifically so the existing, working molecule editor is never at risk.

## A real, found-and-fixed integration gap worth knowing about

**Fresh placement only ever lands on the ground plane (y=0).** `GestureController.previewPlacement`
raycasts against a fixed `y=0` plane to decide where a palette item being placed would go. That
reaches any socket at (or very near) ground height — a benchtop, for instance — through a single
click. It **cannot** reach an elevated socket (a retort stand's rail, 0.38 m up) on the initial
placement click, because the candidate transform's height is always 0 regardless of where on screen
you click. Reaching an elevated socket currently requires a second step: place the item anywhere,
then **drag** it — a drag's candidate plane passes through the instance's own current position (not
the ground), so it can reach any height as the pointer moves. `e2e/lab-editor.spec.ts` covers both
paths and documents this split explicitly. **Recommended next step:** extend
`GestureController.previewPlacement` to raycast against existing placed apparatus' surfaces first,
falling back to the ground plane only when nothing is hit — the standard approach for 3D placement
onto arbitrary existing geometry, and what would let a fresh click reach a stand's rail directly.

## Accessibility

- Every mouse-only action has a keyboard path: placement (click-to-arm + click-to-commit, or native
  drag-and-drop), selection (Tab/Shift+Tab cycles through every placed instance), delete
  (Delete/Backspace), duplicate (Ctrl+D), copy/paste (Ctrl+C/V), group/ungroup (Ctrl+G/Ctrl+Shift+G),
  lock toggle (L), reset rotation (R), nudge (arrow keys, Shift for a coarser step), undo/redo
  (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y).
- Shortcuts are ignored while a text input/textarea/select/contenteditable has focus.
- The HUD's stopcock/stirrer controls are native `<input type="range">` elements (keyboard- and
  screen-reader-operable by construction), not a 3D-only drag gesture — the 3D stopcock lever is an
  *additional*, not the only, way to operate the valve.
- Not yet done: focus rings/ARIA labelling beyond what the native elements provide for free, and a
  non-3D (list/table) view of the scene graph as a full alternative to the viewport. Agent 01 owns
  the design system these would draw from.

## Performance

`SpatialIndex` (a uniform grid) backs picking, marquee selection and snap/collision-candidate
lookups, updated incrementally per committed patch (`editorStore.ts`'s `syncPickIndex`) rather than
rebuilt every frame. `e2e/lab-editor.spec.ts`'s performance test places and selects 120 instances and
logs (not asserts a hard threshold against, matching this repo's `render.bench.ts` convention)
`[lab-editor perf] placed 120 instances in 22.5 ms; selected all in 1.20 ms` on the development
machine used for this session. No other hardware was measured.

## Verification

```
npm run typecheck                      # all workspaces, clean
npx vitest run                         # 2506/2506 tests pass, monorepo-wide (204 of them in lab/editor)
npm run dev --workspace @matterlab/web # then open http://127.0.0.1:5273/lab-editor.html
npx playwright test -c apps/web/playwright.lab-editor.config.ts   # 14/14 e2e tests pass
```

The e2e suite runs on its own port (5902) with `reuseExistingServer: false`, deliberately not
sharing `playwright.config.ts`'s port 5273 — this repo has ten agents working in parallel worktrees,
and 5273 is not guaranteed to be free or to be serving this branch's code when this suite runs.

Manually exercised in a real (non-headless) browser beyond what the automated suite covers: a full
burette+flask titration via the real Fill UI and stopcock slider reaching pH 1.000 at the start and
12.52 past equivalence (computed by the charge-balance equation, not fabricated); the titration plot
accumulating correctly across multiple samples; undo/redo toggling a connection; save then reopen
rolling back to the exact saved state after further simulated delivery.

Three real integration bugs were found this way (not by unit tests, which cannot see React/zustand
render-loop interactions or multi-step browser timing) and are fixed, with regression coverage:
an infinite re-render loop from a zustand selector allocating a new array every call; a plot-baseline
bug that broke after a refill/reset; and removing an apparatus with an auto-attached connection
being incorrectly rolled back by its own redundant cascade action. Details and fixes are in the git
history (`git log --oneline` on this branch) and in `commands.test.ts`'s regression test for the last
one.

## Honest status against the brief's acceptance tests

| Acceptance test | Status |
|---|---|
| Assemble titration setup from empty workbench with mouse + keyboard | Done — e2e-covered for placement, snap-onto-benchtop, and the full fill/valve/transfer/pH chain |
| Duplicate entire station and edit duplicate independently | Done — `duplicateStation`, e2e-covered |
| Invalid snaps give predictable feedback | Done — `INCOMPATIBLE_KIND`/`SOCKET_OCCUPIED`/`SELF_CONNECTION` reasons, unit- and e2e-covered |
| Floating unsupported placement gives predictable feedback | Done — `PlacementPreview.supported`, e2e-covered before commit |
| Overlapping equipment gives predictable feedback | Done (`collision.ts`, unit-covered) for AABB overlap; not yet e2e-covered with real clicks |
| Opening the stopcock updates authoritative state, reflected in pH | Done — e2e-covered through the real slider, reading the real reducer and HUD |
| Reflected in Agent 05 fluid views | Not applicable yet — Agent 05's fluid/glass visuals do not exist in this worktree; the stand-in `ApparatusMesh` has no liquid-level rendering to reflect it in |
| Undo/redo and save/reopen preserve scene graph and stable ids | Done, e2e-covered |
| Camera never rotates unexpectedly while dragging | Done, e2e-covered (camera position asserted unchanged across a real drag) |
| 100+ object manipulation remains usable; measured times supplied | Done — measured (not asserted against an unverified target), see "Performance" above |

## Remaining work (explicitly not done; prioritized)

1. Raycast placement against existing apparatus surfaces, not only the ground plane (see above) —
   the single highest-value next step for a smoother placement feel.
2. A manual connect/rewire gesture (`'connecting'` `GestureMode` is reserved but unimplemented).
3. Context menus (right-click) for the commands `commands.ts` already exposes — currently only
   reachable via keyboard shortcuts or direct calls, not a discoverable menu.
4. Zoom-precision controls (brief item 2's "zoom-precision controls") beyond what `OrbitControls`'
   defaults provide.
5. Reduced-motion handling — nothing here currently animates beyond `OrbitControls`' damping, but no
   `prefers-reduced-motion` check exists either.
6. Focus-visible styling and ARIA roles for the palette/HUD beyond native element defaults.
7. Collision/overlap e2e coverage with real clicks (unit-covered only today).
