import type { ReactNode } from 'react';

/** Render-only coordinates, structurally compatible with contracts.Vec3M/Transform. */
export type WorldPointM = readonly [number, number, number];
export type LabQuaternion = readonly [number, number, number, number];
export interface LabTransform {
  readonly positionM: WorldPointM;
  readonly quaternion: LabQuaternion;
}
export interface LabBoundsM {
  readonly minM: WorldPointM;
  readonly maxM: WorldPointM;
}

export type LabWorldMode = 'room' | 'studio';
export type LabCameraMode = 'orbit' | 'first-person' | 'top-down' | 'inspection';
export type SceneQualityPreset = 'low' | 'balanced' | 'high';
export type LightingPreset = 'daylight' | 'evening' | 'neutral';
export type RoomPreset = 'compact' | 'teaching' | 'gallery';
export type LabRendererPreference = 'auto' | 'webgl2' | 'webgpu';
export type LabRendererBackend = 'webgl2' | 'webgpu';

export interface LabStation {
  readonly id: string;
  readonly label: string;
  readonly boundsM: LabBoundsM;
  readonly accent?: string;
}

export interface LabCameraView {
  readonly mode: LabCameraMode;
  readonly positionM: WorldPointM;
  readonly targetM: WorldPointM;
  readonly fovDeg: number;
  /** Full vertical span, not pixels and not camera.zoom. */
  readonly orthographicHeightM: number;
}
export interface CameraBookmark {
  readonly id: string;
  readonly name: string;
  readonly view: LabCameraView;
  readonly stationId?: string;
}
export interface WorldRayM {
  readonly originM: WorldPointM;
  readonly direction: WorldPointM;
}
export interface ProjectedPoint {
  readonly clientX: number;
  readonly clientY: number;
  readonly visible: boolean;
}
export interface ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface PlacementSurface {
  readonly id: string;
  readonly kind: 'floor' | 'tabletop';
  readonly stationId?: string;
  readonly instanceId?: string;
  /** Origin on the surface; local +Y is its normal, +X/+Z its finite axes. */
  readonly transform: LabTransform;
  readonly sizeM: readonly [number, number];
  /** Edge bevel / non-flat margin; additional placement-footprint insets are additive. */
  readonly edgeInsetM?: number;
}
export interface PlacementHit {
  readonly surfaceId: string;
  readonly pointM: WorldPointM;
  readonly localPointM: WorldPointM;
  readonly normal: WorldPointM;
  readonly distanceM: number;
}

export interface LabRendererStatus {
  readonly phase: 'initializing' | 'ready' | 'fallback' | 'lost' | 'unavailable';
  readonly preference: LabRendererPreference;
  readonly backend: LabRendererBackend | null;
  readonly implementation: 'three-webgl' | 'three-webgpu' | null;
  readonly reason?: string;
}
export interface LabFrameMetrics {
  readonly backend: LabRendererBackend;
  readonly quality: SceneQualityPreset;
  readonly measurement: 'render-cadence';
  readonly frameloop: 'always' | 'demand';
  readonly sampleCount: number;
  readonly elapsedS: number;
  readonly meanFrameMs: number;
  readonly p95FrameMs: number;
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  /** Only reported when the renderer supplies a byte count, never estimated. */
  readonly gpuMemoryBytes: number | null;
  readonly dpr: number;
  /** CSS viewport pixels; multiply by dpr for approximate drawing-buffer dimensions. */
  readonly viewportPx: readonly [number, number];
  readonly visibility: 'visible' | 'hidden';
}

export interface LabWorldProps {
  readonly mode?: LabWorldMode;
  readonly roomPreset?: RoomPreset;
  readonly lightingPreset?: LightingPreset;
  readonly stations?: readonly LabStation[];
  readonly activeStationId?: string;
  readonly isolateStation?: boolean;
  readonly showGrid?: boolean;
  readonly showStationMarkers?: boolean;
  readonly placementSurfaces?: readonly PlacementSurface[];
  readonly children?: ReactNode;
}
