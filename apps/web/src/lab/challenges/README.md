# Learning sidecar

This directory owns learning, never apparatus inventory or chemistry. The runtime reader is
the only input for applied actions and observations. UI action requests must be routed to the
real editor/runtime; a successful callback or “Next” is not completion evidence.

## Integration

Create one `createChallengeController` **before** the first preparation/editor action, outside
React render. Supply:

- `reader: LabRuntimeReader` from Agent07.
- `definitions: ApparatusDefinitionReader` from the actual apparatus registry.
- `definition: TITRATION_CHALLENGE`, `stationId`, and explicit `bindings` for `stand`, `clamp`,
  `burette`, `receiver`, and `probe`. Automatic binding only accepts an unambiguous match.
- `reference: createLearningReference({ id, result, preparations })`. `result` is Agent06's
  `getTitrationReference(...)`; each preparation is `{role,label,sourceId,result}` with an actual
  successful `prepareSolution(...)` result. The `sourceId` must match the later FILL preparation.
- `getSupport(snapshot, stationId): ModelSupport`, delegated to the real runtime/plugin.
- Optional `mode`, saved `attempt`, and deterministic `createId`/`now` for tests.

Public controller methods: `getSnapshot`, `subscribe`, `setMode`, `setInstructionIndex`,
`dismissGuide`, `requestHint`, `recordReading(observationId, liters)`,
`captureEndpoint({observationId,basis,note?})`, `recordConclusion(conclusion, trialId?)`,
`setNotes(notes, trialId?)`, `beginTrial`, `exportAttempt`, and `dispose`.

`getSnapshot()` is stable between changes and is suitable for `useSyncExternalStore`.
Dispose the controller when the runtime is replaced, not whenever a panel is hidden.
Instructions can be skipped. Only predicates decide completion.

### Shell components and editor callbacks

`index.ts` exports the public browser API. Put
`<LabGuidedTutorial controller={controller} onHighlight={...} onActionRequest={...} />` in
Agent01's `LabShell.tutorial` slot. It renders only for Guided mode when not dismissed.
The shell's `onRequestTutorial` can call `controller.dismissGuide(false)`.
`LabEntry.onEnter('guided')` can call `controller.setMode('guided')`; `'explore'` maps to `'free'`.

Put `<LabLearningPanel controller={controller} ... />` in a shell inspector/timeline slot.
Its optional callbacks are `onHighlight`, `onActionRequest`, `onExportNotebook`,
`onExportTemplate`, and an injected `createId` for new template IDs.

- `onHighlight({instanceIds,controlId?,caption,focus,reducedMotion})` maps to
  `editor.setTutorialHighlight(instanceIds)`. Explicit focus may use `editor.select` /
  `focusSelection`, respecting the supplied reduced-motion flag. Use `data-control-id` to
  focus a real inspector control when present; no nonexistent interactor ID is invented.
- `onActionRequest({kind,instanceIds,role?,goalId?,controlId?})` opens real accessible editor
  controls (`place|connect|prepare|read|operate`) or requests a runtime station `reset`.
  The callback's completion does **not** award progress. Multiple current-run apparatus
  matching a role require explicit bindings rather than picking an arbitrary catalog entry.
- `onExportNotebook(document)` receives a complete `MATTERLAB_TRIAL_NOTEBOOK` JSON-compatible
  document, including the validated learningState, source records, row summaries and plot
  samples. The host performs download/backend storage; this component does not use localStorage.
- `onExportTemplate(assembly)` receives a validated canonical `ExperimentAssembly` containing
  this station's empty apparatus layout, never inventory, observations or scores.

The notebook includes native keyboard controls, an accessible plot table, notes, structured
conclusions and read-only ledger replay. `TrialNotebook`, `EvidenceReplay`, `TrialPlot`,
`LearningModeChooser`, `trialPlotPoints`, `trialReplayFrames`, `compareTrialPair`,
`buildTrialNotebook`, and `createGuidedTemplate` are also exported for custom shell slots.
Ledger replay is **not** a claim that a 3D station has been resimulated; runtime checkpoint
reexecution remains Agent07/09's concern. Comparison across stations may be displayed when
references match but never satisfies same-run/station repeated-trial scoring.

## Durable format / Agent09

