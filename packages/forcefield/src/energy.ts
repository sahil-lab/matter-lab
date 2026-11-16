/*
 * UFF energy and analytic gradient.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/ForceField/UFF/BondStretch.cpp    BondStretchContrib::getEnergy / getGrad
 *   Code/ForceField/UFF/AngleBend.cpp      AngleBendContrib::getEnergy / getGrad, Utils::calcAngleBendGrad
 *   Code/ForceField/UFF/TorsionAngle.cpp   TorsionAngleContrib::getEnergy / getGrad, Utils::calcTorsionGrad
 *   Code/ForceField/ForceField.cpp         ForceFieldsHelper::computeDihedral
 *   Code/ForceField/UFF/Inversion.cpp      InversionContrib::getEnergy / getGrad
 *   Code/ForceField/UFF/Utils.cpp          Utils::calculateCosY
 *   Code/ForceField/UFF/Nonbonded.cpp      vdWContrib::getEnergy / getGrad
 * Copyright (C) 2004-2024 Greg Landrum, Rational Discovery LLC, Paolo Tosco and other RDKit contributors.
 *
 * Each term follows RDKit's energy routine for the energy and RDKit's gradient routine for the
 * gradient, including the places where the two treat a degenerate geometry differently.
 */
import type { UffKernel } from './builder';

export const TERM_BOND = 0;
export const TERM_ANGLE = 1;
export const TERM_TORSION = 2;
export const TERM_INVERSION = 3;
export const TERM_VDW = 4;
export const N_TERM_TYPES = 5;

/** Below this angle (cos > 0.8660, about 30 degrees) RDKit adds an exponential penalty to n-fold angle terms. */
const ANGLE_CORRECTION_THRESHOLD = 0.866;

/**
 * Evaluates the UFF energy (kcal/mol) at `x` (xyz triples, angstrom).
 *
 * @param g      if given, receives dE/dx (kcal/mol/angstrom); it is overwritten, not accumulated into
 * @param terms  if given (length 5), receives the energy per term type, indexed by the TERM_* constants
 */
