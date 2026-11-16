# Agent 08 — Gameplay, Guided Experiments and Learning

Owned surface: `apps/web/src/lab/challenges/**`. Implements the four required game modes
(Guided Lab, Challenge, Free Experiment, Precision) as data-driven logic plus a working React UI,
built and tested against **fixture data**, because Agents 02/03/04/06/07/09's real surfaces do not
exist in this worktree yet (see `00_SHARED_INTEGRATION_CONTRACT.md` and the sibling `Agent_0x_*.md`
briefs). Everything here is written to the *shape* those agents are expected to publish, with every
assumption called out below for the human orchestrator to reconcile.

## Module map

```
contracts/        STUB mirrors of the shared domain model + an event-stream/highlight contract
                   this surface needs from Agent 07 (events) and Agent 02/03/04 (highlighting).
                   Pure types + one honest "not connected" default. Replace with the real
                   packages/contracts/lab + Agent 07/04 APIs; do not extend ad hoc.
goals/             Declarative GoalPredicate DSL, the pure evaluator, role binding, and
                   `deriveTrialsFromLog` (reconstructs trials from a raw event log).
titrationObjective.ts  The shared vertical-slice objective (contract section 6), shared by
                   Guided/Challenge/Precision; Free Experiment has an empty objective.
hints/             Turns "first unmet step" into a caption + accessible text + highlight targets.
scoring/           Deterministic, five-dimension rubric (setup, instrument operation, endpoint
                   detection, repeatability, interpretation) — a pure function of event/run/trial
                   data, never of render state.
notebook/          Trial table + pH-vs-volume curves + a conclusion, all read off real data.
replay/            Per-trial replay timeline and two-attempt comparison.
templates/         Export/import a guided setup as a portable JSON "lab template".
persistence/       `ChallengeAttemptRepository` (IndexedDB-backed today; swappable), achievements.
demo/              DEMO-ONLY stand-in runtime (see below) — not a contract, not shipped science.
state/             The mode-orchestration zustand store wiring all of the above together.
ui/                React components for all four modes, the notebook, replay/compare, hints,
                   the accessible checklist, and the demo controls.
fixtures/          TEST-FIXTURE-ONLY deterministic titration generator (never imported by runtime
                   logic) used to unit-test everything above.
devPreview.tsx, ../../lab-challenges-preview.html
                   Standalone dev/preview mount (not wired into `App.tsx`) so this surface can be
                   run and clicked through today. Delete once Agent 01/02/10 integrate it for real.
```

## Why a demo runtime exists

The brief requires the goal evaluator and scoring to be built now, independently testable against
fixture data, with stubs flagged for reconciliation. `demo/fixtureRuntime.ts` is a small,
*clearly labelled* `ExperimentRuntimeSource` implementation that lets a person actually place
apparatus, fill reagents, operate a stopcock and mark an endpoint through real choices — not a
scripted replay — so this whole surface can be exercised end-to-end before Agent 07's real runtime
and Agent 06's real solver exist. It:

- uses the same textbook strong-acid/strong-base closed form as the test fixtures (charge + mass
  balance + water autoionization; see the doc comment in `fixtures/strongAcidStrongBaseFixture.ts`)
  purely to produce a plausible pH reading;
- is never imported by `goals/`, `scoring/`, `hints/` or `notebook/`, only by the demo UI;
- shows a persistent on-screen banner saying it is a fixture demo, not a shipped scientific result;
- must be deleted once Agent 07's runtime and Agent 06's solver are wired in — the production code
  path (`useLiveSource()`, the default) instead shows an honest "experiment runtime not connected"
  state rather than fabricating anything.

