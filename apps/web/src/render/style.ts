import { getElement, neighborsOf } from '@matterlab/core';
import type { Atom, BondOrder, ElementCategory, Scene } from '@matterlab/core';
import type { RenderMode } from '../state/store';

/** How one representation draws atoms and bonds. All lengths are in angstrom. */
export interface ModeStyle {
  /** Fraction of the van der Waals radius used for the atom sphere; 0 means use `atomRadius` for every element. */
  readonly vdwScale: number;
  /** Fixed atom radius when `vdwScale` is 0. */
  readonly atomRadius: number;
  /** Radius of a single-bond stick; 0 hides bonds altogether. */
  readonly bondRadius: number;
  /** Radius of each stick of a double or triple bond. */
  readonly multiRadius: number;
  /** Distance of the outer sticks of a double bond from the bond axis. */
  readonly doubleOffset: number;
  /** Distance of the outer sticks of a triple bond from the bond axis. */
  readonly tripleOffset: number;
  /** 0: sticks carry their atom's colour. 1: sticks are a neutral steel. */
  readonly bondTint: number;
  readonly carbonRadiusScale: number;
  /** Ordinary carbon-bound hydrogen fades out in a skeletal view; its data is never removed. */
  readonly carbonHydrogenScale: number;
}

export const MODE_STYLES: Readonly<Record<RenderMode, ModeStyle>> = {
  'ball-stick': { vdwScale: 0.26, atomRadius: 0, bondRadius: 0.105, multiRadius: 0.068, doubleOffset: 0.115, tripleOffset: 0.19, bondTint: 0.52, carbonRadiusScale: 1, carbonHydrogenScale: 1 },
  'space-fill': { vdwScale: 1, atomRadius: 0, bondRadius: 0, multiRadius: 0, doubleOffset: 0, tripleOffset: 0, bondTint: 0, carbonRadiusScale: 1, carbonHydrogenScale: 1 },
  sticks: { vdwScale: 0, atomRadius: 0.22, bondRadius: 0.19, multiRadius: 0.08, doubleOffset: 0.12, tripleOffset: 0.14, bondTint: 0, carbonRadiusScale: 1, carbonHydrogenScale: 1 },
  wire: { vdwScale: 0, atomRadius: 0.055, bondRadius: 0.032, multiRadius: 0.024, doubleOffset: 0.075, tripleOffset: 0.12, bondTint: 0, carbonRadiusScale: 1, carbonHydrogenScale: 1 },
  skeletal: { vdwScale: 0, atomRadius: 0.14, bondRadius: 0.055, multiRadius: 0.045, doubleOffset: 0.075, tripleOffset: 0.11, bondTint: 0.18, carbonRadiusScale: 0.3, carbonHydrogenScale: 0 },
};

export const RENDER_MODE_LABELS: Readonly<Record<RenderMode, { label: string; description: string }>> = {
  'ball-stick': { label: 'Ball and stick', description: 'Atoms at 26% of their van der Waals radius, joined by sticks.' },
  'space-fill': { label: 'Space-filling', description: 'Atoms at their full van der Waals radius.' },
  sticks: { label: 'Sticks', description: 'Bonds only, coloured by element.' },
  wire: { label: 'Wireframe', description: 'Thin lines; best for very large structures.' },
  skeletal: { label: 'Skeletal', description: 'A 3D line-angle view. Ordinary carbon-bound hydrogens are hidden, not deleted; isotopes and heteroatoms remain visible.' },
};

export function lerpStyle(a: ModeStyle, b: ModeStyle, t: number): ModeStyle {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    vdwScale: mix(a.vdwScale, b.vdwScale),
    atomRadius: mix(a.atomRadius, b.atomRadius),
    bondRadius: mix(a.bondRadius, b.bondRadius),
    multiRadius: mix(a.multiRadius, b.multiRadius),
    doubleOffset: mix(a.doubleOffset, b.doubleOffset),
    tripleOffset: mix(a.tripleOffset, b.tripleOffset),
    bondTint: mix(a.bondTint, b.bondTint),
    carbonRadiusScale: mix(a.carbonRadiusScale, b.carbonRadiusScale),
    carbonHydrogenScale: mix(a.carbonHydrogenScale, b.carbonHydrogenScale),
  };
}

