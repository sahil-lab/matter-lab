# `lab/fluids` — Agent 05: Fluid, Glass and Instrument Visualization

Owned surface: `apps/web/src/lab/fluids/**`. This package renders glass vessels, their liquid
contents, droplet streams and instrument readouts for the MATTER LAB Astra 3D laboratory. It is
**read-only against upstream state**: every number this code draws (fill volume, flow rate, pH,
indicator reading) must come from Agent 06 (chemistry) or Agent 07 (experiment/apparatus runtime).
Nothing here computes or invents a chemical result, a flow rate or a species identity — see
`contracts.ts`'s header comment and the shared integration contract for the full rule.

## Layout

```
contracts.ts        Additive contract stub (Section 3 shapes + proposed VesselProfile/FluidOutflow)
geometry/            Vessel fill math, lathe-geometry conversion, meniscus surface
color/                Indicator-color-vs-pH mapping, base liquid tints
flow/                 Droplet spawn timing and free-fall trajectory (real kinematics only)
quality/              Adaptive quality tiers, device-based demotion, reduced-motion support
materials/            PBR glass/liquid material factories, billboarded text-sprite labels
components/           R3F components: GlassVessel, LiquidBody, GraduationMarks,
                      InstrumentReadout, DropletStream, FluidVessel (the composed entry point)
dev/                  Standalone regression/screenshot harness, served at /fluids-lab.html
index.ts              Public barrel (contracts + components + the small set of pure helpers
                      another agent is likely to need directly)
```

## Using it from another agent's code

```tsx
import { FluidVessel, buretteProfile, erlenmeyerFlaskProfile, FLUID_QUALITY } from '../fluids';

// Place this component's local origin at the vessel's own base socket — it owns no transform.
<group position={apparatus.transform.positionM} quaternion={apparatus.transform.quaternion}>
  <FluidVessel
    profile={buretteProfile(apparatus.id, 50)}      // or your own VesselProfile once Agent 03 ships one
    contents={containerStates[apparatus.id]}         // ContainerContents from Agent 07, or undefined/null = empty
    colorHex={liquidColorFor(containerStates[apparatus.id])}  // see color/indicatorColor.ts + color/liquidTint.ts
    quality={FLUID_QUALITY[qualityTier]}             // pass the app's existing QualityId straight through
    outflow={currentOutflowFor(apparatus.id)}        // FluidOutflow | undefined; omit entirely to render no stream
    probeObservation={latestObservationFor(apparatus.id, 'PH')}
    probePositionM={[0, 0.15, 0]}
  />
</group>
```

For more control than `FluidVessel`'s all-in-one composition offers (e.g. a droplet stream whose
source and target aren't both `FluidVessel`s), compose the lower-level components directly —
`GlassVessel`, `LiquidBody`, `GraduationMarks`, `DropletStream`, `InstrumentReadout` are all
individually exported from `components/` and from the package barrel. `dev/FluidsDevApp.tsx`'s
`EndpointTitrationScene` does exactly this for its burette→flask drip.

### `VesselProfile` — what Agent 03 should eventually supply

A `VesselProfile` is an ordered list of `{heightM, radiusM}` points (the vessel's inner-wall
revolve profile, base to rim), a `wallThicknessM`, and an optional `VesselGraduation` for vessels
with a printed scale. `geometry/vesselProfile.ts` exports builders for four representative shapes
(`buretteProfile`, `erlenmeyerFlaskProfile`, `beakerProfile`, `reagentBottleProfile`) that work
today and can be swapped for Agent 03's real calibration data later without touching any rendering
code — every function in `lab/fluids` reads a `VesselProfile`, never a hardcoded shape.

## Materials: PBR glass and liquid

Both `materials/glassMaterial.ts` and `materials/liquidMaterial.ts` build a `MeshPhysicalMaterial`
two ways, chosen by `FluidQualitySettings.{glass,liquid}Transmission`:

- **Transmission path** (`transmission: 1`/`0.92`, `thickness`, `ior`, `clearcoat`): three.js's
  built-in transmission render pass — the same technique as the official
  `webgl_materials_physical_transmission` example, no custom shader code. Gives real refraction
  through the glass at the cost of an extra render pass per transmissive object.
