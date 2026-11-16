import { NEUTRON_MASS_U, NUCLEAR_RADIUS_R0_FM, PROTON_MASS_U, findIsotope, getElement, isotopeMass, representativeIsotope } from '@matterlab/core';
import type { Citation, IsotopeInfo } from '@matterlab/core';

/**
 * The picture of a nucleus as a cluster of protons and neutrons.
 *
 * It is an illustration, and says so wherever it is shown. What it takes from data is how many
 * protons and neutrons there are, how large a nucleon is, and roughly how large the nucleus is.
 * Where each sphere sits, and which sphere is a proton, is made up: a nucleus is a quantum system
 * whose nucleons have no positions of their own and are not hard spheres.
 */

/** Radius of the spheres, in femtometre: the root-mean-square charge radius of the proton, 0.8414(19) fm (CODATA 2018). */
export const NUCLEON_RADIUS_FM = 0.84;
/** The colours protons and neutrons are drawn in, here and in the particle counters of the Atomic Forge. */
export const NUCLEON_COLORS = { proton: '#ff8791', neutron: '#9db4c9' } as const;
/** Energy equivalent of the unified atomic mass unit in MeV (CODATA 2018). */
export const U_TO_MEV = 931.49410242;
/** Largest nucleus drawn; the heaviest nuclides known have fewer than 300 nucleons. */
export const MAX_NUCLEONS = 400;

export type NucleonKind = 'proton' | 'neutron';

export interface Nucleon {
  readonly index: number;
  readonly kind: NucleonKind;
  /** Which proton, or which neutron, this is: 1, 2, 3, ... The numbering has no physical meaning. */
  readonly ordinal: number;
  /** Centre of the sphere, in femtometre, with the centre of the cluster at the origin. */
  readonly position: readonly [number, number, number];
}

export interface NucleusModel {
  readonly protons: number;
  readonly neutrons: number;
  readonly massNumber: number;
  readonly nucleons: readonly Nucleon[];
  /** Radius of the smallest ball about the origin that holds every sphere of the picture, femtometre. */
  readonly extentFm: number;
  /** The empirical radius of a nucleus of this mass number, r0 A^(1/3), femtometre. */
  readonly empiricalRadiusFm: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Arranges `protons + neutrons` spheres of radius `NUCLEON_RADIUS_FM` in a ball without overlap.
 * The ball starts at the empirical nuclear radius and is widened only as far as the spheres need,
 * which matters for the lightest nuclei. The same counts always give the same picture.
 */
export function buildNucleus(protons: number, neutrons: number): NucleusModel {
  if (!Number.isInteger(protons) || !Number.isInteger(neutrons) || protons < 1 || neutrons < 0) throw new RangeError('A nucleus has at least one proton, and whole numbers of protons and neutrons.');
  const count = protons + neutrons;
  if (count > MAX_NUCLEONS) throw new RangeError(`Nuclei are drawn for up to ${MAX_NUCLEONS} nucleons.`);
  const empiricalRadiusFm = NUCLEAR_RADIUS_R0_FM * Math.cbrt(count);
  const random = mulberry32(protons * 1009 + neutrons * 9176 + 17);
  const contact = 2 * NUCLEON_RADIUS_FM;

  // Centres start scattered evenly through a ball, then push each other apart until none overlap.
  let reach = Math.max(0, empiricalRadiusFm - NUCLEON_RADIUS_FM);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  if (count > 1) {
    for (let i = 0; i < count; i++) {
      const radius = Math.max(reach, 0.2) * Math.cbrt(random());
      const cosTheta = 2 * random() - 1;
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = 2 * Math.PI * random();
      x[i] = radius * sinTheta * Math.cos(phi);
      y[i] = radius * sinTheta * Math.sin(phi);
      z[i] = radius * cosTheta;
    }
  }
  // A little more than contact is aimed for, so that rounding never leaves two spheres overlapping.
  const target = contact * 1.02;
  const closestPair = (): number => {
    let closest = Infinity;
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) closest = Math.min(closest, Math.hypot(x[j]! - x[i]!, y[j]! - y[i]!, z[j]! - z[i]!));
    return closest;
  };
  const settle = (rounds: number): void => {
    for (let round = 0; round < rounds; round++) {
      let moved = false;
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          let dx = x[j]! - x[i]!;
          let dy = y[j]! - y[i]!;
          let dz = z[j]! - z[i]!;
          let d = Math.hypot(dx, dy, dz);
          if (d >= target) continue;
          moved = true;
          if (d < 1e-9) {
            // Two centres on top of each other: any direction will do, as long as it is always the same one.
            dx = 1e-3 * (1 + i);
            dy = 1e-3 * (1 + j);
            dz = 1e-3;
            d = Math.hypot(dx, dy, dz);
          }
          const push = (0.5 * (target - d)) / d;
          x[i] = x[i]! - dx * push;
          y[i] = y[i]! - dy * push;
          z[i] = z[i]! - dz * push;
          x[j] = x[j]! + dx * push;
          y[j] = y[j]! + dy * push;
          z[j] = z[j]! + dz * push;
        }
      }
      for (let i = 0; i < count; i++) {
        const r = Math.hypot(x[i]!, y[i]!, z[i]!);
        if (r > reach && r > 0) {
          const scale = reach / r;
          x[i] = x[i]! * scale;
          y[i] = y[i]! * scale;
          z[i] = z[i]! * scale;
        }
      }
      // Nothing was too close: the arrangement has settled.
      if (!moved) break;
    }
  };
  if (count > 1) {
    for (let attempt = 0; attempt < 80; attempt++) {
      settle(120);
      if (closestPair() >= contact) break;
      reach = Math.max(reach * 1.04, reach + 0.05);
    }
  }

  // Centre the cluster on its own centre.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += x[i]! / count;
    cy += y[i]! / count;
    cz += z[i]! / count;
  }

  // Which sphere is a proton is arbitrary; they are mixed, as protons and neutrons are in a nucleus.
  const kinds: NucleonKind[] = [...new Array<NucleonKind>(protons).fill('proton'), ...new Array<NucleonKind>(neutrons).fill('neutron')];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  const ordinals = { proton: 0, neutron: 0 };
  let extent = 0;
  const nucleons: Nucleon[] = kinds.map((kind, index) => {
    const position = [x[index]! - cx, y[index]! - cy, z[index]! - cz] as const;
    extent = Math.max(extent, Math.hypot(...position) + NUCLEON_RADIUS_FM);
    return { index, kind, ordinal: ++ordinals[kind], position };
  });
  return { protons, neutrons, massNumber: count, nucleons, extentFm: extent, empiricalRadiusFm };
}

