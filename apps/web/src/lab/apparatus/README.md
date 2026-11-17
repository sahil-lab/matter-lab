# `lab/apparatus` — Apparatus Assets and Capability Definitions

Owned by **Agent 03 (Apparatus Modeling Engineer)**. An apparatus here is both a rendered 3D object
and a typed scientific capability: every instrument is a data-driven `ApparatusDefinition`
(sockets, capacities, controls, compatibility rules, serialization schema) plus a procedural mesh
builder and a generic React Three Fiber renderer. **This module never updates inventory, volume or
pH itself** — it only emits typed `LabAction`s (via `controls.ts`) and lets Agent 07's reducer own
all simulation state, per the shared integration contract §4.

## Status at a glance

| Area | State |
| --- | --- |
| P0 vertical-slice equipment (bench, stand, clamp, burette, flask, bottle, stirrer, pH probe) | **Implemented** — all 8 defined, registered, unit-tested |
| P1 library | **Implemented** — all 13 planned instruments built: beaker, test tube, volumetric flask, pipette, dropper, graduated cylinder, funnel, support ring, lab jack, thermometer, conductivity meter, balance, temperature sensor (see "Known gaps" for the honest remaining limitations) |
| Socket compatibility system | **Implemented** — role/kind/gender/geometry matching, 'planar'/'axial'/'coincident'/'proximity' mate placement math |
| Procedural geometry | **Implemented** for all 21 registered definitions; capacity-calibrated (see "Capacity calibration") |
| Geometry sharing + glTF loading | **Implemented** — `components/geometryCache.ts` refcounts identical procedural builds so N identical instances share one GPU geometry; `geometry/gltfLoader.ts` + `ApparatusMesh`'s async `GltfApparatus` path can load a real `.glb`/`.gltf` for any definition that sets `asset.source: 'gltf'` (none do yet — every current asset is procedural) |
| R3F components | **Implemented** — generic, data-driven `ApparatusMesh`; no per-kind switch statement |
| Component demo | **Implemented** — standalone `apparatus-demo.html`, now showing two stations (the P0 vertical slice plus a second station exercising every P1 instrument), see "Running the demo" |
| Automated tests | **Implemented** — 92 vitest cases across registry, sockets, container math, controls, serialization, transforms, geometry, the geometry cache, the glTF loader and the demo assembly |
| Integration into the live 3D app | **Not done** — Agent 02's environment/camera and Agent 04's editor do not exist yet in this repo snapshot; this module is written against the shared contract's documented types, not against their code |

## Directory structure

```
lab/apparatus/
  types.ts            Domain model: ApparatusDefinition, SocketDefinition, ControlDefinition, ...
  sockets.ts           Socket compatibility evaluation + attachment placement math
  registry.ts           ApparatusRegistry + validateDefinition (the plugin point)
  container.ts          Profile-derived ContainerSpec (volume <-> fill height) + graduation ticks
  controls.ts            Control value validation -> typed LabAction (never dispatches/mutates)
  serialization.ts        Instance creation, config validation, JSON round-trip
  transforms.ts            Pure Transform/quaternion math (uses three.js internally)
  sources.ts                Cited real-world dimension sources
  geometry/                Procedural mesh builders (one file per instrument) + shared profile/
                              hardware helpers + gltfLoader.ts (parses a loaded glTF into the same
                              GeometryBuildResult shape a procedural builder returns)
  definitions/              One ApparatusDefinition per instrument + the registration barrel +
                              builderRegistry.ts (maps proceduralBuilderId -> builder function; it
                              lives here, not in geometry/, because three reused-probe-geometry
                              definitions need to be its source of truth, see "Layering rule" below)
  components/               Generic React Three Fiber renderer (ApparatusMesh) + geometryCache.ts
                              (refcounted procedural-geometry sharing) + primitives/
  demo/                     Standalone showcase scene + sceneAssembly (pure placement logic)
  test/                     vitest unit tests
```

## The domain model

See `types.ts` for the full, documented types. In short:

- **`ApparatusDefinition`** — one per instrument *type*. Stable `id`, `kind`, `category`, real
  dimensions in meters, `collision` bounds, `capabilities`, `sockets`, optional `flowPorts`,
  `controls`, optional `container`/`graduation`, `configSchema`/`defaultConfig`, `placement` rules,
  `asset` manifest (poly count, texture memory, license, placeholder flag) and `provenance`.
