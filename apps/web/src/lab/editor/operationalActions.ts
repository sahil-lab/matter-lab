/**
 * Converts operational gestures (dragging a stopcock, pressing "fill", nudging a stirrer speed,
 * seating a pH probe, triggering a pipette) into typed `LabAction`s dispatched straight to
 * `actionSink` — brief item 4. These are **experiment events, not editing commands**: unlike
 * everything in `commands.ts`, none of them touch `EditorSceneState` or the undo history (brief
 * item 5). The gesture controller and the operational HUD are the only callers; nothing here reads
 * or writes `ContainerContents` directly, it only asks the reducer to.
 */
import { actionSink } from './actionSink';
import type { LabActionDispatchResult } from './actionSink';
import type { LabAction, UUID } from './contracts';
import { newUUID } from './contracts';
import { SUPPORTED_TEMPERATURE_K } from '../experiments/strongAcidBaseModel';

function dispatch(targetInstanceId: UUID, type: LabAction['type'], payload: object): LabActionDispatchResult {
  return actionSink.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId, type, payload: payload as unknown as Record<string, unknown> });
}

/** Drag/click on a burette (or any `FLOW_SOURCE`) stopcock; `openFraction` is clamped by the reducer, not here, so a UI slider can report values transiently outside 0..1 while dragging. */
export function setValve(instanceId: UUID, openFraction: number): LabActionDispatchResult {
  return dispatch(instanceId, 'SET_VALVE', { openFraction });
}

/** Fills (or tops up) a container with a declared virtual educational reagent. */
export function fillContainer(instanceId: UUID, speciesId: string, concentrationMolPerL: number, volumeL: number, temperatureK: number = SUPPORTED_TEMPERATURE_K): LabActionDispatchResult {
  return dispatch(instanceId, 'FILL', { speciesId, concentrationMolPerL, volumeL, temperatureK });
}

/** A manual transfer (pipette dispense, pour) between two containers, outside the automatic metered-valve flow. */
export function transfer(fromInstanceId: UUID, toInstanceId: UUID, volumeL: number): LabActionDispatchResult {
  return dispatch(fromInstanceId, 'TRANSFER', { fromInstanceId, toInstanceId, volumeL });
}

export function startStirrer(instanceId: UUID, speed: number): LabActionDispatchResult {
  return dispatch(instanceId, 'START_STIRRER', { speed });
}

/** Seats (or removes, at `immersionDepthM = 0`) a pH probe into a container. */
export function setProbe(instanceId: UUID, immersionDepthM: number, intoInstanceId?: UUID): LabActionDispatchResult {
  return dispatch(instanceId, 'SET_PROBE', { immersionDepthM, intoInstanceId });
}

/** Pause/resume/reset the running experiment — never editor undo/redo (see `commands.ts`'s module comment). */
export function resetExperiment(scope: 'station' | 'all', stationId?: UUID): LabActionDispatchResult {
  return dispatch(stationId ?? 'all', 'RESET', { scope, stationId });
}
