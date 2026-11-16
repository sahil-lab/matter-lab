/*
 * A smooth, trap-free stand-in for the UFF energy, used only to turn a hopeless starting geometry
 * (atoms piled on one point, atoms strung on a line, neighbours folded onto each other) into one
 * the real force field can be started from. It is not part of RDKit and never contributes to a
 * reported energy.
 *
 * Why it is needed: RDKit's UFF has genuine traps for such starts. The n-fold angle terms of sp2,
 * trigonal-bipyramidal and octahedral centres have a second minimum at an angle of zero, and RDKit
 * closes it off with an exponential wall below 30 degrees that switches on discontinuously. Two
 * neighbours of an sp2 atom that start less than 60 degrees apart are pulled against that wall and
 * stay there. Pre-relaxation removes the cause: it spreads the neighbours of every atom to their
 * natural angles before the real terms are applied.
 *
 * The stand-in keeps UFF's own bond-stretch terms and natural angles, and replaces the rest:
 *   - every angle term becomes a function of cos(theta) with a single minimum at the natural angle
 *     (no small-angle wall is needed, and nothing is singular for straight or folded angles);
 *   - van der Waals pairs get a soft repulsion that only acts inside 0.8 x_ij;
 *   - torsion and inversion terms are left out.
 */
import type { UffKernel } from './builder';

/** Strength (kcal/mol) of the soft repulsion between non-bonded atoms. */
const REPULSION_STRENGTH = 1.0;
/** The soft repulsion acts inside this fraction of the van der Waals distance x_ij. */
const REPULSION_RANGE = 0.8;

/**
 * cos of the angle below which a term of order 3, 4, 2, 1 pulls its two atoms together instead of
 * apart: the barrier of the n-fold cosine at 60, 45 and 90 degrees, and RDKit's small-angle wall at
 * about 30 degrees for the linear term.
 */
const TRAP_COS_ORDER3 = 0.5;
const TRAP_COS_ORDER4 = Math.SQRT1_2;
const TRAP_COS_ORDER2 = 0.0;
const TRAP_COS_ORDER1 = 0.866;
/** cos of the angle (about 30 degrees) below which RDKit's exponential small-angle wall is switched on. */
const WALL_COS = 0.866;
/** Non-bonded atoms closer than this fraction of x_ij are an unusable start. */
const CLASH_FRACTION = 0.25;

/** Largest cos(theta) over the n-fold angle terms for which `limit(order)` is exceeded; NaN counts. */
function anyAngleBeyond(k: UffKernel, x: Float64Array, limit: (order: number) => number): boolean {
  const idx = k.angleIdx;
  for (let t = 0, m = idx.length; t < m; t += 4) {
    const order = idx[t + 3];
    if (order === 0) continue;
    const i3 = 3 * idx[t];
    const j3 = 3 * idx[t + 1];
    const k3 = 3 * idx[t + 2];
    const ax = x[i3] - x[j3];
    const ay = x[i3 + 1] - x[j3 + 1];
    const az = x[i3 + 2] - x[j3 + 2];
    const bx = x[k3] - x[j3];
    const by = x[k3 + 1] - x[j3 + 1];
    const bz = x[k3 + 2] - x[j3 + 2];
    const cos = (ax * bx + ay * by + az * bz) / Math.sqrt((ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz));
    if (!Number.isFinite(cos) || cos > limit(order)) return true;
  }
  return false;
}

/**
 * Is an n-fold angle term of the geometry `x` on the wrong side of its barrier, where the term
 * pulls two neighbours of an atom together until RDKit's small-angle wall stops them? A minimiser
 * that ends in such a geometry is in a trap, not at a sensible minimum.
 */
export function hasTrappedAngle(k: UffKernel, x: Float64Array): boolean {
  return anyAngleBeyond(k, x, (order) =>
    order === 3 ? TRAP_COS_ORDER3 : order === 4 ? TRAP_COS_ORDER4 : order === 2 ? TRAP_COS_ORDER2 : TRAP_COS_ORDER1,
  );
}

