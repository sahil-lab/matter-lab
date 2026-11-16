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

Limits: 4 MiB UTF-8, 8 attempts, 30 trials per attempt, 20,000 accepted events and 20,000
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

Initial pure-format milestone: five focused persistence tests, web TypeScript check, and native
Node import passed. Runtime-backed scoring, components, and integrated journeys are validated
in the subsequent implementation; this milestone does not claim an end-to-end UI journey.
