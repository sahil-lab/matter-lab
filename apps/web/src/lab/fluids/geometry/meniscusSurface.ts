/**
 * The liquid's top surface: a flat disc mesh capping the lathe-built side wall (`latheProfile.ts`),
 * displaced into a shallow concave dimple (the real shape of a wetting liquid's meniscus in a
 * narrow glass vessel) plus an optional decorative swirl/ripple while stirring. Every number this
 * module produces is a rendering offset applied on top of the authoritative meniscus *height*
 * (`vesselProfile.heightForVolume`); it never changes which height that surface sits at, and it
 * never feeds anything back into `ContainerContents.volumeL`.
 */
import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';

export interface MeniscusParams {
  /**
   * Static concave dip depth at the vessel axis, in meters. Real menisci run from a few hundredths
   * of a millimeter (wide beaker) to roughly a millimeter (narrow burette bore); this is a rendering
   * parameter tuned for legibility at typical camera distances, not a per-liquid measurement, and is
   * always ILLUSTRATIVE.
   */
  readonly dipDepthM: number;
  /** 0 = perfectly still liquid, 1 = vigorous stirring/swirl. Purely decorative. */
  readonly agitation: number;
  /** Angular speed of the swirl pattern, radians/second (e.g. driven by a magnetic stirrer). */
  readonly swirlSpeedRadPerS: number;
}

export const STILL_MENISCUS: MeniscusParams = { dipDepthM: 0.00035, agitation: 0, swirlSpeedRadPerS: 0 };

/**
 * Builds a flat radial-grid disc of the given radius, centered on the vessel axis at y=0. Call
 * `applyMeniscusDisplacement` afterwards (and again on every animated frame) to curve it.
 */
export function buildMeniscusDisc(radiusM: number, rings = 5, segments = 32): BufferGeometry {
  const ringCount = Math.max(1, Math.round(rings));
  const segCount = Math.max(8, Math.round(segments));
  const positions: number[] = [0, 0, 0];
  for (let ring = 1; ring <= ringCount; ring++) {
    const r = (ring / ringCount) * Math.max(radiusM, 0);
    for (let seg = 0; seg < segCount; seg++) {
      const theta = (seg / segCount) * Math.PI * 2;
      positions.push(r * Math.cos(theta), 0, r * Math.sin(theta));
    }
  }

  const indices: number[] = [];
  for (let seg = 0; seg < segCount; seg++) {
    indices.push(0, 1 + seg, 1 + ((seg + 1) % segCount));
  }
  for (let ring = 1; ring < ringCount; ring++) {
    const base0 = 1 + (ring - 1) * segCount;
    const base1 = 1 + ring * segCount;
    for (let seg = 0; seg < segCount; seg++) {
      const i0 = base0 + seg;
      const i1 = base0 + ((seg + 1) % segCount);
      const i2 = base1 + seg;
      const i3 = base1 + ((seg + 1) % segCount);
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The vertical displacement (meters) of one surface point at radius `r` and angle `theta` from the
 * vessel axis. `radiusM` is the liquid's current radius at the meniscus height (not the disc mesh's
 * own radius argument above, though in practice they are built to match) — zero outside it caller's
 * responsibility to clamp. Pure and deterministic so it can be unit tested without a renderer.
 */
export function meniscusDisplacement(r: number, theta: number, radiusM: number, timeS: number, params: MeniscusParams): number {
  if (radiusM <= 0) return 0;
  const edge = Math.min(1, Math.max(0, r / radiusM));
  // Concave dip: zero at the wall (liquid climbs the glass by wetting), deepest at the centre.
  const dip = -params.dipDepthM * (1 - edge * edge);
  if (params.agitation <= 0) return dip;
  const swirl = Math.sin(theta * 3 - timeS * params.swirlSpeedRadPerS) * edge;
  const ripple = Math.sin(timeS * 2.3 + r * 40) * 0.35;
  return dip + params.agitation * params.dipDepthM * 1.4 * (swirl * 0.6 + ripple * 0.4);
}

/** Displaces every vertex of a disc built by `buildMeniscusDisc` in place and recomputes normals. */
export function applyMeniscusDisplacement(geometry: BufferGeometry, radiusM: number, timeS: number, params: MeniscusParams): void {
  const position = geometry.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const r = Math.sqrt(x * x + z * z);
    const theta = Math.atan2(z, x);
    position.setY(i, meniscusDisplacement(r, theta, radiusM, timeS, params));
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
}