/**
 * Is the geometry `x` unusable as a starting point for the real force field? True if an n-fold
 * angle term is inside RDKit's small-angle wall (energies of 1e11 kcal/mol and more), or if two
 * non-bonded atoms sit almost on top of each other.
 */
export function hasGrossDefects(k: UffKernel, x: Float64Array): boolean {
  if (anyAngleBeyond(k, x, () => WALL_COS)) return true;
  const n = k.nAtoms;
  const nT = k.nVdwTypes;
  for (let i = 0; i < n - 1; i++) {
    const row = k.vdwType[i] * nT;
    let e = k.vdwExclStart[i];
    const eEnd = k.vdwExclStart[i + 1];
    let nextExcl = e < eEnd ? k.vdwExclJ[e] : n;
    for (let j = i + 1; j < n; j++) {
      if (j === nextExcl) {
        e++;
        nextExcl = e < eEnd ? k.vdwExclJ[e] : n;
        continue;
      }
      if (k.vdwFragment[j] !== k.vdwFragment[i]) continue;
      const dx = x[3 * i] - x[3 * j];
      const dy = x[3 * i + 1] - x[3 * j + 1];
      const dz = x[3 * i + 2] - x[3 * j + 2];
      const limit = CLASH_FRACTION * k.vdwXij[row + k.vdwType[j]];
      if (dx * dx + dy * dy + dz * dz < limit * limit) return true;
    }
  }
  return false;
}

/**
 * Energy of the stand-in potential at `x`; if `g` is given it is overwritten with the gradient.
 */
