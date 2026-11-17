# Agent 08 — Gameplay, Guided Experiments and Learning

Owned surface: `apps/web/src/lab/challenges/**`. Implements the four required game modes
(Guided Lab, Challenge, Free Experiment, Precision) as data-driven logic plus a working React UI.

**Integration status: genuinely wired to real sibling code**, not fixture data. This surface now
runs against:

- Agent 07's real `packages/contracts/lab` domain model and his real `ExperimentEngine`
  (`apps/web/src/lab/experiments/**`, vendored from his branch into this one);
- Agent 06's real titration solver (`services/science/titration/**`, vendored from his branch),
  called through a small CLI bridge this surface added — never a locally fabricated pH;
- Agent 07's own "best-effort" vertical-slice apparatus registry (not yet Agent 03's richer,
  field-for-field instrument library — see "Flagged integration points" below).

Everything that is still a stand-in (3D placement/drag-and-drop, Agent 03's full apparatus shape,
Agent 09's persistence backend) is called out explicitly below for the human orchestrator/Agent 10
to reconcile. Nothing here silently pretends a stand-in is the real thing.

## Module map

```
contracts/          Re-exports the real `@matterlab/contracts` package (Agent 07/09's shared lab
                     domain model: ExperimentScene, LabAction, LabEventRecord, Observation, RunResult,
                     SolverClient, ...), plus this surface's own small additions:
                     `ExperimentRuntimeSource` (a read view shaped to match `ExperimentEngine`) and
                     `HighlightApi` (still a stub pending Agent 02/03/04's real highlight API).
goals/               Declarative GoalPredicate DSL, the pure evaluator, role binding, and
                     `deriveTrialsFromLog` (reconstructs trials from the real event log +
                     observation ledger — the real contract keeps these as two separate flat lists,
                     not one unified stream).
titrationObjective.ts  The shared vertical-slice objective (contract section 6), shared by
                     Guided/Challenge/Precision; Free Experiment has an empty objective. Species ids
                     (`hydrochloric-acid`, `sodium-hydroxide`) match Agent 06's real registry.
hints/               Turns "first unmet step" into a caption + accessible text + highlight targets.
scoring/             Deterministic, five-dimension rubric (setup, instrument operation, endpoint
                     detection, repeatability, interpretation) — a pure function of the real event
                     log / observations / trial data, never of render state.
notebook/            Trial table + pH-vs-volume curves + a conclusion, all read off real data.
replay/              Per-trial replay timeline (merges the real action log and observation ledger
                     back into one chronological scrub) and two-attempt comparison.
templates/           Export/import a guided setup as a portable JSON "lab template".
persistence/         `ChallengeAttemptRepository` (IndexedDB-backed today; swappable), achievements.
integration/         The real-engine wiring this surface added:
                       - `realEngineSource.ts` — `RealEngineRuntimeSource`, a role-keyed convenience
                         wrapper around one real `ExperimentEngine` station (assemble, fill, operate
                         the stopcock, delivery, mark endpoint), implementing
                         `ExperimentRuntimeSource`. Replaces the old `FixtureDemoRuntime`.
                       - `solverBridgeProtocol.ts` — shared request/response mapping between Agent
                         07's `SolverClient` contract and the JSON protocol the Python bridge speaks.
                       - `pythonSolverClient.ts` — Node-only `SolverClient` (vitest, Vite dev
                         middleware) that spawns the bridge script directly.
                       - `httpSolverClient.ts` — browser-side `SolverClient` that calls the dev-only
                         `/__agent08__/titration-solve` route.
                       - `titrationSolverDevMiddleware.ts` — the Vite plugin (wired into
                         `apps/web/vite.config.ts`) that proxies that route to the same bridge script.
state/               The mode-orchestration zustand store wiring all of the above together;
                     `useRealEngineSource(solver)` is the one production entry point.
ui/                  React components for all four modes, the notebook, replay/compare, hints, the
                     accessible checklist, and `EngineControls` (manual bench buttons standing in
                     for Agent 02/03/04's real 3D interaction — every button dispatches a real
                     `LabAction`, nothing here is scripted).
fixtures/            TEST-FIXTURE-ONLY deterministic titration generator (never imported by runtime
                     logic), shaped exactly like the real `LabEventRecord`/`Observation` contract,
                     for fast unit tests that do not need a running engine or a spawned Python
                     process.
devPreview.tsx, ../../lab-challenges-preview.html
                     Standalone dev/preview mount (not wired into `App.tsx`) so this surface can be
                     run and clicked through today. Delete once Agent 01/02/10 integrate it for real.
```

## Running the real chemistry locally

The Python bridge only needs `scipy` (no RDKit/PySCF/FastAPI): from `services/science/`,
`python agent08_titration_solver_bridge.py` reads one JSON request from stdin and writes Agent 06's
real `SolveResult` to stdout. `npm run dev --workspace @matterlab/web` (or
`npx vite --port <free-port>` from `apps/web` if 5273 is taken) starts the Vite dev server with the
`/__agent08__/titration-solve` middleware already wired in, so the browser preview
(`/lab-challenges-preview.html` → "Start experiment engine") reaches the real solver with no extra
setup. Set `AGENT08_PYTHON` if `python` is not the right executable on a given machine.

## Flagged integration points (please reconcile)

Resolved during this integration pass (no longer flagged): the event/observation shape (now the
real `LabEventRecord`/`Observation` from `@matterlab/contracts`), the `TRANSFER`/`SET_VALVE`/`FILL`
action payload field names (now Agent 07's actual `toInstanceId`/`valveOpening`/`species`), the
endpoint-marking convention (`CUSTOM` + `payload.kind === 'MARK_ENDPOINT'`, matched against Agent
07's real engine), and the species identifiers (now Agent 06's real `hydrochloric-acid` /
`sodium-hydroxide`).

Still open:

1. **Agent 03's real apparatus registry.** This surface drives Agent 07's own placeholder
   vertical-slice registry (`apps/web/src/lab/experiments/registry/verticalSliceDefinitions.ts`,
   `isPlaceholder: true` throughout), not Agent 03's richer, asset-backed definitions. One real
   number was already reconciled (the burette's `maxFlowRateLPerS` patched from 0.005 to 0.002 to
   match Agent 03's shipped `BURETTE_50ML_CLASS_A` spec — see the "AGENT 08 RECONCILIATION NOTE" in
   that file); a full field-for-field adapter (ids, sockets, capabilities, 3D assets) is a larger
   undertaking flagged for Agent 10/the human orchestrator.
2. **Agent 02/04's real 3D placement, drag-and-drop and stopcock interaction.** `ui/EngineControls.tsx`
   is a clearly labelled manual-button stand-in; every button dispatches a genuine `LabAction`
   through the real engine, so swapping in the real 3D interaction layer should only mean calling
   the same `RealEngineRuntimeSource` methods (or the underlying action builders) from different UI,
   not touching goal/scoring/notebook logic.
3. **Agent 06/07 methodId mismatch.** Agent 07's titration plugin stamps solver requests with
   `methodId: 'strong-acid-strong-base-v1'`; Agent 06's real solver uses its own
   `model_id: 'monoprotic-acid-base-electroneutrality-v1'` and ignores the requested one (each was
   built independently without seeing the other's branch). `solverBridgeProtocol.ts` does not force
   alignment — the recorded `Observation.methodId` is whatever Agent 06's solver actually used. Not
   a correctness bug (the real chemistry is still real), but worth the two agents reconciling the
   id string itself.
4. **Agent 09's persistence backend.** `persistence/indexedDbStore.ts` remains the default
   `ChallengeAttemptRepository` (local only). Swap in an HTTP-backed repository via
   `setAttemptRepository()` without touching any mode/UI code once Agent 09's API exists.
5. **Highlighting.** `contracts/highlight.ts`'s `HighlightApi`/`NULL_HIGHLIGHT_API` remain a stub
   pending Agent 02/03/04's real 3D highlight/focus API.

## Two real bugs this integration pass found and fixed

Both were latent in the original fixture-only implementation and only surfaced once goal evaluation
ran against a real, continuously-mutating engine scene instead of a static hand-built fixture scene:

- **Dilution silently un-satisfied "prepare the aliquot/titrant".** `containerSpecies` originally
  read the vessel's *current* (live) molarity. In a real titration, `TRANSFER` genuinely dilutes the
  flask as titrant is added (the inventory ledger conserves moles, not concentration), so a step
  that was correctly met right after filling would flip back to unmet once titration began. Fixed by
  `firstFilledMolarityOfSpecies` (`goals/context.ts`): checks the concentration as actually charged
  in by the vessel's own first `FILL` action, not the live, dilutable scene state.
- **Every dispatched action shared the same (zero) simulation time.** `RealEngineRuntimeSource`
  initially read `atSimulationS` off the station's fixed-tick clock, which only advances via
  `tick()`/`advance()` — this source never calls either (it dispatches manual, immediate actions),
  so every action got `atSimulationS: 0`. That collapsed `deriveTrialsFromLog`'s time-based
  observation slicing (every trial's own observations bled into trial 1) and broke replay ordering.
  Fixed with `RealEngineRuntimeSource`'s own monotonically increasing counter
  (`advanceSimulationS()`), stepped by the scene's own declared tick size.

## Modes

- **Guided Lab** (`mode: 'guided'`): ordered steps from `titrationObjective.ts`'s `TITRATION_STEPS`
  (stand → clamp → burette → flask → connect fluid path → HCl/NaOH prep → stopcock → pH tracking →
  endpoint), each with an accessible instruction, a hint caption, and highlight target roles.
  `hints/engine.ts` always points at the first unmet step.
- **Challenge Mode**: the same step list evaluated as a flat set of success criteria
  (`CHALLENGE_TITRATION_OBJECTIVE`); the UI does not show the stepwise hint overlay by default, only
  the scoring rubric and (optionally) the accessible checklist as a "stuck?" aid.
- **Free Experiment**: `FREE_EXPLORATION_OBJECTIVE` has zero steps — nothing is gated or scored;
  any real observation still carries its evidence label honestly.
- **Precision Mode**: `PRECISION_TITRATION_OBJECTIVE` requires `requiredTrials: 3`; repeatability is
  scored from the spread of marked endpoint volumes across trials (relative standard deviation).

## Scoring rubric

`scoring/rubric.ts` → `scoreAttempt(objective, ctx)`, a pure function over
`{ scene, events, observations, trials }`. Five weighted dimensions (setup 0.25, instrument
operation 0.20, endpoint detection 0.25, measurement repeatability 0.15, interpretation 0.15), each
carrying its own evidence label (never a bare number) and a plain-language reason. Calling it twice
on the same saved data always returns byte-identical output (`rubric.test.ts` asserts this
directly) — a score cannot change from a visual re-render, camera move, or animation.

## Accessibility

- The ordered checklist (`ui/AccessibleChecklist.tsx`) is the non-3D guided path: every step's
  status is said in words ("Done" / "Current step" / "Not yet"), never only by colour or icon.
- Hint captions and `accessibleText` always carry the full instruction on their own.
- `challenges.css` keeps `prefers-reduced-motion` support (relying on the existing global rule in
  `app.css`) plus its own in-app "Reduced motion" toggle independent of the OS setting.
- Focus-visible outlines on every interactive element; comparison metrics say "(better)" in text,
  not only via colour.

## What was verified

- `npx vitest run src/lab/challenges` — 11 files, 33 tests, all passing (goal evaluator, scoring
  rubric incl. determinism/overshoot/RSD cases, hint engine, notebook builder, replay timeline,
  attempt comparison, template round-trip, in-memory persistence + achievements, the orchestration
  store driving a real `ExperimentEngine`, and `integration/realEngineSource.test.ts` — the one test
  that spawns the real Python bridge and asserts pH ≈ 7.00 at the 25.00 mL equivalence point with
  `evidence: 'MODEL_CALCULATED'` and Agent 06's own `methodId`, not a fabricated number).
- `npx vitest run` from the repo root — 73 files, 2521 tests across every workspace, all passing
  except one unrelated, pre-existing, non-reproducible timing flake in `@matterlab/forcefield`'s own
  performance test (confirmed untouched by this branch and passing cleanly when re-run in
  isolation — CPU contention from 73 parallel vitest workers, not a regression).
- `npm run typecheck` (root, all six workspaces) passes with no errors.
- Manually driven in a real browser (`lab-challenges-preview.html`, real engine + real HTTP bridge +
  real Python solver, no fixture/demo code involved) through a full Guided Lab titration: assembly →
  reagent prep → fluid connection → stopcock → pH tracking (pH rose 1.00 → 1.31 → 1.72, then jumped
  to 11.00 just past the 25.00 mL equivalence point — the real strong-acid/strong-base S-curve, not
  a scripted shape) → endpoint marked at 25.50 mL vs. a computed equivalence of 25.00 mL → score 48%
  "Developing" → notebook with a real pH-vs-volume curve and conclusion → attempt saved to IndexedDB
  → "First titration" achievement unlocked.

## What is not done

- No real 3D placement, drag-and-drop or stopcock interaction — `ui/EngineControls.tsx` is a
  clearly labelled manual-button stand-in; Agent 02/04 own the real surface (see "Flagged
  integration points" above for how little should need to change when it lands).
- Not reconciled against Agent 03's real, richer apparatus registry — currently drives Agent 07's
  own placeholder vertical-slice definitions (one real number patched in; the rest flagged).
- Attempts persist locally (IndexedDB) only; no Agent 09 backend call.
- No Playwright E2E specs: there is no real 3D app shell yet for them to drive. Covered instead by
  vitest (including the real-solver-bridge integration test) + the manual browser walkthrough above.
- Only the strong-acid/strong-base titration objective exists; weak acid/base, buffer and other
  templates are out of scope for this session.
- Visual design reuses the existing v1 app's tokens (`styles/app.css`) rather than a bespoke
  Awwwards-level "Astra" identity, which is Agent 01's surface.