- **Alpha-blended fallback** (`transparent: true`, `opacity`, `clearcoat`): ordinary blending, no
  extra render pass, still reads as glass/liquid at typical camera distances. Used on the
  `efficient` tier and for the liquid body at every tier (see "Known limitation" below).

Two things were **not** obvious from the three.js docs and were only found by actually
screenshotting the result (see `e2e/fluids.spec.ts` and the dev harness) — read these before
changing either material file:

1. **`thickness` must stay on the order of the vessel's own size** (here, a few millimeters to a
   couple of centimeters), not an arbitrary "real" measurement. An earlier version multiplied the
   real ~1.5 mm wall thickness by 24 "to make the refraction visible"; on a vessel only a few
   centimeters across that pushed the refraction ray's sample point off the pre-rendered
   transmission texture entirely, which reads back as **solid black** with stray bright edge
   artifacts instead of a refracted background — not a GPU/driver limitation, a parameter-scale bug.
2. **`side: DoubleSide` does not mix well with `transmission`** on a hollow, open-topped shell (a
   burette/flask/beaker is not watertight — it has an open rim). `DoubleSide` submits the shell's
   near *and* far walls as two separate transmissive fragments along the same camera ray; both
   `GlassVessel`'s and `LiquidBody`'s transmissive branch now use `FrontSide` instead. `DoubleSide`
   remains correct and is kept for the alpha-blended fallback, where there is no per-object
   transmission render pass to conflict.

**Known limitation, not yet fixed:** no quality tier enables `liquidTransmission`. With the glass
shell *also* transmissive (every tier that would want liquid transmission already wants glass
transmission), having both the glass **and** the liquid transmissive at once was found, via
screenshots, to suppress the liquid's own color almost completely — a strongly tinted liquid
(copper sulfate blue) rendered visually indistinguishable from clear water. Alpha blending for the
liquid looks correct and legible at every tier, including alongside transmissive glass (see
`docs/screenshots/fluids/02-tinted-liquid.png` vs. the same scene before this was found). Revisit
`createLiquidMaterial`'s transmissive branch (it still works correctly in isolation — see its unit
tests) if nested transmission needs solving later; a likely direction is rendering the liquid into
its own intermediate target rather than relying on three.js's single shared transmission pass.

Labels (graduation ticks, the current-reading tag, instrument readouts) are **not** drei's `<Html>`:
`materials/textSprite.ts` rasterizes text onto a canvas and wraps it as a `THREE.Sprite`. `<Html>`
mounts a nested `ReactDOM` root per label; with several mounting/unmounting together (switching
regression scenarios, apparatus being added or removed), that was found to trigger React 19
"synchronously unmount a root while rendering" console errors. The sprite approach has no nested
DOM/React root, is cheaper to draw (no extra DOM layout/paint), and reads the browser's own system
font stack (no network font fetch, so it works offline and in a sandboxed test run).

## Quality tiers and fallbacks (`quality/fluidQuality.ts`)

| Tier | Glass | Liquid | Lathe segments | Max droplets | Surface animation |
| --- | --- | --- | ---: | ---: | --- |
| `efficient` | alpha | alpha | 22 | 10 | off |
| `balanced` | transmission | alpha | 40 | 24 | on |
| `quality` | transmission | alpha | 64 | 48 | on |

`resolveFluidQuality(tier, device)` demotes to `efficient` regardless of the requested tier when
`device.software` (a CPU rasterizer) or `!device.webgl2` — the shader/capability fallback the brief
asks for. `prefersReducedMotion()`/`shouldAnimateSurface()` turn off the meniscus's continuous
swirl/ripple animation (and only that: the fill level itself is never animated away from the
authoritative volume) when the platform requests reduced motion.

**Resource disposal.** Every component that builds a `THREE.BufferGeometry` or `Material` via
`useMemo` disposes it in a matching `useEffect` cleanup (not relied on implicitly) — see
`GlassVessel.tsx`, `LiquidBody.tsx`, `DropletStream.tsx`, `TextSprite.tsx`, `GraduationMarks.tsx`.

## Droplets (`flow/dropletTiming.ts`, `components/DropletStream.tsx`)

