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
| P1 library | **Partial** — beaker, test tube, volumetric flask, pipette implemented; droppers, graduated cylinders, funnels, support rings, lab jack, thermometer, conductivity meter, balance, temperature sensor **not yet built** (see "Known gaps") |
| Socket compatibility system | **Implemented** — role/kind/gender/geometry matching, 'planar'/'axial'/'coincident'/'proximity' mate placement math |
| Procedural geometry | **Implemented** for all 12 registered definitions; capacity-calibrated (see "Capacity calibration") |
| R3F components | **Implemented** — generic, data-driven `ApparatusMesh`; no per-kind switch statement |
| Component demo | **Implemented** — standalone `apparatus-demo.html`, see "Running the demo" |
| Automated tests | **Implemented** — 78 vitest cases across registry, sockets, container math, controls, serialization, transforms, geometry and the demo assembly |
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
                              hardware helpers + the builderRegistry mapping proceduralBuilderId -> builder
  definitions/              One ApparatusDefinition per instrument + the registration barrel
  components/               Generic React Three Fiber renderer (ApparatusMesh) + primitives/
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
| `flat-surface` | MECHANICAL | Bench top, stirrer plate (accepts `flat-bottom`) |
| `flat-bottom` | MECHANICAL | Stand, flask, bottle, stirrer, beaker, test tube, volumetric flask (accepts `flat-surface`) |
| `stand-pole` | MECHANICAL | Retort stand's rod (accepts `boss-head`) |
| `boss-head` | MECHANICAL | Burette clamp (accepts `stand-pole`) |
| `clamp-jaw` | MECHANICAL | Burette clamp (accepts `burette-barrel`) |
| `burette-barrel` | MECHANICAL | Burette (accepts `clamp-jaw`) |
| `liquid-outlet-valved` | FLUID | Burette tip (accepts `liquid-inlet-open`) |
| `liquid-outlet-pour` | FLUID | Pipette tip (accepts `liquid-inlet-open`) |
| `liquid-inlet-open` | FLUID | Flask/beaker/test tube/volumetric flask mouth (accepts both outlet roles) |
| `sensor-access` | SENSOR | Flask/beaker mouth (accepts `sensor-probe`) |
| `sensor-probe` | SENSOR | pH probe (accepts `sensor-access`) |

### Socket compatibility matrix

Generated from `sockets.ts#buildRoleCompatibilityMatrix` over all 12 registered definitions
(deduplicated by role, one representative socket per role — re-run `buildRoleCompatibilityMatrix`
over `ALL_DEFINITIONS` any time this needs refreshing; it is not hand-maintained). Only the
compatible pairs and a representative sample of rejections are shown here; the full matrix has
every role x role pair in both directions-collapsed form:

| Role A | Role B | Kind | Compatible | Reason / example |
| --- | --- | --- | --- | --- |
| `boss-head` | `stand-pole` | MECHANICAL | \u2705 | Burette Clamp \u2194 Retort Stand (600 mm rod) |
| `burette-barrel` | `clamp-jaw` | MECHANICAL | \u2705 | 50 mL Burette (Class A) \u2194 Burette Clamp |
| `flat-bottom` | `flat-surface` | MECHANICAL | \u2705 | Retort Stand (600 mm rod) \u2194 Laboratory Workbench |
| `sensor-access` | `sensor-probe` | SENSOR | \u2705 | 250 mL Conical Flask \u2194 Combination pH Probe |
| `liquid-inlet-open` | `liquid-outlet-valved` | FLUID | \u2705 | 250 mL Conical Flask \u2194 50 mL Burette (Class A) |
| `liquid-inlet-open` | `liquid-outlet-pour` | FLUID | \u2705 | 250 mL Conical Flask \u2194 25 mL Volumetric Pipette |
| `boss-head` | `burette-barrel` | MECHANICAL | \u2014 | `ROLE_NOT_ACCEPTED` |
| `boss-head` | `clamp-jaw` | MECHANICAL | \u2014 | `ROLE_NOT_ACCEPTED` |
| `stand-pole` | `burette-barrel` (e.g. a burette offered directly to a stand's rod) | MECHANICAL | \u2014 | `ROLE_NOT_ACCEPTED` |
| any FLUID role | any MECHANICAL/SENSOR role | mixed | \u2014 | `KIND_MISMATCH` |
| a too-large footprint on a 'footprint-fit' surface (e.g. the stand's base on the stirrer's small plate) | MECHANICAL | \u2014 | `FOOTPRINT_TOO_LARGE` |

See `test/sockets.test.ts` for the executable version of this table (including the two
deliberately-invalid pairings above), and `demo/ApparatusShowcaseApp.tsx`'s right-hand panel for a
live, in-browser rendering of the same checks.

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

**Totals: 3,116 triangles, 2,496 KB nominal texture memory across 12 definitions** (all texture
memory figures are placeholder budgets — nothing here actually loads a texture file yet; every
material is a flat PBR color, see `components/primitives/materials.ts`).

**Licensing and provenance**: every asset is `source: 'procedural'` — geometry authored directly in
TypeScript for this project (`geometry/**`), no external model files, no third-party assets, no
textures. `isPlaceholder: true` on 7 of the 12 definitions marks a deliberately simplified
stand-in (a box-and-cylinder clamp with no hinge, a box table, etc.) rather than a finished asset,
per the brief's "visibly marked as incomplete, not a shipping feature."

## Components

- **`components/primitives/GeometryGroupMesh.tsx`** — one procedural `GeometryGroup` -> one
  `<mesh>` with a provisional material resolved by slot name, disposal handled by the caller.
- **`components/primitives/SocketIndicator.tsx`** — a flat ring at a socket's transform, colored by
  `idle`/`hover`/`valid`/`invalid` — the "valid/invalid socket feedback" acceptance test's visual
  affordance. Agent 04 owns deciding which status applies during an actual drag gesture.
- **`components/ApparatusMesh.tsx`** — the one generic, data-driven renderer every definition goes
  through: resolves `asset.proceduralBuilderId` via `geometry/builderRegistry.ts`, renders every
  group, applies an optional `partSpin` (radians, by `materialSlot`) for visualizing a control's
  current value (a stopcock's openness, a stirrer knob's speed) **without reading or writing that
  value itself**, and optionally overlays socket indicators. An unrecognized/missing asset renders
  an unmissable magenta wireframe box instead of nothing or a silent failure.
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
part of the production build, not imported by `src/main.tsx`). It assembles the full P0 vertical
slice — bench \u2192 stand \u2192 clamp \u2192 burette, a magnetic stirrer with a flask positioned
exactly under the burette's tip, a reagent bottle and a pH probe — entirely via
`demo/sceneAssembly.ts`'s calls to `computeAttachmentPlacement`, not hand-placed transforms. The
right-hand panel lists live `evaluateSocketCompatibility` results, including two deliberately
invalid pairings. Sliders drive the stopcock/stirrer-knob `partSpin` purely for visual
demonstration. The pink/green liquid discs are an explicitly **ILLUSTRATIVE**, demo-only check that
`ContainerSpec.fillLevelForVolume` agrees with the rendered glass — not Agent 05's real fluid
renderer.

