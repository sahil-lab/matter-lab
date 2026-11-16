export type * from './types';
export { LabCanvas } from './LabCanvas';
export type { LabCanvasProps } from './LabCanvas';
export { LabWorld, LabStationGroup } from './LabWorld';
export { Workbench } from './Workbench';
export type { WorkbenchProps } from './Workbench';
export { createWorkbenchModel, measureWorkbenchModel } from './workbenchGeometry';
export { LabCameraController, createLabCameraController } from './CameraController';
export type { CameraSnapshot } from './CameraController';
export { CameraDirector } from './CameraDirector';
export type { CameraDirectorProps } from './CameraDirector';
export { LabCameraProvider, useLabCamera, useCameraSnapshot, useReducedMotion } from './CameraModes';
export { LabViewportControls } from './LabViewportControls';
export { LAB_CAMERA_MODES, CAMERA_LIMITS, DEFAULT_CAMERA_VIEW, fitCameraToBounds, cameraViewForMode } from './cameraMath';
export {
  LAB_UNITS, IDENTITY_LAB_TRANSFORM, WORKBENCH_METRICS,
  createFloorSurface, createWorkbenchSurface, intersectPlacementSurface,
  surfaceLocalToWorld, surfaceWorldToLocal, rayFromViewport, projectWorldPoint, transformBounds, boundsCenter,
} from './coordinates';
export { PlacementSurfaceProvider, PlacementSurfaceMesh, usePlacementSurfaces } from './placement';
export type { PlacementSurfaceMeshProps } from './placement';
export { EnvironmentLighting } from './EnvironmentLighting';
export { ViewportGrid } from './ViewportGrid';
export {
  ROOM_PRESETS, STUDIO_NAVIGATION_BOUNDS, stationLayoutAnchors,
  defaultEnvironmentSnapshot, parseEnvironmentSnapshot, serializeEnvironmentSnapshot,
} from './RoomConfig';
export type { EnvironmentSnapshot, RoomConfiguration } from './RoomConfig';
export { SceneQualityProvider, SceneMetrics, LabDistanceLOD, useSceneQuality } from './SceneQuality';
export { SCENE_QUALITY } from './qualityMath';
export type { SceneQualitySettings } from './qualityMath';
export { SceneResourceScope, createSceneAssetPool } from './SceneResourceManager';
export type { DisposableSceneResource, SceneAssetLease } from './SceneResourceManager';
export { ENVIRONMENT_VISUAL_CASES, EnvironmentTestScene, LightingReferenceRig } from './EnvironmentTestScene';
export type { EnvironmentVisualCase } from './EnvironmentTestScene';
