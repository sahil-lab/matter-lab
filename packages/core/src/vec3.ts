import type { Vec3 } from './types';

export const ZERO3: Vec3 = [0, 0, 0];

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vscale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vlen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Unit vector along `a`; the zero vector is returned unchanged rather than producing NaN. */
export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : ZERO3;
}

export function vlerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Angle between two vectors in radians, in [0, pi]. Zero-length inputs give 0. */
export function vangle(a: Vec3, b: Vec3): number {
  const la = vlen(a);
  const lb = vlen(b);
  if (la === 0 || lb === 0) return 0;
  return Math.acos(Math.min(1, Math.max(-1, vdot(a, b) / (la * lb))));
}

/** Rotates `v` about the unit vector `axis` by `angle` radians (right-hand rule, Rodrigues' formula). */
export function vrotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = vdot(axis, v) * (1 - c);
  const x = vcross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

/** Rotates the point `p` about the line through `origin` along the unit vector `axis`. */
export function vrotateAbout(p: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  return vadd(origin, vrotate(vsub(p, origin), axis, angle));
}

/** A unit vector perpendicular to `v`, chosen deterministically. */
export function vperp(v: Vec3): Vec3 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  const helper: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return vnorm(vcross(v, helper));
}

export function vcentroid(points: Iterable<Vec3>): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
    n++;
  }
  return n === 0 ? ZERO3 : [x / n, y / n, z / n];
}

export function vequal(a: Vec3, b: Vec3, eps = 0): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}