export function evaluatePreRelaxation(k: UffKernel, x: Float64Array, g: Float64Array | null): number {
  if (g !== null) g.fill(0);
  let energy = 0;

  // ---- bonds: UFF's own harmonic stretch
  {
    const idx = k.bondIdx;
    const par = k.bondPar;
    for (let t = 0, m = idx.length; t < m; t += 2) {
      const i3 = 3 * idx[t];
      const j3 = 3 * idx[t + 1];
      const dx = x[i3] - x[j3];
      const dy = x[i3 + 1] - x[j3 + 1];
      const dz = x[i3 + 2] - x[j3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const kb = par[t];
      const distTerm = dist - par[t + 1];
      energy += 0.5 * kb * distTerm * distTerm;
      if (g !== null && dist > 0.0) {
        const pre = (kb * distTerm) / dist;
        g[i3] += pre * dx;
        g[i3 + 1] += pre * dy;
        g[i3 + 2] += pre * dz;
        g[j3] -= pre * dx;
        g[j3 + 1] -= pre * dy;
        g[j3 + 2] -= pre * dz;
      }
    }
  }

  // ---- angles: f(cos theta) with a single minimum at the natural angle
  {
    const idx = k.angleIdx;
    const par = k.anglePar;
    for (let t = 0, q = 0, m = idx.length; t < m; t += 4, q += 5) {
      const i3 = 3 * idx[t];
      const j3 = 3 * idx[t + 1];
      const k3 = 3 * idx[t + 2];
      const order = idx[t + 3];
      const ka = par[q];
      const ax = x[i3] - x[j3];
      const ay = x[i3 + 1] - x[j3 + 1];
      const az = x[i3 + 2] - x[j3 + 2];
      const bx = x[k3] - x[j3];
      const by = x[k3 + 1] - x[j3 + 1];
      const bz = x[k3 + 2] - x[j3 + 2];
      const la = Math.sqrt(ax * ax + ay * ay + az * az);
      const lb = Math.sqrt(bx * bx + by * by + bz * bz);
      if (!(la > 1e-12) || !(lb > 1e-12)) continue;
      let c = (ax * bx + ay * by + az * bz) / (la * lb);
      if (c > 1.0) c = 1.0;
      else if (c < -1.0) c = -1.0;
      let f: number;
      let df: number; // dE/d(cos theta)
      if (order === 0) {
        // UFF's general cosine-harmonic term, which has no second minimum
        f = ka * (par[q + 2] + par[q + 3] * c + par[q + 4] * (2.0 * c * c - 1.0));
        df = ka * (par[q + 3] + 4.0 * par[q + 4] * c);
      } else if (order === 1 || order === 2) {
        // linear arrangement: natural angle 180 degrees
        f = ka * (1.0 + c);
        df = ka;
      } else if (order === 3) {
        // trigonal: natural angle 120 degrees, with the curvature of the 3-fold term at its minimum
        f = (2.0 / 3.0) * ka * (c + 0.5) * (c + 0.5);
        df = (4.0 / 3.0) * ka * (c + 0.5);
      } else {
        // octahedral: cis and trans partners are not known in advance, so let the ligands repel
        // each other; on a sphere that arranges six of them as an octahedron
        const d = 1.02 - c;
        f = (0.125 * ka) / d;
        df = (0.125 * ka) / (d * d);
      }
      energy += f;
      if (g !== null) {
        // d(cos theta)/dr_i = (b/|b| - cos * a/|a|) / |a|, and likewise for k
        const uax = ax / la;
        const uay = ay / la;
        const uaz = az / la;
        const ubx = bx / lb;
        const uby = by / lb;
        const ubz = bz / lb;
        const gix = (df * (ubx - c * uax)) / la;
        const giy = (df * (uby - c * uay)) / la;
        const giz = (df * (ubz - c * uaz)) / la;
        const gkx = (df * (uax - c * ubx)) / lb;
        const gky = (df * (uay - c * uby)) / lb;
        const gkz = (df * (uaz - c * ubz)) / lb;
        g[i3] += gix;
        g[i3 + 1] += giy;
        g[i3 + 2] += giz;
        g[k3] += gkx;
        g[k3 + 1] += gky;
        g[k3 + 2] += gkz;
        g[j3] -= gix + gkx;
        g[j3 + 1] -= giy + gky;
        g[j3 + 2] -= giz + gkz;
      }
    }
  }

  // ---- soft repulsion between the atom pairs that carry a van der Waals term
  {
    const n = k.nAtoms;
    const nT = k.nVdwTypes;
    for (let i = 0; i < n - 1; i++) {
      const i3 = 3 * i;
      const row = k.vdwType[i] * nT;
      const fi = k.vdwFragment[i];
      let e = k.vdwExclStart[i];
      const eEnd = k.vdwExclStart[i + 1];
      let nextExcl = e < eEnd ? k.vdwExclJ[e] : n;
      for (let j = i + 1; j < n; j++) {
        if (j === nextExcl) {
          e++;
          nextExcl = e < eEnd ? k.vdwExclJ[e] : n;
          continue;
        }
        if (k.vdwFragment[j] !== fi) continue;
        const j3 = 3 * j;
        const dx = x[i3] - x[j3];
        const dy = x[i3 + 1] - x[j3 + 1];
        const dz = x[i3 + 2] - x[j3 + 2];
        const sigma = REPULSION_RANGE * k.vdwXij[row + k.vdwType[j]];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= sigma * sigma) continue;
        const dist = Math.max(Math.sqrt(d2), 1e-6);
        const s = sigma / dist - 1.0;
        energy += REPULSION_STRENGTH * s * s;
        if (g !== null) {
          // dE/dr = 2 k s * (-sigma / r^2)
          const pre = (-2.0 * REPULSION_STRENGTH * s * sigma) / (dist * dist * dist);
          g[i3] += pre * dx;
          g[i3 + 1] += pre * dy;
          g[i3 + 2] += pre * dz;
          g[j3] -= pre * dx;
          g[j3 + 1] -= pre * dy;
          g[j3 + 2] -= pre * dz;
        }
      }
    }
  }
  return energy;
}
