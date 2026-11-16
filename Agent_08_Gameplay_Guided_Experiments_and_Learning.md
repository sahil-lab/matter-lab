# MATTER LAB — AGENT 08: GAMEPLAY, GUIDED EXPERIMENTS AND LEARNING

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 08 — Game Experience Designer / Engineer**. Turn the working lab into an engaging, polished scientific game that teaches correct experimental reasoning without turning measurements into arcade fiction.

## Owned surfaces
`apps/web/src/lab/challenges/**`: tutorial steps, interaction hints, goal evaluation, experiment selection, scoring, notebook progression UI and replay comparison. Style via Agent 01 design system; consume Agent 07 real event stream and Agent 06 scientific results.

## Required modes
1. **Guided Lab**: assemble stand→clamp→burette→flask; prepare specified HCl/NaOH educational titration; calibrate/read instruments; operate stopcock; determine endpoint; read graph; explain concentration.
2. **Challenge Mode**: provide target and materials but no step-by-step overlay; assess correct setup, appropriate use of sensors, measurement repeatability and conclusion quality.
3. **Free Experiment**: user can build many independent setups with no forced objective; unsupported scientific models clearly marked.
4. **Precision Mode**: multiple trials and objective scientific scoring against actual observations/uncertainty. Support replay and comparison.

## Required implementation
- Build declarative, data-driven goal definitions (not scene-specific condition spaghetti). Example predicates: `hasConnection(stand,clamp)`, `buretteMounted`, `flaskLocatedBelow`, `deliveredVolumeWithin`, `endpointCaptured`, `repeatTrials>=3`.
- Create context-sensitive hints that highlight actual objects and interactors via Agents 02/03/04 APIs. Provide skippable instruction sequences and readable captions.
- Implement measured scoring rubric: apparatus setup, instrument operation, endpoint detection, repeated-measurement variance and interpretation. Avoid scoring purely by arbitrary dramatic animations.
- Teach difference between equivalence point and indicator endpoint; show appropriate error feedback if user overshoots or misreads meniscus.
- Store achievements and trial progression without altering authoritative experiment observations; Agent 09 owns persistence.
- Create mini-lab notebook with trial table, plots and a short scientific conclusion tied to real outputs. Provide a non-3D accessible guided path where needed.
- Build friendly replay and compare view; allow guided setup to be exported as a custom reusable template.

## Collaboration
Agent 01 supplies UI styles; Agent 04 supplies highlighting/select APIs; Agent 07 supplies typed events and observation stream; Agent 06 supplies benchmark/truth; Agent 09 stores attempts and scores; Agent 10 checks E2E correctness.

## Acceptance tests
- New user can finish guided titration from empty setup, including physical manipulation of apparatus.
- Challenge succeeds only on valid observed actions, not clicking Next; wrong/unsupported setups provide meaningful guidance.
- Precision scores are reproducible from saved scientific event logs; cannot change after visual re-render.
- User can replay, compare two trials and export a complete lab notebook.
- Hints/animations respect reduced-motion and keyboard input; no dependence on color alone.

## Deliverables
Working game modes, data-driven objectives, scoring tests, tutorial content, saved attempt format, user-journey screenshots and integration notes.
