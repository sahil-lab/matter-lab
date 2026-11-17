/**
 * Re-exports the real `@matterlab/contracts` package (Agent 07/09's shared lab domain model),
 * plus this surface's own small additions: `ExperimentRuntimeSource` (an Agent-07-engine-shaped
 * read view) and `HighlightApi` (still a stub pending Agent 02/03/04's real highlight/focus APIs).
 *
 * This file used to define its own byte-for-byte copy of the shared domain model; now that Agent
 * 07 has published the real package, everything scene/event/action/observation-shaped comes from
 * there directly so there is exactly one definition in the repository, not two that could drift.
 */
export * from '@matterlab/contracts';
export * from './runtimeSource';
export * from './highlight';
