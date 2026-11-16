import type { QualityId } from '../state/store';

export interface QualitySettings {
  readonly id: QualityId;
  readonly label: string;
  readonly description: string;
  /** `direct` renders straight to the screen; `composer` adds the post-processing chain. */
  readonly pipeline: 'direct' | 'composer';
  /** Allowed device-pixel-ratio range; the dynamic resolution scaler moves within it. */
  readonly dpr: readonly [number, number];
  /** MSAA samples in the post-processing buffers; 0 uses SMAA instead. */
  readonly msaa: number;
  readonly ambientOcclusion: false | { readonly quality: 'performance' | 'low' | 'medium' | 'high'; readonly halfRes: boolean; readonly intensity: number };
  readonly bloom: boolean;
  readonly grain: boolean;
  /** Icosphere subdivision for small scenes; large scenes use less (see `sphereDetailFor`). */
  readonly sphereDetail: number;
  readonly cylinderSegments: number;
  readonly clearcoat: number;
  readonly environmentResolution: number;
  readonly dustParticles: number;
}

export const QUALITY: Readonly<Record<QualityId, QualitySettings>> = {
  efficient: {
    id: 'efficient',
    label: 'Efficient',
    description: 'For integrated graphics and modest hardware. No post-processing.',
    pipeline: 'direct',
    dpr: [0.75, 1.25],
    msaa: 0,
    ambientOcclusion: false,
    bloom: false,
    grain: false,
    sphereDetail: 5,
    cylinderSegments: 12,
    clearcoat: 0,
    environmentResolution: 128,
    dustParticles: 160,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Ambient occlusion, restrained bloom and filmic tone mapping. Aimed at 60 FPS for typical scenes; what it reaches depends on the GPU.',
    pipeline: 'composer',
    dpr: [0.8, 1.5],
    msaa: 0,
    ambientOcclusion: { quality: 'low', halfRes: true, intensity: 2.1 },
    bloom: true,
    grain: false,
    sphereDetail: 8,
    cylinderSegments: 18,
    clearcoat: 0.35,
    environmentResolution: 256,
    dustParticles: 320,
  },
  quality: {
    id: 'quality',
    label: 'Quality',
    description: 'Full-resolution occlusion, multisampling and finer geometry for capable GPUs.',
    pipeline: 'composer',
    dpr: [1, 2],
    msaa: 4,
    ambientOcclusion: { quality: 'high', halfRes: false, intensity: 2.4 },
    bloom: true,
    grain: true,
    sphereDetail: 12,
    cylinderSegments: 28,
    clearcoat: 0.55,
    environmentResolution: 512,
    dustParticles: 520,
  },
};

/** Adaptive level of detail: the more atoms on screen, the fewer triangles each sphere gets. */
export function sphereDetailFor(settings: QualitySettings, atomCount: number): number {
  let detail = settings.sphereDetail;
  if (atomCount > 1500) detail = Math.min(detail, 6);
  if (atomCount > 6000) detail = Math.min(detail, 4);
  if (atomCount > 25000) detail = Math.min(detail, 2);
  if (atomCount > 80000) detail = 1;
  return detail;
}

export function cylinderSegmentsFor(settings: QualitySettings, bondCount: number): number {
  let segments = settings.cylinderSegments;
  if (bondCount > 3000) segments = Math.min(segments, 12);
  if (bondCount > 20000) segments = Math.min(segments, 8);
  if (bondCount > 80000) segments = 6;
  return segments;
}

export interface DeviceInfo {
  readonly renderer: string;
  readonly vendor: string;
  readonly webgl2: boolean;
  /** Whether the browser exposes WebGPU. MATTER LAB renders with WebGL 2; this is reported for diagnostics only. */
  readonly webgpuAvailable: boolean;
  /** True for CPU rasterisers such as SwiftShader or llvmpipe. */
  readonly software: boolean;
  readonly maxTextureSize: number;
  readonly logicalCores: number;
  readonly devicePixelRatio: number;
}

export function detectDevice(gl: WebGLRenderingContext | WebGL2RenderingContext): DeviceInfo {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const vendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  return {
    renderer,
    vendor,
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    webgpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
    software: /swiftshader|llvmpipe|software|basic render/i.test(renderer),
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    logicalCores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  };
}

/** A sensible starting preset for a device; the user's own choice always overrides it. */
export function recommendQuality(device: DeviceInfo): QualityId {
  if (device.software || !device.webgl2 || (device.logicalCores > 0 && device.logicalCores <= 2)) return 'efficient';
  if (/nvidia|geforce|rtx|radeon rx|apple m\d|apple gpu/i.test(device.renderer)) return 'quality';
  return 'balanced';
}
