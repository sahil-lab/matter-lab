/**
 * Colour scales for computed fields, and the colours they end up as on screen.
 *
 * A legend is only quantitative if its colours are the ones in the picture. Everything the 3D view
 * draws passes through the AgX tone curve before it is displayed, so a legend built from the raw
 * scale would not match. `displayColor` applies the same curve (a port of the three.js shader the
 * renderer uses), which makes an unlit surface and its legend agree; a test compares the two.
 */

export type Rgb = readonly [number, number, number];

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function rgbToCss([r, g, b]: Rgb): string {
  const byte = (c: number) => Math.round(clamp01(c) * 255);
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

/** A colour scale: position 0..1 to an sRGB colour with components 0..1. */
export interface ColorScale {
  readonly id: 'potential' | 'potential-plane' | 'phase' | 'density';
  /** Diverging scales have their neutral point at 0.5; sequential ones start at 0. */
  readonly diverging: boolean;
  at(t: number): Rgb;
}

function ramp(stops: readonly string[]): (t: number) => Rgb {
  const colors = stops.map(hexToRgb);
  return (t) => {
    const x = clamp01(Number.isFinite(t) ? t : 0) * (colors.length - 1);
    const i = Math.min(colors.length - 2, Math.floor(x));
    const f = x - i;
    const a = colors[i]!;
    const b = colors[i + 1]!;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}

/** Phase colours of an orbital: violet where the wavefunction is positive, amber where it is negative. */
export const PHASE_POSITIVE = '#8c92fc';
export const PHASE_NEGATIVE = '#ffb66b';
/** The isosurface of the electron density: a neutral blue, kept apart from the teal used for selections. */
export const DENSITY_COLOR = '#7fb4ff';

/**
 * Electrostatic potential: red where it is negative (a positive test charge is attracted, the
 * electron-rich regions), white at zero, blue where it is positive. The usual chemical convention.
 */
export const SCALE_POTENTIAL: ColorScale = {
  id: 'potential',
  diverging: true,
  at: ramp(['#c81d3a', '#ee5a4c', '#f8a48c', '#f1eeea', '#93b9f6', '#4f80ee', '#2445cf']),
};

/**
 * The same convention for a cutting plane: red negative, blue positive. The neutral point is dark
 * instead of white, because on a plane most of the area is near zero and would otherwise flood the
 * view with white; the plane fades out there.
 */
export const SCALE_POTENTIAL_PLANE: ColorScale = {
  id: 'potential-plane',
  diverging: true,
  at: ramp(['#ffb3a3', '#f0524c', '#8f2634', '#161d2e', '#243f9a', '#4a7bf2', '#a9c6ff']),
};

/** Signed amplitude of an orbital: amber (negative) through a dark neutral to violet (positive). */
export const SCALE_PHASE: ColorScale = {
  id: 'phase',
  diverging: true,
  at: ramp(['#ffd9a8', PHASE_NEGATIVE, '#b0733c', '#1a2438', '#5258b8', PHASE_POSITIVE, '#cfd2ff']),
};

/** Electron density on a logarithmic scale: the viridis map (dark violet, low; yellow, high). */
export const SCALE_DENSITY: ColorScale = {
  id: 'density',
  diverging: false,
  at: ramp(['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']),
};

// ---------- the renderer's tone curve ----------

// Matrices as in three.js (ShaderChunk/tonemapping_pars_fragment), each inner array one column.
type Columns = readonly [Rgb, Rgb, Rgb];
const LINEAR_SRGB_TO_LINEAR_REC2020: Columns = [
  [0.6274, 0.0691, 0.0164],
  [0.3293, 0.9195, 0.088],
  [0.0433, 0.0113, 0.8956],
];
const LINEAR_REC2020_TO_LINEAR_SRGB: Columns = [
  [1.6605, -0.1246, -0.0182],
  [-0.5876, 1.1329, -0.1006],
  [-0.0728, -0.0083, 1.1187],
];
const AGX_INSET: Columns = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const AGX_OUTSET: Columns = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

const multiply = (m: Columns, v: Rgb): Rgb => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];

const map = (v: Rgb, f: (x: number) => number): Rgb => [f(v[0]), f(v[1]), f(v[2])];

function agxContrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** The AgX tone curve at exposure 1, on linear-sRGB components, exactly as the renderer applies it. */
export function agxToneMap(color: Rgb): Rgb {
  let c = multiply(AGX_INSET, multiply(LINEAR_SRGB_TO_LINEAR_REC2020, color));
  c = map(c, (x) => clamp01((Math.log2(Math.max(x, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)));
  c = multiply(AGX_OUTSET, map(c, agxContrast));
  c = multiply(LINEAR_REC2020_TO_LINEAR_SRGB, map(c, (x) => Math.max(0, x) ** 2.2));
  return map(c, clamp01);
}

/** The sRGB colour an unlit surface of colour `color` (sRGB) has on screen. */
export function displayColor(color: Rgb): Rgb {
  return map(agxToneMap(map(color, srgbToLinear)), linearToSrgb);
}

/** A CSS gradient showing a scale as the 3D view displays it. */
export function scaleGradient(scale: ColorScale, direction = 'to right', steps = 24): string {
  const stops = Array.from({ length: steps + 1 }, (_, i) => rgbToCss(displayColor(scale.at(i / steps))));
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

/** The scale as 256 RGBA texels (sRGB bytes), for the lookup texture of the renderer. */
export function scaleTexels(scale: ColorScale): Uint8Array {
  const texels = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = scale.at(i / 255);
    texels[4 * i] = Math.round(r * 255);
    texels[4 * i + 1] = Math.round(g * 255);
    texels[4 * i + 2] = Math.round(b * 255);
    texels[4 * i + 3] = 255;
  }
  return texels;
}

/** Linear-light vertex colours for values placed on a scale; `position(i)` gives 0..1 for vertex i. */
export function vertexColors(scale: ColorScale, count: number, position: (index: number) => number): Float32Array {
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = scale.at(position(i));
    colors[3 * i] = srgbToLinear(r);
    colors[3 * i + 1] = srgbToLinear(g);
    colors[3 * i + 2] = srgbToLinear(b);
  }
  return colors;
}