Try it: `npm run dev --workspace @matterlab/web` (or `npx vite --port <free-port>` from `apps/web`
if 5273 is taken by a sibling agent's dev server) and open `/lab-challenges-preview.html`.

## Flagged integration points (please reconcile)

These are assumptions this surface needs from other agents' real implementations. Each is called
out in code comments at its point of use:

1. **`LabEvent` shape** (`contracts/events.ts`): `ACTION_APPLIED | OBSERVATION_RECORDED | RUN_RESULT
   | SCENE_RESET`, each with a strictly increasing `sequence`. Agent 07's brief already requires an
   "append-only event log"; this is our best-effort shape for it pending `packages/contracts/lab`.
2. **`TRANSFER` action payload**: `{ sourceInstanceId, receiverInstanceId, volumeL }`
   (`goals/context.ts`, `scoring/signals.ts`). Inferred from contract section 4's description of
   what a TRANSFER does; not literally specified field-by-field anywhere.
3. **`SET_VALVE` action payload**: `{ opening: number (0..1) }`, matching Agent 03's brief ("`SET_VALVE`
   range 0..1").
4. **Endpoint marking convention**: a `CUSTOM` action with `payload.kind === 'MARK_ENDPOINT'` and
   `payload.deliveredVolumeL` / `payload.runId` (`goals/trials.ts`). This is the one mechanism used
   to cut "trials" out of a raw event log — Agent 04 (dispatch) and Agent 07 (processing) need to
   agree on it, or tell us the real shape so `deriveTrialsFromLog` can be updated.
5. **`RunResult.solverDiagnostics` keys**: `equivalenceVolumeL`, `titrantMolarityMolPerL`,
   `analyteVolumeL`, `analyteMolarityMolPerL` (`goals/context.ts`, `scoring/signals.ts`). The shared
   contract types `solverDiagnostics` as an open record precisely for method-specific extras, and
   Agent 06's brief lists "equivalence estimate" and "initial concentrations" among the reference
   quantities it must compute — these are the keys we expect them under.
6. **Species identifiers**: `HCl(aq)` / `NaOH(aq)` (`titrationObjective.ts`) stand in for whatever
   resolved chemical species IDs Agent 06 actually publishes.
7. **Apparatus/socket IDs** used only in fixtures/demo (`burette.50ml`, socket ids like `base`,
   `rod`, `barrel`, `jaw`) are illustrative placeholders, not Agent 03's real registry.
8. **Highlighting**: `contracts/highlight.ts` defines `HighlightApi`/`HighlightTarget` for Agent
   02/03/04's real 3D highlight/focus APIs; `NULL_HIGHLIGHT_API` is the honest no-op used until
   then. The hint engine already emits `{kind:'instance'}` vs `{kind:'paletteCategory'}` targets so
   wiring in the real API should not require changing `hints/`.
9. **Persistence**: `persistence/indexedDbStore.ts` is the default `ChallengeAttemptRepository`
   (same pattern as the existing Reaction Laboratory/Discovery Vault). Agent 09's brief calls for a
   `challenge_attempt` table and REST endpoints; swap in an HTTP-backed repository via
   `setAttemptRepository()` without touching any mode/UI code. Added one new IndexedDB store
   (`labAttempts`, `state/db.ts` version 2 → 3) following the existing additive-only versioning
   convention.

## Modes

- **Guided Lab** (`mode: 'guided'`): ordered steps from `titrationObjective.ts`'s `TITRATION_STEPS`
  (stand → clamp → burette → flask → HCl/NaOH prep → stopcock → pH tracking → endpoint), each with
  an accessible instruction, a hint caption, and highlight target roles. `hints/engine.ts` always
  points at the first unmet step.
- **Challenge Mode**: the same step list evaluated as a flat set of success criteria
  (`CHALLENGE_TITRATION_OBJECTIVE`); the UI does not show the stepwise hint overlay by default, only
  the scoring rubric and (optionally) the accessible checklist as a "stuck?" aid.
- **Free Experiment**: `FREE_EXPLORATION_OBJECTIVE` has zero steps — nothing is gated or scored;
  any real observation still carries its evidence label honestly.
- **Precision Mode**: `PRECISION_TITRATION_OBJECTIVE` requires `requiredTrials: 3`; repeatability is
  scored from the spread of marked endpoint volumes across trials (relative standard deviation).

## Scoring rubric

`scoring/rubric.ts` → `scoreAttempt(objective, ctx)`, a pure function over
`{ scene, events, runResults, trials }`. Five weighted dimensions (setup 0.25, instrument operation
0.20, endpoint detection 0.25, measurement repeatability 0.15, interpretation 0.15), each carrying
its own evidence label (never a bare number) and a plain-language reason. Calling it twice on the
same saved data always returns byte-identical output (`rubric.test.ts` asserts this directly) — a
score cannot change from a visual re-render, camera move, or animation.

## Accessibility

- The ordered checklist (`ui/AccessibleChecklist.tsx`) is the non-3D guided path: every step's
  status is said in words ("Done" / "Current step" / "Not yet"), never only by colour or icon.
- Hint captions and `accessibleText` always carry the full instruction on their own.
- `challenges.css` keeps `prefers-reduced-motion` support (relying on the existing global rule in
  `app.css`) plus its own in-app "Reduced motion" toggle independent of the OS setting.
- Focus-visible outlines on every interactive element; comparison metrics say "(better)" in text,
  not only via colour.

## What was verified

- `npx vitest run src/lab/challenges` — 11 files, 34 tests, all passing (goal evaluator, scoring
  rubric incl. determinism/overshoot/RSD cases, hint engine, notebook builder, replay timeline,
  attempt comparison, template round-trip, in-memory persistence + achievements, the orchestration
  store, and the demo runtime's `useSyncExternalStore` contract).
- `npm run typecheck --workspace @matterlab/web` passes with no errors.
- Manually driven in a real browser (`lab-challenges-preview.html`) through a full Guided Lab
  titration: assembly → reagent prep → stopcock → pH tracking → endpoint at 25.00 mL (pH 7.00,
  matching Agent 06's stated benchmark) → score 68% "Proficient" → notebook with a real pH-vs-volume
  curve and conclusion → saved attempt → achievements unlocked → mode switch to Challenge/Free/
  Precision without errors.

## What is not done

- No real 3D highlighting, apparatus placement or stopcock interaction — those are Agent 02/03/04's
  surfaces and do not exist in this worktree.
- Not connected to a real Agent 07 event stream or Agent 06 solver; `useLiveSource()` (the
  production default) honestly reports "not connected" rather than faking data.
- Attempts persist locally (IndexedDB) only; no Agent 09 backend call.
- No Playwright E2E specs: there is no real 3D app shell yet for them to drive. Covered instead by
  vitest + the manual browser walkthrough above.
- Only the strong-acid/strong-base titration objective exists; weak acid/base, buffer and other
  templates are out of scope for this session.
- Visual design reuses the existing v1 app's tokens (`styles/app.css`) rather than a bespoke
  Awwwards-level "Astra" identity, which is Agent 01's surface.
