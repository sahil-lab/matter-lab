/**
 * Acid-base indicator colors. This module never computes or guesses a pH: every function takes a
 * pH value as input (from an Agent 06 `Observation`) and returns only a *visual encoding* of it, so
 * the color is always labeled `ILLUSTRATIVE` even though the transition ranges themselves are
 * standard reference data.
 */
import type { Evidence } from '../contracts';

export type NamedIndicatorId = 'methyl-orange' | 'methyl-red' | 'bromothymol-blue' | 'phenolphthalein';
export type IndicatorId = 'none' | 'universal' | NamedIndicatorId;

export interface IndicatorDef {
  readonly id: NamedIndicatorId;
  readonly label: string;
  /** Commonly tabulated transition range (pH). */
  readonly rangeLowPh: number;
  readonly rangeHighPh: number;
  /** Color below `rangeLowPh`. */
  readonly acidColor: string;
  /** Color above `rangeHighPh`. */
  readonly baseColor: string;
  readonly citation: string;
}

/**
 * Transition ranges and endpoint colors as commonly tabulated in general/analytical chemistry
 * references (e.g. Chemistry LibreTexts §16.3 "Acid-Base Indicators"; CRC Handbook of Chemistry and
 * Physics indicator tables). Different sources round these to slightly different tenths of a pH
 * unit; the values below are the most frequently cited and are treated as reference data for the
 * *range*, not as a measurement of any particular sample.
 */
export const INDICATORS: Readonly<Record<NamedIndicatorId, IndicatorDef>> = {
  'methyl-orange': {
    id: 'methyl-orange',
    label: 'Methyl orange',
    rangeLowPh: 3.1,
    rangeHighPh: 4.4,
    acidColor: '#D1382B',
    baseColor: '#F5C518',
    citation: 'Transition range 3.1-4.4, red to yellow (Chemistry LibreTexts §16.3, "Acid-Base Indicators").',
  },
  'methyl-red': {
    id: 'methyl-red',
    label: 'Methyl red',
    rangeLowPh: 4.4,
    rangeHighPh: 6.2,
    acidColor: '#D1382B',
    baseColor: '#F2C94C',
    citation: 'Transition range 4.4-6.2, red to yellow (Chemistry LibreTexts §16.3, "Acid-Base Indicators").',
  },
  'bromothymol-blue': {
    id: 'bromothymol-blue',
    label: 'Bromothymol blue',
    rangeLowPh: 6.0,
    rangeHighPh: 7.6,
    acidColor: '#E8D23C',
    baseColor: '#2B6CB0',
    citation: 'Transition range 6.0-7.6, yellow to blue (Chemistry LibreTexts §16.3, "Acid-Base Indicators").',
  },
  phenolphthalein: {
    id: 'phenolphthalein',
    label: 'Phenolphthalein',
    // A faint warm-white rather than pure white so the liquid still reads as a liquid on screen;
    // true colorless is rendered via the glass/liquid material's own transmission, not this color.
    rangeLowPh: 8.3,
    rangeHighPh: 10.0,
    acidColor: '#F4F1EA',
    baseColor: '#D43F94',
    citation: 'Transition range 8.3-10.0, colorless to pink (Chemistry LibreTexts §16.3, "Acid-Base Indicators").',
  },
};

/**
 * Widely used educational "universal indicator" chart (a blend of several dyes). Exact hues vary by
 * manufacturer/formulation, so unlike the single-dye table above this is treated as an illustrative
 * approximation even for its reference pH stops, not a tabulated reference compound.
 */
const UNIVERSAL_STOPS: ReadonlyArray<{ readonly ph: number; readonly color: string }> = [
  { ph: 1, color: '#E6342B' },
  { ph: 3, color: '#EF6A28' },
  { ph: 5, color: '#F5D328' },
  { ph: 6, color: '#A8D24A' },
  { ph: 7, color: '#3FAE49' },
  { ph: 8, color: '#2D9E8F' },
  { ph: 9, color: '#2B7FB5' },
  { ph: 11, color: '#3B4FA0' },
  { ph: 13, color: '#7C3AA6' },
  { ph: 14, color: '#5A2170' },
];

export interface IndicatorColorResult {
  readonly colorHex: string;
  readonly evidence: Evidence;
  readonly note: string;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Smooth (C1-continuous), monotonic 0→1 ease across [lo, hi]; clamped outside. */
function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** Linear blend between two `#rrggbb` colors in sRGB hex space; `t` is clamped to [0, 1]. */
export function lerpHex(a: string, b: string, t: number): string {
  const ct = clamp01(t);
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * ct, ag + (bg - ag) * ct, ab + (bb - ab) * ct]);
}

function universalColor(ph: number): string {
  const clamped = Math.min(14, Math.max(0, ph));
  const first = UNIVERSAL_STOPS[0]!;
  if (clamped <= first.ph) return first.color;
  for (let i = 1; i < UNIVERSAL_STOPS.length; i++) {
    const b = UNIVERSAL_STOPS[i]!;
    if (clamped <= b.ph) {
      const a = UNIVERSAL_STOPS[i - 1]!;
      const t = (clamped - a.ph) / (b.ph - a.ph);
      return lerpHex(a.color, b.color, t);
    }
  }
  return UNIVERSAL_STOPS[UNIVERSAL_STOPS.length - 1]!.color;
}

/**
 * Visual color for a solution given its indicator and pH. `ph` must come from an authoritative
 * `Observation` (Agent 06's solver) — this function only maps that number through a documented,
 * fixed color curve; it never derives or adjusts the pH itself.
 */
export function indicatorColorForPh(indicatorId: IndicatorId, ph: number): IndicatorColorResult {
  if (indicatorId === 'none') {
    return { colorHex: '#FFFFFF', evidence: 'ILLUSTRATIVE', note: 'No indicator selected; the liquid shows only its own tint.' };
  }
  if (indicatorId === 'universal') {
    return {
      colorHex: universalColor(ph),
      evidence: 'ILLUSTRATIVE',
      note: 'Educational universal-indicator color chart. Encodes the supplied pH; not an independent measurement.',
    };
  }
  const def = INDICATORS[indicatorId];
  const t = smoothstep(def.rangeLowPh, def.rangeHighPh, ph);
  return {
    colorHex: lerpHex(def.acidColor, def.baseColor, t),
    evidence: 'ILLUSTRATIVE',
    note: `${def.label}. ${def.citation} Colorized from the supplied pH; the pH itself must come from the titration engine.`,
  };
}

/**
 * Composites an indicator color over a liquid's own tint (e.g. a pale aqueous tint, or a colored
 * species such as copper sulfate). `strength` models that indicators are normally dosed as a few
 * drops: at 1 the indicator color fully determines the liquid's appearance; at 0 it is invisible.
 * Purely a rendering convenience — it never substitutes for the authoritative species/pH data.
 */
export function blendLiquidColor(baseTintHex: string, indicator: IndicatorColorResult, strength = 0.85): string {
  return lerpHex(baseTintHex, indicator.colorHex, clamp01(strength));
}