// ---------- what is known about the nuclide and about its nucleons ----------

export interface NuclideFacts {
  readonly protons: number;
  readonly neutrons: number;
  readonly massNumber: number;
  /** "Carbon-12". */
  readonly name: string;
  /** True when the atom specifies no isotope and the most abundant (or longest-lived) one is shown in its place. */
  readonly standsForNaturalMix: boolean;
  /** The evaluated data for this nuclide, or `null` when it is not in the evaluation. */
  readonly isotope: IsotopeInfo | null;
  /** Nuclear binding energy in MeV from the evaluated atomic mass, or `null` when there is no such mass. */
  readonly bindingEnergyMeV: number | null;
}

/** The nuclide an atom's nucleus is: the stated isotope, or the representative one when none is stated. */
export function nuclideOf(protons: number, neutrons: number | null): NuclideFacts {
  const element = getElement(protons);
  const representative = neutrons === null ? representativeIsotope(protons) : undefined;
  const n = neutrons ?? representative?.n ?? Math.max(0, Math.round(element.atomicWeight) - protons);
  const isotope = findIsotope(protons, n) ?? null;
  const mass = isotopeMass(protons, n);
  const hydrogen = isotopeMass(1, 0);
  // Counting atoms of hydrogen-1 instead of bare protons accounts for the electrons of the atomic mass.
  const bindingEnergyMeV = mass !== null && hydrogen !== null ? (protons * hydrogen + n * NEUTRON_MASS_U - mass) * U_TO_MEV : null;
  return { protons, neutrons: n, massNumber: protons + n, name: `${element.name}-${protons + n}`, standsForNaturalMix: neutrons === null, isotope, bindingEnergyMeV };
}

export interface NucleonFacts {
  readonly name: string;
  /** In units of the elementary charge. */
  readonly charge: number;
  readonly massU: number;
  readonly massMeV: number;
  readonly quarks: string;
  readonly spin: string;
  readonly lifetime: string;
}

export const NUCLEON_FACTS: Readonly<Record<NucleonKind, NucleonFacts>> = {
  proton: {
    name: 'Proton',
    charge: 1,
    massU: PROTON_MASS_U,
    massMeV: PROTON_MASS_U * U_TO_MEV,
    quarks: 'two up quarks and one down quark (uud)',
    spin: '½',
    lifetime: 'Stable as far as anyone has seen: no proton decay has ever been observed.',
  },
  neutron: {
    name: 'Neutron',
    charge: 0,
    massU: NEUTRON_MASS_U,
    massMeV: NEUTRON_MASS_U * U_TO_MEV,
    quarks: 'one up quark and two down quarks (udd)',
    spin: '½',
    lifetime: 'On its own a neutron decays into a proton, an electron and an antineutrino, with a mean lifetime of 878.4 ± 0.5 s. Bound in a stable nucleus it does not decay.',
  },
};

export const NUCLEON_SOURCES: readonly Citation[] = [
  {
    authors: 'E. Tiesinga, P. J. Mohr, D. B. Newell, B. N. Taylor',
    title: 'CODATA recommended values of the fundamental physical constants: 2018 (nucleon masses, proton charge radius)',
    source: 'Reviews of Modern Physics 93, 025010',
    year: 2021,
    doi: '10.1103/RevModPhys.93.025010',
  },
  {
    authors: 'R. L. Workman et al. (Particle Data Group)',
    title: 'Review of Particle Physics (neutron mean lifetime, quark content)',
    source: 'Progress of Theoretical and Experimental Physics 2022, 083C01',
    year: 2022,
    doi: '10.1093/ptep/ptac097',
  },
];

/** A length in femtometre written with the unit that suits it: "2 fm", "50 pm", "1.5 Å". */
export function formatLength(femtometre: number): string {
  const value = (n: number): string => String(Number(n.toPrecision(2)));
  if (femtometre >= 1e5) return `${value(femtometre / 1e5)} Å`;
  if (femtometre >= 1e3) return `${value(femtometre / 1e3)} pm`;
  return `${value(femtometre)} fm`;
}

/** The largest "round" length (1, 2 or 5 times a power of ten) that is not longer than `femtometre`. */
export function roundLength(femtometre: number): number {
  if (!(femtometre > 0) || !Number.isFinite(femtometre)) return 1;
  const power = 10 ** Math.floor(Math.log10(femtometre));
  const lead = femtometre / power;
  return (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * power;
}