- **`ApparatusInstance`** (mirrors the shared contract) — only placement, config and a capability
  snapshot; everything else is looked up from its `definitionId`.
- **`SocketDefinition`** — a local transform with a `kind` (MECHANICAL/FLUID/SENSOR/CONTROL), a
  `role` + `accepts` list, a `gender`, a `mate` kind, and optional geometry-fit checks.
- **`ControlDefinition`** — a declared range/options plus the shared-contract `LabActionType` it
  produces. `controls.ts#buildControlAction` validates a value and returns a `LabAction`; it never
  sends it anywhere.

**Layering rule**: `geometry/**` never imports from `definitions/**` — geometry builders are
lower-level and must stay reusable without pulling in a specific instrument's definition. This is
why `builderRegistry.ts` (which needs the exact, single-source-of-truth geometry config object for
three P1 instruments that *reuse* the pH probe's builder with a different shape — the thermometer,
conductivity meter and temperature sensor — each exported as e.g.
`THERMOMETER_GEOMETRY_CONFIG` from its own `definitions/*.ts` file) lives in `definitions/`, not
`geometry/`: it is the one place allowed to depend on both.

## Socket system

### Mate kinds and the "upright" convention

Four `SocketMateKind`s: `'planar'` (free placement on a surface), `'axial'` (slides along one
axis), `'coincident'` (single fixed attachment point) and `'proximity'` (compatibility/alignment
only, no rigid solve — used for FLUID/SENSOR pairs like a burette tip over an open flask, or a pH
probe dipped into a vessel).