export function atomRadiusFor(style: ModeStyle, z: number): number {
  return (style.vdwScale * getElement(z).vdwRadius + style.atomRadius) * (z === 6 ? style.carbonRadiusScale : 1);
}

export function atomVisibility(style: ModeStyle, scene: Scene, atom: Atom): number {
  if (style.carbonHydrogenScale === 1 || atom.protons !== 1 || atom.electrons !== 1 || atom.neutrons !== null) return 1;
  const bonded = neighborsOf(scene, atom.id);
  if (bonded.length !== 1) return 1;
  const neighbor = bonded[0]!;
  return scene.atoms.get(neighbor.atomId)?.protons === 6 && scene.bonds.get(neighbor.bondId)?.order === 1
    ? style.carbonHydrogenScale
    : 1;
}

export interface Stick {
  /** Signed distance from the bond axis along the bond's side direction. */
  readonly offset: number;
  readonly radius: number;
  readonly dashed: boolean;
}

const NO_STICKS: readonly Stick[] = [];

/** The sticks that make up a bond of the given order. An aromatic bond is a solid stick plus a dashed one. */
export function sticksFor(style: ModeStyle, order: BondOrder): readonly Stick[] {
  if (style.bondRadius <= 0) return NO_STICKS;
  switch (order) {
    case 1:
      return [{ offset: 0, radius: style.bondRadius, dashed: false }];
    case 2:
      return [
        { offset: style.doubleOffset, radius: style.multiRadius, dashed: false },
        { offset: -style.doubleOffset, radius: style.multiRadius, dashed: false },
      ];
    case 3:
      return [
        { offset: 0, radius: style.multiRadius, dashed: false },
        { offset: style.tripleOffset, radius: style.multiRadius, dashed: false },
        { offset: -style.tripleOffset, radius: style.multiRadius, dashed: false },
      ];
    case 1.5:
      return [
        { offset: -style.doubleOffset * 0.55, radius: style.multiRadius * 1.15, dashed: false },
        { offset: style.doubleOffset * 1.25, radius: style.multiRadius * 0.9, dashed: true },
      ];
  }
}

export const DASHES_PER_STICK = 4;

/** Number of cylinder instances a bond needs: two halves per solid stick, a fixed number of dashes per dashed one. */
export function instanceCountFor(sticks: readonly Stick[]): number {
  let count = 0;
  for (const stick of sticks) count += stick.dashed ? DASHES_PER_STICK : 2;
  return count;
}

/** Radius within which a pointer counts as hitting the bond. */
export function bondPickRadius(sticks: readonly Stick[]): number {
  let extent = 0;
  for (const stick of sticks) extent = Math.max(extent, Math.abs(stick.offset) + stick.radius);
  return extent;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Converts `#RRGGBB` to linear-light RGB, which is what the renderer's instance colours expect. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

const colorCache = new Map<number, [number, number, number]>();

/** Element colour (Jmol/CPK convention from the element table) in linear RGB. */
export function elementColorLinear(z: number): [number, number, number] {
  let color = colorCache.get(z);
  if (!color) {
    color = hexToLinear(getElement(z).color);
    colorCache.set(z, color);
  }
  return color;
}

export const NEUTRAL_BOND_COLOR = hexToLinear('#8FA6BD');

const METALLIC: Readonly<Record<ElementCategory, number>> = {
  nonmetal: 0,
  'noble-gas': 0,
  halogen: 0,
  metalloid: 0.45,
  'alkali-metal': 0.9,
  'alkaline-earth-metal': 0.9,
  'transition-metal': 1,
  'post-transition-metal': 0.9,
  lanthanide: 0.95,
  actinide: 0.95,
};

/**
 * How metallic an element's sphere looks (0-1). This is a visual convention that hints at the
 * element's category; it is not a physical property of an individual atom.
 */
export function elementMetalness(z: number): number {
  return METALLIC[getElement(z).category];
}

export const CATEGORY_COLORS: Readonly<Record<ElementCategory, string>> = {
  nonmetal: '#55E2D1',
  'noble-gas': '#8C92FC',
  halogen: '#7FD4FF',
  metalloid: '#9CE38A',
  'alkali-metal': '#FF8791',
  'alkaline-earth-metal': '#FFB66B',
  'transition-metal': '#87AAC6',
  'post-transition-metal': '#B9A7F5',
  lanthanide: '#F2A2D8',
  actinide: '#F7D774',
};
