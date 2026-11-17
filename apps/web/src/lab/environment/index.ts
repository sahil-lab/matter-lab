/**
 * Public API of Agent 02's 3D environment: world-coordinate/placement primitives, camera modes
 * and the imperative camera API, scene-quality presets, room/lighting configuration and
 * serialization, GPU resource lifecycle helpers, multi-station layout, and the React components
 * that assemble them (`LabWorld`, `CameraDirector`, `EnvironmentLighting`, `Workbench`,
 * `ViewportGrid`, `LightingTestRig`). See `docs/lab-environment.md` for the full guide.
 *
 * Deliberately not exported: `dev/DevApparatusStub`, a placeholder used only by this package's own
 * harness and screenshots, never by production code.
 */
export * from './types';
export * from './coordinates';
export * from './stations';
export * from './cameraModes';
export * from './cameraDirectorApi';
export * from './CameraDirector';
export * from './SceneQuality';
export * from './SceneResourceManager';
export * from './FrameInstrumentation';
export * from './AdaptiveResolution';
export * from './RoomConfig';
export * from './EnvironmentLighting';
export * from './LabEffects';
export * from './Workbench';
export * from './ViewportGrid';
export * from './LightingTestRig';
export * from './LabWorld';
export * from './environmentStore';
export * from './environmentActions';