Import **`persistence.ts` directly** on Node; it has no React, browser, worker, or GPU dependency.
It exports `parseLearningState(unknown)`, `parseLearningStateJson(string)`,
`serializeLearningState(state)`, `parseChallengeAttempt`, `parseChallengeDefinition`,
`parseLearningReference`, `LearningStateError`, `LEARNING_STATE_LIMITS`, and
`learningStateJsonSchema` (standalone JSON Schema including canonical contract definitions).

```ts
learningState: {
  schemaVersion: 1,
  kind: 'MATTERLAB_LEARNING_STATE',
  attempts: [{
    schemaVersion: 1,
    kind: 'MATTERLAB_CHALLENGE_ATTEMPT',
    id, definition, mode, createdAt, updatedAt, activeTrialId, requestedBindings,
    progression: { instructionIndex, dismissed, hintsRequested },
    trials: [{
      id, scope: { runId, stationId, epoch }, status, startedAt,
      startedAtSequence, cursorSequence, bindings,
      initialContainerStates, initialTransferVolumeL,
      frame, definitions, support, reference, appliedEvents, observations,
      readings, endpoint, conclusion, notes
    }]
  }]
}
```

Exact types are in `types.ts`. `frame` contains `RuntimeSnapshot` fields except observations,
which are stored once in the trial's immutable observation array. The definition, rubric,
apparatus definitions and science reference are pinned. No score or completion counter is
trusted or persisted. `evaluateTrial` derives scores; `deriveAchievements` derives achievements.

Limits: 4 MiB UTF-8, one attempt per supported station (currently 32), 30 trials per attempt, 20,000 accepted events and 20,000
observations across a sidecar. Oversize evidence is rejected, never silently truncated.
Unknown versions, duplicate JSON keys, unsafe values, foreign run/station/epoch records,
repeated scopes/action IDs, and mismatched endpoint claims are rejected.

This is **client/draft metadata**, not authenticated server-run evidence. Structural validation
cannot prove that a client did not fabricate a JSON file. Persist it atomically with the scene
and checkpoint under Agent09's revision rules; do not promote it to authoritative run results.
Scene duplication/template instantiation must clear attempts and runtime history.

## Evidence and assessment

- Receipt identity, sequence, epoch, target station and APPLIED status must agree.
- Graph predicates use registered capabilities, compatible enabled sockets, capacity,
  mounting and actual world-space socket alignment, not catalog labels or proximity alone.
- Known preparations require accepted FILL events with the supplied science-produced contents
  in initially empty vessels. Extra fills and foreign transfers invalidate preparation.
- Probe evidence requires its real sensor connection, accepted SET_PROBE and a subsequent
  receiver pH observation from the pinned science method/version.
- Accepted delivery must reconcile with the observation's cumulative titration metadata.
- Endpoint capture requires setup/preparation/sensor/operation predicates, a closed stopcock,
  and the latest supported receiver solve at the current delivered volume. An old reading
  cannot erase an overshoot. No pH threshold or rendered indicator color completes a goal.
- A captured trial is frozen. RESET's receipt belongs to the old epoch; the new snapshot starts
  another trial. Returning to the same scope or replaying observations cannot count twice.
- Repeated-trial scoring only uses distinct epochs in the same run and station with identical
  science targets. Archived trial scores only use earlier/current trials, not later additions.
- Mean, sample standard deviation (`n-1`), range and deviation from a supplied target are
  descriptive statistics. No experimental uncertainty or confidence interval is inferred.
- Concentration answers are compared with Agent06's supplied reference; no chemistry is solved
  here. Structured interpretation criteria are scored; free text is not automatically verified.

Guided/Challenge/Precision assess the same evidence with different instruction/replication
requirements. Free Experiment has no forced objective or score and retains unsupported states.

## Validation status

Current bounded handoff: 16 focused tests pass (strict persistence, receipt/graph guards,
SSR accessibility, native keyboard controls and replay-key behavior, reduced-motion hints).
Web TypeScript checking, an in-memory Vite build of the public browser entry, and a native Node
parser import pass. No browser/GPU server was started. Real-runtime endpoint/overshoot/repeat
tests and the composed empty-scene guided journey remain separate integration gates;
SSR checks do not claim that a full keyboard/browser or 3D journey was executed.