export function evaluate(k: UffKernel, x: Float64Array, g: Float64Array | null, terms: Float64Array | null): number {
  if (g !== null) g.fill(0);

  // ------------------------------------------------------------------ bond stretch
  let eBond = 0;
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
      eBond += 0.5 * kb * distTerm * distTerm;
      if (g !== null) {
        if (dist > 0.0) {
          const pre = (kb * distTerm) / dist;
          g[i3] += pre * dx;
          g[i3 + 1] += pre * dy;
          g[i3 + 2] += pre * dz;
          g[j3] -= pre * dx;
          g[j3 + 1] -= pre * dy;
          g[j3 + 2] -= pre * dz;
        } else {
          // move a small amount in an arbitrary direction
          const dGrad = kb * 0.01;
          g[i3] += dGrad;
          g[i3 + 1] += dGrad;
          g[i3 + 2] += dGrad;
          g[j3] -= dGrad;
          g[j3 + 1] -= dGrad;
          g[j3 + 2] -= dGrad;
        }
      }
    }
  }

  // ------------------------------------------------------------------ angle bend
  let eAngle = 0;
  {
    const idx = k.angleIdx;
    const par = k.anglePar;
    for (let t = 0, q = 0, m = idx.length; t < m; t += 4, q += 5) {
      const i3 = 3 * idx[t];
      const j3 = 3 * idx[t + 1];
      const k3 = 3 * idx[t + 2];
      const order = idx[t + 3];
      const ka = par[q];
      const theta0 = par[q + 1];
      const ax = x[i3] - x[j3];
      const ay = x[i3 + 1] - x[j3 + 1];
      const az = x[i3 + 2] - x[j3 + 2];
      const bx = x[k3] - x[j3];
      const by = x[k3 + 1] - x[j3 + 1];
      const bz = x[k3 + 2] - x[j3 + 2];
      const dist1 = Math.sqrt(ax * ax + ay * ay + az * az);
      const dist2 = Math.sqrt(bx * bx + by * by + bz * bz);

      let cosTheta = (ax * bx + ay * by + az * bz) / (dist1 * dist2);
      if (cosTheta > 1.0) cosTheta = 1.0;
      else if (cosTheta < -1.0) cosTheta = -1.0;
      // we need sin^2(theta) to get cos(2*theta), so compute that:
      const sinThetaSq = 1.0 - cosTheta * cosTheta;
      let angleTerm: number;
      if (order === 0) {
        // cos(2x) = cos^2(x) - sin^2(x);
        angleTerm = par[q + 2] + par[q + 3] * cosTheta + par[q + 4] * (cosTheta * cosTheta - sinThetaSq);
      } else {
        let res: number;
        if (order === 1) {
          res = -cosTheta;
        } else if (order === 2) {
          res = cosTheta * cosTheta - sinThetaSq;
        } else if (order === 3) {
          // cos(3x) = cos^3(x) - 3*cos(x)*sin^2(x)
          res = cosTheta * (cosTheta * cosTheta - 3.0 * sinThetaSq);
        } else {
          // cos(4x) = cos^4(x) - 6*cos^2(x)*sin^2(x)+sin^4(x)
          const c2 = cosTheta * cosTheta;
          res = c2 * c2 - 6.0 * cosTheta * cosTheta * sinThetaSq + sinThetaSq * sinThetaSq;
        }
        angleTerm = (1.0 - res) / (order * order);
      }
      let e = ka * angleTerm;
      // The original UFF has no penalty for angles near zero, which lets 1-3 atoms overlap. RDKit
      // adds an empirical exponential penalty (borrowed from Open Babel) below about 30 degrees.
      if (order !== 0 && cosTheta > ANGLE_CORRECTION_THRESHOLD) {
        e += Math.exp(-20.0 * (Math.acos(cosTheta) - theta0 + 0.25));
      }
      eAngle += e;

      if (g !== null) {
        const r0x = ax / dist1;
        const r0y = ay / dist1;
        const r0z = az / dist1;
        const r1x = bx / dist2;
        const r1y = by / dist2;
        const r1z = bz / dist2;
        let cosG = r0x * r1x + r0y * r1y + r0z * r1z;
        if (cosG > 1.0) cosG = 1.0;
        else if (cosG < -1.0) cosG = -1.0;
        const sinTheta = Math.max(Math.sqrt(1.0 - cosG * cosG), 1.0e-8);
        // dE/dTheta is independent of cartesians:
        let dEdTheta: number;
        const sin2Theta = 2.0 * sinTheta * cosG;
        if (order === 0) {
          dEdTheta = -1.0 * ka * (par[q + 3] * sinTheta + 2.0 * par[q + 4] * sin2Theta);
        } else {
          // E = k/n^2 [1-cos(n theta)]
          if (order === 1) {
            dEdTheta = -sinTheta;
          } else if (order === 2) {
            dEdTheta = sin2Theta;
          } else if (order === 3) {
            // sin(3*x) = 3*sin(x) - 4*sin^3(x)
            dEdTheta = sinTheta * (3.0 - 4.0 * sinTheta * sinTheta);
          } else {
            // sin(4*x) = cos(x)*(4*sin(x) - 8*sin^3(x))
            dEdTheta = cosG * sinTheta * (4.0 - 8.0 * sinTheta * sinTheta);
          }
          dEdTheta *= ka / order;
          if (cosG > ANGLE_CORRECTION_THRESHOLD) {
            dEdTheta += -20.0 * Math.exp(-20.0 * (Math.acos(cosG) - theta0 + 0.25));
          }
        }
        // use the chain rule: dE/dx = dE/dTheta * dTheta/dx
        const f = dEdTheta / -sinTheta;
        const c0x = (r1x - cosG * r0x) / dist1;
        const c0y = (r1y - cosG * r0y) / dist1;
        const c0z = (r1z - cosG * r0z) / dist1;
        const c1x = (r0x - cosG * r1x) / dist2;
        const c1y = (r0y - cosG * r1y) / dist2;
        const c1z = (r0z - cosG * r1z) / dist2;
        g[i3] += f * c0x;
        g[i3 + 1] += f * c0y;
        g[i3 + 2] += f * c0z;
        g[j3] += f * (-c0x - c1x);
        g[j3 + 1] += f * (-c0y - c1y);
        g[j3 + 2] += f * (-c0z - c1z);
        g[k3] += f * c1x;
        g[k3 + 1] += f * c1y;
        g[k3 + 2] += f * c1z;
      }
    }
  }

  // ------------------------------------------------------------------ van der Waals
  let eVdw = 0;
  {
    const n = k.nAtoms;
    const type = k.vdwType;
    const frag = k.vdwFragment;
    const exclStart = k.vdwExclStart;
    const exclJ = k.vdwExclJ;
    const nT = k.nVdwTypes;
    const tabX = k.vdwXij;
    const tabD = k.vdwDij;
    const tabThresh = k.vdwThresh;
    for (let i = 0; i < n - 1; i++) {
      const i3 = 3 * i;
      const xi = x[i3];
      const yi = x[i3 + 1];
      const zi = x[i3 + 2];
      const row = type[i] * nT;
      const fi = frag[i];
      let e = exclStart[i];
      const eEnd = exclStart[i + 1];
      let nextExcl = e < eEnd ? exclJ[e] : n;
      let gix = 0;
      let giy = 0;
      let giz = 0;
      for (let j = i + 1; j < n; j++) {
        if (j === nextExcl) {
          e++;
          nextExcl = e < eEnd ? exclJ[e] : n;
          continue;
        }
        if (frag[j] !== fi) continue;
        const j3 = 3 * j;
        const dx = xi - x[j3];
        const dy = yi - x[j3 + 1];
        const dz = zi - x[j3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const tp = row + type[j];
        if (dist > tabThresh[tp]) continue;
        if (dist <= 0.0) {
          // the energy of exactly coincident atoms is taken as zero
          if (g !== null) {
            // move in an arbitrary direction
            gix += 100.0;
            giy += 100.0;
            giz += 100.0;
            g[j3] -= 100.0;
            g[j3 + 1] -= 100.0;
            g[j3 + 2] -= 100.0;
          }
          continue;
        }
        const xij = tabX[tp];
        const wellDepth = tabD[tp];
        const r = xij / dist;
        const r3 = r * r * r;
        const r6 = r3 * r3;
        const r12 = r6 * r6;
        eVdw += wellDepth * (r12 - 2.0 * r6);
        if (g !== null) {
          const pre = (((12.0 * wellDepth) / xij) * (r6 * r - r12 * r)) / dist;
          gix += pre * dx;
          giy += pre * dy;
          giz += pre * dz;
          g[j3] -= pre * dx;
          g[j3 + 1] -= pre * dy;
          g[j3 + 2] -= pre * dz;
        }
      }
      if (g !== null) {
        g[i3] += gix;
        g[i3 + 1] += giy;
        g[i3 + 2] += giz;
      }
    }
  }

  // ------------------------------------------------------------------ torsion
  let eTorsion = 0;
  {
    const idx = k.torsionIdx;
    const par = k.torsionPar;
    for (let t = 0, q = 0, m = idx.length; t < m; t += 5, q += 2) {
      const i3 = 3 * idx[t];
      const j3 = 3 * idx[t + 1];
      const k3 = 3 * idx[t + 2];
      const l3 = 3 * idx[t + 3];
      const order = idx[t + 4];
      const V = par[q];
      const cosTerm = par[q + 1];
      // r[0] = p1 - p2, r[1] = p3 - p2, r[2] = p2 - p3, r[3] = p4 - p3
      const r0x = x[i3] - x[j3];
      const r0y = x[i3 + 1] - x[j3 + 1];
      const r0z = x[i3 + 2] - x[j3 + 2];
      const r1x = x[k3] - x[j3];
      const r1y = x[k3 + 1] - x[j3 + 1];
      const r1z = x[k3 + 2] - x[j3 + 2];
      const r2x = -r1x;
      const r2y = -r1y;
      const r2z = -r1z;
      const r3x = x[l3] - x[k3];
      const r3y = x[l3 + 1] - x[k3 + 1];
      const r3z = x[l3 + 2] - x[k3 + 2];
      // t[0] = r[0] x r[1], t[1] = r[2] x r[3]
      let t0x = r0y * r1z - r0z * r1y;
      let t0y = r0z * r1x - r0x * r1z;
      let t0z = r0x * r1y - r0y * r1x;
      let t1x = r2y * r3z - r2z * r3y;
      let t1y = r2z * r3x - r2x * r3z;
      let t1z = r2x * r3y - r2y * r3x;
      const len0 = Math.sqrt(t0x * t0x + t0y * t0y + t0z * t0z);
      const len1 = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z);

      // Utils::calculateCosTorsion
      let cosPhi: number;
      if (len0 < 1.0e-10 || len1 < 1.0e-10) {
        cosPhi = 0.0;
      } else {
        cosPhi = (t0x * t1x + t0y * t1y + t0z * t1z) / (len0 * len1);
        if (cosPhi > 1.0) cosPhi = 1.0;
        else if (cosPhi < -1.0) cosPhi = -1.0;
      }
      const sinPhiSq = 1.0 - cosPhi * cosPhi;
      // E(phi) = V/2 * (1 - cos(n*phi_0)*cos(n*phi))
      let cosNPhi: number;
      if (order === 2) {
        // cos(2x) = 1 - 2sin^2(x)
        cosNPhi = 1.0 - 2.0 * sinPhiSq;
      } else if (order === 3) {
        // cos(3x) = cos^3(x) - 3*cos(x)*sin^2(x)
        cosNPhi = cosPhi * (cosPhi * cosPhi - 3.0 * sinPhiSq);
      } else {
        // cos(6x) = 1 - 32*sin^6(x) + 48*sin^4(x) - 18*sin^2(x)
        cosNPhi = 1.0 + sinPhiSq * (-32.0 * sinPhiSq * sinPhiSq + 48.0 * sinPhiSq - 18.0);
      }
      eTorsion += (V / 2.0) * (1.0 - cosTerm * cosNPhi);

      if (g !== null) {
        // ForceFieldsHelper::computeDihedral
        const d0 = Math.max(len0, 1.0e-5);
        const d1 = Math.max(len1, 1.0e-5);
        t0x /= d0;
        t0y /= d0;
        t0z /= d0;
        t1x /= d1;
        t1y /= d1;
        t1z /= d1;
        let cosG = t0x * t1x + t0y * t1y + t0z * t1z;
        if (cosG > 1.0) cosG = 1.0;
        else if (cosG < -1.0) cosG = -1.0;
        const sinSqG = 1.0 - cosG * cosG;
        const sinG = sinSqG > 0.0 ? Math.sqrt(sinSqG) : 0.0;
        // dE/dPhi is independent of cartesians:
        let dEdPhi: number;
        if (order === 2) {
          dEdPhi = 2.0 * sinG * cosG;
        } else if (order === 3) {
          // sin(3*x) = 3*sin(x) - 4*sin^3(x)
          dEdPhi = sinG * (3.0 - 4.0 * sinSqG);
        } else {
          // sin(6x) = cos(x) * [ 32*sin^5(x) - 32*sin^3(x) + 6*sin(x) ]
          dEdPhi = cosG * sinG * (32.0 * sinSqG * (sinSqG - 1.0) + 6.0);
        }
        dEdPhi *= (V / 2.0) * cosTerm * -1.0 * order;
        const sinTerm = dEdPhi * (sinG < 1.0e-10 ? 1.0 / cosG : 1.0 / sinG);

        // Utils::calcTorsionGrad
        const a0 = (t1x - cosG * t0x) / d0;
        const a1 = (t1y - cosG * t0y) / d0;
        const a2 = (t1z - cosG * t0z) / d0;
        const a3 = (t0x - cosG * t1x) / d1;
        const a4 = (t0y - cosG * t1y) / d1;
        const a5 = (t0z - cosG * t1z) / d1;

        g[i3] += sinTerm * (a2 * r1y - a1 * r1z);
        g[i3 + 1] += sinTerm * (a0 * r1z - a2 * r1x);
        g[i3 + 2] += sinTerm * (a1 * r1x - a0 * r1y);

        g[j3] += sinTerm * (a1 * (r1z - r0z) + a2 * (r0y - r1y) + a4 * -r3z + a5 * r3y);
        g[j3 + 1] += sinTerm * (a0 * (r0z - r1z) + a2 * (r1x - r0x) + a3 * r3z + a5 * -r3x);
        g[j3 + 2] += sinTerm * (a0 * (r1y - r0y) + a1 * (r0x - r1x) + a3 * -r3y + a4 * r3x);

        g[k3] += sinTerm * (a1 * r0z + a2 * -r0y + a4 * (r3z - r2z) + a5 * (r2y - r3y));
        g[k3 + 1] += sinTerm * (a0 * -r0z + a2 * r0x + a3 * (r2z - r3z) + a5 * (r3x - r2x));
        g[k3 + 2] += sinTerm * (a0 * r0y + a1 * -r0x + a3 * (r3y - r2y) + a4 * (r2x - r3x));

        g[l3] += sinTerm * (a4 * r2z - a5 * r2y);
        g[l3 + 1] += sinTerm * (a5 * r2x - a3 * r2z);
        g[l3 + 2] += sinTerm * (a3 * r2y - a4 * r2x);
      }
    }
  }

  // ------------------------------------------------------------------ inversion
  let eInversion = 0;
  {
    const idx = k.inversionIdx;
    const par = k.inversionPar;
    for (let t = 0, m = idx.length; t < m; t += 4) {
      const i3 = 3 * idx[t];
      const j3 = 3 * idx[t + 1];
      const k3 = 3 * idx[t + 2];
      const l3 = 3 * idx[t + 3];
      const K = par[t];
      const C0 = par[t + 1];
      const C1 = par[t + 2];
      const C2 = par[t + 3];
      let jix = x[i3] - x[j3];
      let jiy = x[i3 + 1] - x[j3 + 1];
      let jiz = x[i3 + 2] - x[j3 + 2];
      let jkx = x[k3] - x[j3];
      let jky = x[k3 + 1] - x[j3 + 1];
      let jkz = x[k3 + 2] - x[j3 + 2];
      let jlx = x[l3] - x[j3];
      let jly = x[l3 + 1] - x[j3 + 1];
      let jlz = x[l3 + 2] - x[j3 + 2];
      const l2JI = jix * jix + jiy * jiy + jiz * jiz;
      const l2JK = jkx * jkx + jky * jky + jkz * jkz;
      const l2JL = jlx * jlx + jly * jly + jlz * jlz;

      // Utils::calculateCosY: the cosine of the angle between the J-L bond and the normal to the I-J-K plane
      let cosY = 0.0;
      if (!(l2JI < 1.0e-16 || l2JK < 1.0e-16 || l2JL < 1.0e-16)) {
        const s = Math.sqrt(l2JI) * Math.sqrt(l2JK);
        const nx = (jiy * jkz - jiz * jky) / s;
        const ny = (jiz * jkx - jix * jkz) / s;
        const nz = (jix * jky - jiy * jkx) / s;
        const l2n = nx * nx + ny * ny + nz * nz;
        if (!(l2n < 1.0e-16)) {
          cosY = (nx * jlx + ny * jly + nz * jlz) / (Math.sqrt(l2JL) * Math.sqrt(l2n));
        }
      }
      const sinYSq = 1.0 - cosY * cosY;
      const sinY = sinYSq > 0.0 ? Math.sqrt(sinYSq) : 0.0;
      // cos(2 * W) = 2 * cos(W) * cos(W) - 1 = 2 * sin(Y) * sin(Y) - 1
      const cos2W = 2.0 * sinY * sinY - 1.0;
      eInversion += K * (C0 + C1 * sinY + C2 * cos2W);

      if (g !== null) {
        const dJI = Math.sqrt(l2JI);
        const dJK = Math.sqrt(l2JK);
        const dJL = Math.sqrt(l2JL);
        if (dJI < 1.0e-10 || dJK < 1.0e-10 || dJL < 1.0e-10) continue;
        jix /= dJI;
        jiy /= dJI;
        jiz /= dJI;
        jkx /= dJK;
        jky /= dJK;
        jkz /= dJK;
        jlx /= dJL;
        jly /= dJL;
        jlz /= dJL;
        // n = (-rJI) x rJK
        let nx = -jiy * jkz + jiz * jky;
        let ny = -jiz * jkx + jix * jkz;
        let nz = -jix * jky + jiy * jkx;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        let cosTheta = jix * jkx + jiy * jky + jiz * jkz;
        if (cosTheta > 1.0) cosTheta = 1.0;
        else if (cosTheta < -1.0) cosTheta = -1.0;
        const sinThetaSq = 1.0 - cosTheta * cosTheta;
        // I, J and K on one line: the plane, and with it the gradient, is undefined. RDKit divides
        // by zero here; the term is skipped instead.
        if (!(nLen > 0.0) || !(sinThetaSq > 0.0)) continue;
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
        let cosYg = nx * jlx + ny * jly + nz * jlz;
        if (cosYg > 1.0) cosYg = 1.0;
        else if (cosYg < -1.0) cosYg = -1.0;
        const sinYg = Math.max(Math.sqrt(1.0 - cosYg * cosYg), 1.0e-8);
        const sinTheta = Math.max(Math.sqrt(sinThetaSq), 1.0e-8);
        // sin(2 * W) = 2 * sin(W) * cos(W) = 2 * cos(Y) * sin(Y)
        const dEdW = -K * (C1 * cosYg + 4.0 * C2 * cosYg * sinYg);
        // t1 = rJL x rJK, t2 = rJI x rJL, t3 = rJK x rJI
        const t1x = jly * jkz - jlz * jky;
        const t1y = jlz * jkx - jlx * jkz;
        const t1z = jlx * jky - jly * jkx;
        const t2x = jiy * jlz - jiz * jly;
        const t2y = jiz * jlx - jix * jlz;
        const t2z = jix * jly - jiy * jlx;
        const t3x = jky * jiz - jkz * jiy;
        const t3y = jkz * jix - jkx * jiz;
        const t3z = jkx * jiy - jky * jix;
        const term1 = sinYg * sinTheta;
        const term2 = cosYg / (sinYg * sinThetaSq);
        const tg1x = (t1x / term1 - (jix - jkx * cosTheta) * term2) / dJI;
        const tg1y = (t1y / term1 - (jiy - jky * cosTheta) * term2) / dJI;
        const tg1z = (t1z / term1 - (jiz - jkz * cosTheta) * term2) / dJI;
        const tg3x = (t2x / term1 - (jkx - jix * cosTheta) * term2) / dJK;
        const tg3y = (t2y / term1 - (jky - jiy * cosTheta) * term2) / dJK;
        const tg3z = (t2z / term1 - (jkz - jiz * cosTheta) * term2) / dJK;
        const tg4x = (t3x / term1 - (jlx * cosYg) / sinYg) / dJL;
        const tg4y = (t3y / term1 - (jly * cosYg) / sinYg) / dJL;
        const tg4z = (t3z / term1 - (jlz * cosYg) / sinYg) / dJL;
        g[i3] += dEdW * tg1x;
        g[i3 + 1] += dEdW * tg1y;
        g[i3 + 2] += dEdW * tg1z;
        g[j3] += -dEdW * (tg1x + tg3x + tg4x);
        g[j3 + 1] += -dEdW * (tg1y + tg3y + tg4y);
        g[j3 + 2] += -dEdW * (tg1z + tg3z + tg4z);
        g[k3] += dEdW * tg3x;
        g[k3 + 1] += dEdW * tg3y;
        g[k3 + 2] += dEdW * tg3z;
        g[l3] += dEdW * tg4x;
        g[l3 + 1] += dEdW * tg4y;
        g[l3 + 2] += dEdW * tg4z;
      }
    }
  }

  if (terms !== null) {
    terms[TERM_BOND] = eBond;
    terms[TERM_ANGLE] = eAngle;
    terms[TERM_TORSION] = eTorsion;
    terms[TERM_INVERSION] = eInversion;
    terms[TERM_VDW] = eVdw;
  }
  // RDKit sums its contributions in construction order: bonds, angles, van der Waals, torsions, inversions.
  return eBond + eAngle + eVdw + eTorsion + eInversion;
}