Spawn timing and fall trajectory are pure functions of the authoritative `FluidOutflow` (world-space
`fromPointM`/`toPointM` and `flowRateMlPerS`) and ordinary kinematics (`g = 9.81 m/s²`), never
invented. A flow rate of exactly zero spawns nothing and forgets any fractional drop that had been
accumulating, so resuming flow after a pause never dumps a backlog. An explicit `resetSignal` prop
(bump a counter on a RESET action) clears every in-flight drop instantly; letting flow fall to zero
on its own instead lets already-falling drops land naturally — both behaviors are covered by
`e2e/fluids.spec.ts`.

## The dev harness (`dev/`)

`dev/FluidsDevApp.tsx`, served at `/fluids-lab.html` (a second Vite build entry, see
`vite.config.ts`), renders the production components above against local fixtures
(`dev/fixtures.ts`) instead of a real Agent 06/07 runtime — this is what the acceptance tests'
"regression scenes" and "real running screenshots" are built from. It exposes
`window.__FLUIDS_LAB__` (installed only in dev/e2e builds, mirroring `src/testApi.ts`'s pattern) for
`e2e/fluids-lab.ts`/`fluids.spec.ts`/`fluids.shots.ts`/`fluids.bench.ts`.

Five scenarios, covering every case the brief names: `clear-liquid`, `tinted-liquid`,
`burette-levels` (near-empty + full + three side-by-side vessels, so it is also the transparency
depth-sorting case), `swirling`, and `endpoint-titration` (a burette draining into a flask, with a
manual mL slider and an "open stopcock" drip toggle driving a real droplet stream).

`dev/fixtures.ts`'s `devOnlyTitrationPh` is worth calling out explicitly: it solves the same
strong-acid/strong-base proton/charge balance named in the shared contract's vertical slice
(`[H+]² − C[H+] − Kw = 0`, exact through the equivalence point — verified by its own unit tests to
read pH 7.00 at exactly 25.00 mL for 0.100 mol/L HCl/NaOH, matching the contract's example). It is a
**local fixture for this harness only**; production code must read a live `Observation` from Agent
06, and nothing under `geometry/`, `color/`, `materials/` or `components/` imports from `dev/` at all.

Run it: `npm run dev --workspace @matterlab/web`, then open `/fluids-lab.html`. Screenshots:
`npx playwright test -c playwright.shots.config.ts e2e/fluids.shots.ts` (writes
`docs/screenshots/fluids/`). Benchmark: `npx playwright test -c playwright.bench.config.ts
e2e/fluids.bench.ts` (writes `docs/benchmarks/fluids-benchmark.{md,json}`).

## Tests

- Unit (`vitest`, `*.test.ts` beside each module): 86 tests covering the geometry/color/flow/quality
  math and the material factories. Pure logic only — `vitest`'s `web` project runs in a `node`
  environment (no DOM/WebGL), so `.tsx` components are intentionally thin and are exercised by the
  Playwright suite below instead.
- Behavioral (`e2e/fluids.spec.ts`, 7 tests): every named acceptance test — meniscus/reading
  agreement at 10 mL delivered, droplets tracking flow open/closed/paused/reset, a **real sampled
  pixel** proving the flask's rendered color changes across the endpoint (not just the underlying
  data), every quality tier rendering without console errors, reduced motion.

## Known gaps / integration notes for Agents 02/07/10

- **Apparatus transforms and sockets are out of scope here** (by design — see the brief). Every
  component takes vessel geometry/contents/flow as props and is positioned by its caller.
- **Liquid transmission is disabled pending the nested-transmission fix above.** If Agent 10's
  performance budget allows revisiting it, the unit tests in `materials/liquidMaterial.test.ts`
  already exercise the transmissive branch directly and would catch a regression.
- **Mixing is currently surface-only**: a decorative meniscus swirl/ripple (`agitation` prop), not
  an interior color-streak shader. Noted as a possible follow-up in `geometry/meniscusSurface.ts`.
- The dev harness's camera framing for `burette-levels` fits a (realistically very tall, ~0.55 m)
  50 mL burette's full graduated column; at the default viewport it crops the lowest readings in a
  1600×900 screenshot. A framing/composition detail, not a rendering defect — see
  `docs/screenshots/fluids/03-burette-levels-full-half-near-empty.png`.
