/**
 * Billboarded in-scene text labels via a canvas-rasterized texture on a `THREE.Sprite`, used
 * instead of `@react-three/drei`'s `<Html>` for `lab/fluids`'s labels (graduation marks, instrument
 * readouts). `<Html>` mounts a nested `ReactDOM` root per label; with several labels mounting and
 * unmounting together (switching regression scenarios, apparatus being added/removed), that was
 * observed to trigger React 19 "synchronously unmount a root while rendering" console errors (see
 * `e2e/fluids.spec.ts`). A canvas texture keeps every label a normal, depth-sorted part of the WebGL
 * draw — no DOM nodes, no React root nesting — and is drawn with the Canvas 2D API using the
 * browser's own system font stack, so it never depends on a network font fetch.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

export interface TextSpriteLine {
  readonly text: string;
  readonly color?: string;
  readonly fontWeight?: string | number;
}

export interface TextSpriteOptions {
  readonly lines: readonly TextSpriteLine[];
  readonly fontSizePx?: number;
  readonly fontFamily?: string;
  readonly paddingPx?: number;
  readonly backgroundColor?: string | null;
  readonly borderRadiusPx?: number;
  /** Texture pixels per world meter: controls the label's apparent real-world size. Higher = smaller label. */
  readonly pixelsPerMeter?: number;
}

export interface TextSpriteResult {
  readonly texture: CanvasTexture;
  readonly widthM: number;
  readonly heightM: number;
}

const DEFAULT_FONT_FAMILY = 'ui-monospace, "Segoe UI", system-ui, -apple-system, sans-serif';
const DEFAULT_FONT_SIZE_PX = 30;
const DEFAULT_PADDING_PX = 10;
const DEFAULT_PIXELS_PER_METER = 7000;
/** Oversampling factor so text stays crisp at typical close-up camera distances. */
const SUPERSAMPLE = 2;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Renders `options.lines` onto an offscreen canvas and wraps it as a `THREE.CanvasTexture`, with the on-screen (world-unit) size the resulting sprite should be scaled to. */
export function buildTextSprite(options: TextSpriteOptions): TextSpriteResult {
  const fontSizePx = options.fontSizePx ?? DEFAULT_FONT_SIZE_PX;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const padding = options.paddingPx ?? DEFAULT_PADDING_PX;
  const pixelsPerMeter = options.pixelsPerMeter ?? DEFAULT_PIXELS_PER_METER;
  const lineHeight = fontSizePx * 1.25;
  const lines = options.lines.length > 0 ? options.lines : [{ text: '' }];

  const measurer = document.createElement('canvas').getContext('2d')!;
  measurer.font = `600 ${fontSizePx}px ${fontFamily}`;
  let maxTextWidth = 0;
  for (const line of lines) maxTextWidth = Math.max(maxTextWidth, measurer.measureText(line.text).width);

  const canvasWidth = Math.max(1, Math.ceil(maxTextWidth + padding * 2));
  const canvasHeight = Math.max(1, Math.ceil(lineHeight * lines.length + padding * 2));

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth * SUPERSAMPLE;
  canvas.height = canvasHeight * SUPERSAMPLE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);

  if (options.backgroundColor) {
    ctx.fillStyle = options.backgroundColor;
    roundRectPath(ctx, 0, 0, canvasWidth, canvasHeight, options.borderRadiusPx ?? 6);
    ctx.fill();
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.font = `${line.fontWeight ?? 600} ${fontSizePx}px ${fontFamily}`;
    ctx.fillStyle = line.color ?? '#ffffff';
    ctx.fillText(line.text, padding, padding + lineHeight * i + lineHeight / 2);
  });

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, widthM: canvasWidth / pixelsPerMeter, heightM: canvasHeight / pixelsPerMeter };
}