`demo/sceneAssembly.ts` has no React/rendering dependency and is covered by
`test/demoAssembly.test.ts` (instance placement, upright orientation, flask-under-tip alignment,
and every socket check's expected outcome).

## Proposed additive types — flagged for Agent 07/09/10 reconciliation

The shared contract's `ApparatusKind`/`Capability` unions (§3) do not cover every P1 instrument this
brief asks for. Rather than block on a shared `packages/contracts/lab/**` package that does not
exist yet, `types.ts` extends both unions **additively** (`ProposedApparatusKind`,
`ProposedCapability`) — anything not yet reconciled still type-checks as `OTHER`-compatible and
nothing here renames or removes a shared-contract member:

- Kinds: `BOTTLE`, `TEST_TUBE`, `VOLUMETRIC_FLASK`, `DROPPER`, `GRADUATED_CYLINDER`, `FUNNEL`,
  `SUPPORT_RING`, `LAB_JACK`, `THERMOMETER`, `CONDUCTIVITY_METER`, `TEMPERATURE_SENSOR`.
- Capabilities: `TEMPERATURE_SENSOR`, `CONDUCTIVITY_SENSOR`, `SURFACE_SUPPORT`, `OPTICAL_SENSOR`.

Please reconcile these into the shared contract (or into `packages/contracts/lab/**` once it
exists) rather than silently dropping them — several P1 definitions (`BOTTLE`, `TEST_TUBE`,
`VOLUMETRIC_FLASK`) already depend on them.

## Known gaps / remaining work

Honest accounting, not a promise list:

- **P1 library is partial.** Built: beaker, test tube, volumetric flask, pipette. Not yet built:
  droppers, graduated cylinders, funnels, support rings, lab jack, thermometer, conductivity meter,
  balance, temperature sensor. `geometry/profiles.ts#funnelBowlProfile` already exists and is
  unused — a funnel is the cheapest of these to add next.
- **No glTF loading.** `AssetManifestEntry.gltfUri` and `ApparatusMesh`'s fallback path exist, but
  nothing resolves a glTF file yet; every current definition is `source: 'procedural'`.
- **Reagent bottle has no modeled pour connection.** It is `CONTAINER`-only; a destination vessel's
  own `FILL` control is where a chosen species/concentration actually enters the simulation. Adding
  a `liquid-outlet-pour` socket/flow port to the bottle (symmetric with the pipette's) is a natural
  follow-up once Agent 07's reducer defines how a bottle's chosen contents reach a `FILL` payload.
- **Test tubes have no rack.** `test-tube-16x100mm` declares a `flat-bottom` resting socket as a
  simplification; real round-bottom tubes need a rack or clamp to free-stand.
  **The pH probe has no second mounting path.** It is only socket-compatible via its `sensor-probe`
  dip socket; clamping it to a second stand (as real labs commonly do) is not modeled.
- **The pipette's draw-up (filling) is abstracted,** not a modeled suction/inlet connection from a
  source vessel — only dispensing out the tip is a real `FLUID` socket.
- **No per-instance geometry variation.** Each `proceduralBuilderId` takes no runtime config; a
  "different size" of the same instrument is a separate definition (e.g. a future
  `burette-25ml-class-a`), not a parameterized one.
- **No geometry instancing.** Every `ApparatusMesh` builds and disposes its own geometry copy; many
  identical instances (e.g. ten beakers) are not yet GPU-memory-shared. A reasonable follow-up for
  Agent 10's performance pass.
- **CONTROL-kind sockets are typed but unused.** No P0/P1 instrument yet needs an inter-instance
  control connection (e.g. a remote hotplate control box).
- Dimensions for the reagent bottle and magnetic stirrer are `ILLUSTRATIVE` (no confidently-verified
  citation was found for these specific styles/sizes) — see `sources.ts` and each definition's
  `provenance.notes`.

## Testing

```powershell
npx vitest run apparatus   # from the repo root; runs every test under src/lab/apparatus/test/
npm run typecheck --workspace @matterlab/web
```

78 tests across `test/registry.test.ts`, `test/sockets.test.ts`, `test/container.test.ts`,
`test/controls.test.ts`, `test/serialization.test.ts`, `test/transforms.test.ts`,
`test/geometry.test.ts` and `test/demoAssembly.test.ts`. Every registered definition is asserted to
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