Every socket whose mating direction is "vertical" (a bench top, a stand's rod, a clamp's jaw, a
vessel's base) is authored with **`uprightSocketTransform(positionM)`** (`transforms.ts`), which
rotates local +Z onto the object's own +Y. This is what makes `computeAttachmentPlacement` leave an
attached object standing upright automatically — it is not hand-tuned per placement. See
`demo/sceneAssembly.ts` for a fully worked, unit-tested example (`test/sockets.test.ts`,
`test/demoAssembly.test.ts`).

For `'axial'` mates, the **parent** socket's declared `axialRangeM` governs the valid travel range
(a stand's rod is the rail; a clamp's own boss-head socket is normally just the grip/child side and
can declare a placeholder `[0, 0]`) — see the comment on `computeAttachmentPlacement` in
`sockets.ts` and on `SocketDefinition.axialRangeM` in `types.ts`.

### Role taxonomy in use today

| Role | Kind | Used by (accepts) |
| --- | --- | --- |
| `flat-surface` | MECHANICAL | Bench top, stirrer plate, support ring, lab jack platform (accepts `flat-bottom`) |
| `flat-bottom` | MECHANICAL | Stand, flask, bottle, stirrer, beaker, test tube, volumetric flask, graduated cylinder, lab jack, balance (accepts `flat-surface`) |
| `stand-pole` | MECHANICAL | Retort stand's rod (accepts `boss-head`) |
| `boss-head` | MECHANICAL | Burette clamp, support ring (accepts `stand-pole`) |
| `clamp-jaw` | MECHANICAL | Burette clamp (accepts `burette-barrel`, `probe-shaft`) |
| `burette-barrel` | MECHANICAL | Burette (accepts `clamp-jaw`) |
| `probe-shaft` | MECHANICAL | pH probe, thermometer, conductivity meter, temperature sensor — a second, clamp-mounted path for a sensor, as an alternative to dipping it straight into a vessel (accepts `clamp-jaw`) |
| `liquid-outlet-valved` | FLUID | Burette tip (accepts `liquid-inlet-open`) |
| `liquid-outlet-pour` | FLUID | Pipette tip, dropper tip, reagent bottle neck, funnel stem (accepts `liquid-inlet-open`) |
| `liquid-inlet-open` | FLUID | Flask/beaker/test tube/volumetric flask/graduated cylinder mouth, funnel bowl (accepts both outlet roles) |
| `sensor-access` | SENSOR | Flask/beaker mouth (accepts `sensor-probe`); `maxConnections: 2` on the flask so a pH probe and a thermometer can share one vessel at once |
| `sensor-probe` | SENSOR | pH probe, thermometer, conductivity meter, temperature sensor (accepts `sensor-access`) |

Note: two FLUID outlet roles can never mate with each other (both sides would be "pouring out") —
e.g. a reagent bottle's neck cannot pour directly into a dropper's tip. This was caught by a test
(`demoAssembly.test.ts`) before it reached the demo scene; see "Known gaps" for roles that remain
deliberately unconnectable.

### Socket compatibility matrix

Generated from `sockets.ts#buildRoleCompatibilityMatrix` over all 21 registered definitions
(deduplicated by role, one representative socket per role — re-run `buildRoleCompatibilityMatrix`
over `ALL_DEFINITIONS` any time this needs refreshing; it is not hand-maintained). Only the
compatible pairs and a representative sample of rejections are shown here; the full matrix has
every role x role pair in both directions-collapsed form (78 pairs evaluated, 7 compatible):

| Role A | Role B | Kind | Compatible | Reason / example |
| --- | --- | --- | --- | --- |
| `boss-head` | `stand-pole` | MECHANICAL | ✅ | Burette Clamp ↔ Retort Stand (600 mm rod) |
| `burette-barrel` | `clamp-jaw` | MECHANICAL | ✅ | 50 mL Burette (Class A) ↔ Burette Clamp |
| `clamp-jaw` | `probe-shaft` | MECHANICAL | ✅ | Burette Clamp ↔ Combination pH Probe |
| `flat-bottom` | `flat-surface` | MECHANICAL | ✅ | Retort Stand (600 mm rod) ↔ Laboratory Workbench |
| `sensor-access` | `sensor-probe` | SENSOR | ✅ | 250 mL Conical Flask ↔ Combination pH Probe |
| `liquid-inlet-open` | `liquid-outlet-valved` | FLUID | ✅ | 250 mL Conical Flask ↔ 50 mL Burette (Class A) |
| `liquid-inlet-open` | `liquid-outlet-pour` | FLUID | ✅ | 250 mL Conical Flask ↔ 250 mL Reagent Bottle |
| `boss-head` | `burette-barrel` | MECHANICAL | — | `ROLE_NOT_ACCEPTED` |
| `boss-head` | `clamp-jaw` | MECHANICAL | — | `ROLE_NOT_ACCEPTED` |
| `stand-pole` | `burette-barrel` (e.g. a burette offered directly to a stand's rod) | MECHANICAL | — | `ROLE_NOT_ACCEPTED` |
| `liquid-outlet-pour` | `liquid-outlet-pour` (e.g. a reagent bottle's neck offered to a dropper's tip) | FLUID | — | `ROLE_NOT_ACCEPTED` |
| any FLUID role | any MECHANICAL/SENSOR role | mixed | — | `KIND_MISMATCH` |
| a too-large footprint on a 'footprint-fit' surface (e.g. a digital balance on the lab jack's small platform) | MECHANICAL | — | `FOOTPRINT_TOO_LARGE` |

See `test/sockets.test.ts` for the executable version of this table (including the two
deliberately-invalid pairings above), `test/demoAssembly.test.ts` for two more realistic ones found
while wiring up the demo (digital balance vs. lab jack footprint; bottle-neck vs. dropper-tip), and
`demo/ApparatusShowcaseApp.tsx`'s right-hand panel for a live, in-browser rendering of the same
checks.

## Capacity calibration

Every vessel's mesh and `ContainerSpec` come from the **same** revolution profile
(`geometry/profiles.ts`), so the glass, the liquid level and the graduation marks can never
disagree (`container.ts`'s module doc explains the frustum-integration math). Early in this
module's development, several vessels' hand-picked radii integrated to noticeably more volume than
their nominal rating (e.g. the conical flask profile integrated to ~381 mL before calibration, 52%
over its 250 mL rating). Every vessel's radii are now scaled by `capacityScaleFactor` /
`scaleProfileRadiiForCapacity` to hold *exactly* its declared `capacityL`:

| Vessel | Declared capacity | Dimension evidence |
| --- | --- | --- |
| 50 mL Burette (Class A) | 50.00 mL | REFERENCE_MEASURED (ISO 385) |
| 250 mL Conical Flask | 250.00 mL | REFERENCE_MEASURED (ISO 1773) |
| 250 mL Beaker (Low Form) | 250.00 mL | REFERENCE_MEASURED (ISO 3819) |
| 250 mL Reagent Bottle | 250.00 mL | ILLUSTRATIVE (no confidently-verified citation for this screw-cap style) |
| 250 mL Volumetric Flask | 250.00 mL | REFERENCE_MEASURED (ISO 1042); mark modeled coincident with declared capacity |
| Test Tube (16 x 100 mm) | 13.00 mL | REFERENCE_MEASURED (common catalog size) |
| 25 mL Volumetric Pipette | 25.00 mL | REFERENCE_MEASURED (ISO 835/648) |
| 100 mL Graduated Cylinder | 100.00 mL | REFERENCE_MEASURED (common catalog size); reads bottom-up (`zeroAtTop: false`), the inverse of the burette |

The dropper is intentionally **not** in this table: it is modeled as an approximate, drop-by-drop
instrument (`description: '... delivers approximate, drop-by-drop volumes rather than a calibrated
amount'`), so it has a `container` for simulation purposes but no declared nominal rating to
calibrate against.

`capacityL` is each vessel's **simulated working ceiling**, not a literal brim-to-overflow
measurement — real glassware holds somewhat more right up to the rim (manufacturer overflow-capacity
figures for similarly-sized bottles/flasks/beakers are typically 5-15% above the rated volume). See
each `definitions/*.ts` file's `provenance.notes` for the specific reasoning per vessel, and
`sources.ts` for every cited figure (real URLs, no invented citations).

## Asset manifest

Poly counts and texture memory are read directly off each `ApparatusDefinition.asset` (itself
computed from the actual built geometry via `geometry/polycount.ts` — never hand-typed):

| Label | id | category | tris | tex KB | dims mm (w x d x h) | dimension evidence | placeholder |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Laboratory Workbench | `workbench-standard` | surface | 60 | 512 | 1200 x 600 x 900 | REFERENCE_MEASURED | yes |
| Retort Stand (600 mm rod) | `retort-stand-600mm` | support | 76 | 256 | 210 x 130 x 612 | REFERENCE_MEASURED | no |
| Burette Clamp | `burette-clamp-boss-head` | support | 104 | 192 | 126 x 50 x 50 | REFERENCE_MEASURED | yes |
| 50 mL Burette (Class A) | `burette-50ml-class-a` | fluid-control | 396 | 256 | 20 x 20 x 780 | REFERENCE_MEASURED | no |
| 250 mL Conical Flask | `conical-flask-250ml` | glassware | 320 | 192 | 69 x 69 x 145 | REFERENCE_MEASURED | no |
| 250 mL Reagent Bottle | `reagent-bottle-250ml` | storage | 416 | 192 | 49 x 49 x 178 | ILLUSTRATIVE | no |
| Magnetic Stirrer | `magnetic-stirrer-compact` | instrument | 204 | 256 | 160 x 160 x 66 | ILLUSTRATIVE | yes |
| Combination pH Probe | `ph-probe-combination` | instrument | 428 | 128 | 30 x 30 x 181 | REFERENCE_MEASURED | yes |
| 250 mL Beaker (Low Form) | `beaker-250ml-low-form` | glassware | 168 | 160 | 61 x 61 x 95 | REFERENCE_MEASURED | no |
| Test Tube (16 x 100 mm) | `test-tube-16x100mm` | glassware | 360 | 96 | 13 x 13 x 100 | REFERENCE_MEASURED | yes |
| 250 mL Volumetric Flask | `volumetric-flask-250ml` | glassware | 384 | 160 | 68 x 68 x 220 | REFERENCE_MEASURED | yes |
| 25 mL Volumetric Pipette | `pipette-25ml-volumetric` | glassware | 200 | 96 | 23 x 23 x 520 | REFERENCE_MEASURED | yes |
| Dropper | `dropper-standard` | glassware | 480 | 96 | 22 x 22 x 166 | REFERENCE_MEASURED | yes |
| 100 mL Graduated Cylinder | `graduated-cylinder-100ml` | glassware | 144 | 160 | 27 x 27 x 200 | REFERENCE_MEASURED | no |
| Funnel | `funnel-standard` | fluid-control | 104 | 96 | 70 x 70 x 140 | ILLUSTRATIVE | yes |
| Support Ring | `support-ring-standard` | support | 1752 | 128 | 190 x 90 x 45 | REFERENCE_MEASURED | yes |
| Lab Jack | `lab-jack-standard` | support | 48 | 192 | 150 x 150 x 120 | ILLUSTRATIVE | yes |
| Laboratory Thermometer | `thermometer-standard` | instrument | 428 | 96 | 18 x 18 x 293 | REFERENCE_MEASURED | yes |
| Conductivity Probe | `conductivity-meter-standard` | instrument | 428 | 128 | 30 x 30 x 161 | REFERENCE_MEASURED | yes |
| Digital Balance | `balance-standard` | instrument | 152 | 192 | 220 x 280 x 70 | ILLUSTRATIVE | yes |
| Digital Temperature Probe | `temperature-sensor-standard` | instrument | 428 | 96 | 20 x 20 x 134 | ILLUSTRATIVE | yes |

**Totals: 7,080 triangles, 3,680 KB nominal texture memory across 21 definitions** (all texture
memory figures are placeholder budgets — nothing here actually loads a texture file yet; every
material is a flat PBR color, see `components/primitives/materials.ts`). The support ring accounts
for nearly a quarter of the total triangle budget on its own (a torus needs many segments to read
as round at this scale) — a reasonable target if a later pass wants to trim poly count.

**Licensing and provenance**: every asset is `source: 'procedural'` — geometry authored directly in
TypeScript for this project (`geometry/**`), no external model files, no third-party assets, no
textures. `isPlaceholder: true` on 15 of the 21 definitions marks a deliberately simplified
stand-in (a box-and-cylinder clamp with no hinge, a box table, etc.) rather than a finished asset,
per the brief's "visibly marked as incomplete, not a shipping feature."

## Components

- **`components/primitives/GeometryGroupMesh.tsx`** — one procedural `GeometryGroup` -> one
  `<mesh>` with a provisional material resolved by slot name, disposal handled by the caller.
- **`components/primitives/SocketIndicator.tsx`** — a flat ring at a socket's transform, colored by
  `idle`/`hover`/`valid`/`invalid` — the "valid/invalid socket feedback" acceptance test's visual
  affordance. Agent 04 owns deciding which status applies during an actual drag gesture.
- **`components/ApparatusMesh.tsx`** — the one generic, data-driven renderer every definition goes
  through: for `asset.source === 'procedural'` it resolves `asset.proceduralBuilderId` via
  `definitions/builderRegistry.ts` and acquires the built geometry through `geometryCache.ts`
  (shared, refcounted — see below); for `asset.source === 'gltf'` its `GltfApparatus` sub-component
  asynchronously loads and parses `asset.gltfUri` via `geometry/gltfLoader.ts`, showing the same
  magenta placeholder (below) both while the load is in flight and if it fails (logged, never
  thrown past this component). Either path then renders every resulting group, applies an optional
  `partSpin` (radians, by `materialSlot`) for visualizing a control's current value (a stopcock's
  openness, a stirrer knob's speed) **without reading or writing that value itself**, and optionally
  overlays socket indicators. An unrecognized/missing asset renders
  an unmissable magenta wireframe box instead of nothing or a silent failure.
- **`components/geometryCache.ts`** — `acquireGeometryBuild`/`releaseGeometryBuild` refcount every
  procedural build by its `proceduralBuilderId` + config, so ten identical beakers share one set of
  three.js `BufferGeometry` objects instead of each building and disposing its own copy; a geometry
  is only disposed once its last referencing `ApparatusMesh` unmounts. `geometryCacheStats()`
  exposes the live/total counts for a quick sanity check (e.g. from the browser console during the
  demo). This closes the former "No geometry instancing" item from "Known gaps"; see
  `test/geometryCache.test.ts`.
- **`geometry/gltfLoader.ts`** — `parseGltfBuildResult` turns an already-loaded three.js glTF scene
  into the same `GeometryBuildResult` shape every procedural builder returns (baking each mesh's
  local transform into its vertices, preserving its authored material and naming its
  `materialSlot` after the mesh), so `ApparatusMesh` does not need to know whether a given
  definition's geometry came from code or a file. `loadGltfBuildResult` wraps it with
  `GLTFLoader.loadAsync`. No current definition sets `asset.source: 'gltf'` yet — this closes the
  prior "No glTF loading" gap structurally, but no definition has adopted it (see
  `test/gltfLoader.test.ts`, which exercises `parseGltfBuildResult` against a real exported `.glb`).
- **`components/primitives/materials.ts`** — provisional PBR materials per slot name. **Agent 05
  owns the real glass/liquid shaders and Agent 01 owns final visual-design tokens; nothing here is
  final art direction.** Glass uses plain alpha transparency rather than physical `transmission`,
  because `transmission` needs a proper environment map to look glass-like at all and is markedly
  more expensive — a reasonable PBR material requires *some* environment regardless of which
  approach is used; this is a deliberate, cheap, predictable default to replace outright, not an
  attempt at the final look.

## Running the demo

```powershell
npm run dev --workspace @matterlab/web
# then open http://127.0.0.1:5273/apparatus-demo.html in a browser
```

`demo/ApparatusShowcaseApp.tsx` is a dev-only, standalone page (not linked from `index.html`, not
part of the production build, not imported by `src/main.tsx`). It assembles two stations entirely
via `demo/sceneAssembly.ts`'s calls to `computeAttachmentPlacement`, not hand-placed transforms:

1. **The P0 vertical slice** — bench → stand → clamp → burette, a magnetic stirrer
   with a flask positioned exactly under the burette's tip, a reagent bottle, a pH probe dipped
   into the flask, and (sharing the same flask socket) a thermometer.
2. **A second P1 station** — a second stand with a support ring cradling a funnel, a graduated
   cylinder, a lab jack with a beaker resting on its platform (a jack's realistic use — see "Known
   gaps" for why the balance is *not* on the jack), a digital balance on the bench, and a dropper
   resting beside the reagent bottle (handheld in reality, so only visually placed, not
   mechanically mated — its tip-to-flask pour connection is one of the validated checks below).

The right-hand panel lists live `evaluateSocketCompatibility` results for 9 real pairings plus 4
deliberately invalid ones: a burette's barrel offered straight to a stand's pole (wrong role), a
stand's base resting on the stirrer's small plate and a balance resting on the lab jack's small
platform (both `FOOTPRINT_TOO_LARGE`), and a reagent bottle's neck offered to a dropper's tip (two
FLUID outlet roles can never mate with each other). Sliders drive the
stopcock/stirrer-knob `partSpin` purely for visual demonstration. The pink/green liquid discs are an
explicitly **ILLUSTRATIVE**, demo-only check that `ContainerSpec.fillLevelForVolume` agrees with the
rendered glass — not Agent 05's real fluid renderer.

`demo/sceneAssembly.ts` has no React/rendering dependency and is covered by
`test/demoAssembly.test.ts` (instance placement, upright orientation, flask-under-tip alignment,
and every socket check's expected outcome).

## Proposed additive types — flagged for Agent 07/09/10 reconciliation

The shared contract's `ApparatusKind`/`Capability` unions (§3) do not cover every P1 instrument this
brief asks for. Rather than block on a shared `packages/contracts/lab/**` package that does not
exist yet, `types.ts` extends both unions **additively** (`ProposedApparatusKind`,
`ProposedCapability`) — anything not yet reconciled still type-checks as `OTHER`-compatible and
nothing here renames or removes a shared-contract member. Every one of these kinds now has a
real, built, registered definition (see the asset manifest above) — they are flagged for
reconciliation into the shared contract proper, not because they are unbuilt:

- Kinds: `BOTTLE`, `TEST_TUBE`, `VOLUMETRIC_FLASK`, `DROPPER`, `GRADUATED_CYLINDER`, `FUNNEL`,
  `SUPPORT_RING`, `LAB_JACK`, `THERMOMETER`, `CONDUCTIVITY_METER`, `TEMPERATURE_SENSOR`.
- Capabilities: `TEMPERATURE_SENSOR`, `CONDUCTIVITY_SENSOR`, `SURFACE_SUPPORT`, `OPTICAL_SENSOR`
  (the last is declared but not yet consumed by any definition — no colorimeter/spectrophotometer
  is in scope yet).

Please reconcile these into the shared contract (or into `packages/contracts/lab/**` once it
exists) rather than silently dropping them — 10 of the 13 P1 definitions already depend on at least
one of them.

## Known gaps / remaining work

Honest accounting, not a promise list:

- **glTF loading infrastructure exists but is unused by any definition.** `geometry/gltfLoader.ts`
  and `ApparatusMesh`'s `GltfApparatus` path can load and render a real `.glb`/`.gltf`, but every
  current `ApparatusDefinition.asset.source` is `'procedural'` — nothing here has an actual model
  file to point at yet.
- **Test tubes have no rack.** `test-tube-16x100mm` declares a `flat-bottom` resting socket as a
  simplification; real round-bottom tubes need a rack or clamp to free-stand.
- **The pipette's and dropper's draw-up (filling) is abstracted,** not a modeled suction/inlet
  connection from a source vessel — only dispensing out the tip is a real `FLUID` socket for
  either instrument.
- **The lab jack is a fixed-height static prop, not an adjustable lift.** `lab-jack-standard`
  declares no controls (`controls: []`); its scissor mechanism is two fixed crossed struts, per its
  own `asset.notes`. A real lab jack's primary function — winding its platform up or down — is not
  modeled.
- **No per-instance geometry variation.** Each `proceduralBuilderId` takes no runtime config; a
  "different size" of the same instrument is a separate definition (e.g. a future
  `burette-25ml-class-a`), not a parameterized one.
- **CONTROL-kind sockets are typed but unused.** No P0/P1 instrument yet needs an inter-instance
  control connection (e.g. a remote hotplate control box).
- Dimensions for the reagent bottle, magnetic stirrer, funnel, lab jack, digital balance and
  digital temperature probe are `ILLUSTRATIVE` (no confidently-verified citation was found for
  these specific styles/sizes) — see `sources.ts` and each definition's `provenance.notes`.

## Testing

```powershell
npx vitest run apparatus   # from the repo root; runs every test under src/lab/apparatus/test/
npm run typecheck --workspace @matterlab/web
```

92 tests across `test/registry.test.ts`, `test/sockets.test.ts`, `test/container.test.ts`,
`test/controls.test.ts`, `test/serialization.test.ts`, `test/transforms.test.ts`,
`test/geometry.test.ts`, `test/geometryCache.test.ts`, `test/gltfLoader.test.ts` and
`test/demoAssembly.test.ts`. Every registered definition is asserted to
pass `validateDefinition`; the brief's two named acceptance-test scenarios (stand/clamp/burette
assembly, invalid pair rejection with a clear reason) are exercised directly against the real
definitions, not synthetic fixtures.

## Integration notes for other agents

- **Agent 07**: `controls.ts#buildControlAction` is the one function that turns a UI interaction
  into a `LabAction`; `sockets.ts#evaluateSocketCompatibility`/`computeAttachmentPlacement` are pure
  functions you can call for validation without owning any state. `container.ts`'s
  `ContainerSpec`/`GraduationSpec` are what you should use to interpret/display a volume you
  compute — this module never computes one itself.
- **Agent 09**: `serialization.ts` is the full persistence contract (`createApparatusInstance`,
  `validateConfig`, `parseApparatusInstance`, `serializeApparatusInstance`); `registry.ts`'s
  `ApparatusDefinitionError` messages are stable and user-presentable.
- **Agent 04**: `sockets.ts`'s `SocketCompatibilityResult.reason` is written to be shown directly to
  a user; `components/primitives/SocketIndicator.tsx` is ready to drive from your drag/hover state.
- **Agent 05**: every `materialSlot` name is listed per-definition in its `asset.materialSlots`;
  `ContainerSpec.fillLevelForVolume` is the single source of truth for a meniscus height — never
  recompute it independently.
- **Agent 02**: nothing here assumes a specific room/floor layout; `demo/ApparatusShowcaseScene.tsx`
  can be mounted inside any `<Canvas>` for a quick integration check.
