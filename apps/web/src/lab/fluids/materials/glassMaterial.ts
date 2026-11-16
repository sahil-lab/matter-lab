/**
 * PBR glass shell material for burettes, flasks, beakers and reagent bottles. At tiers that enable
 * `glassTransmission` this uses three.js's built-in transmission render pass (the same technique as
 * the official `webgl_materials_physical_transmission` example: `transmission` + `thickness` +
 * `ior` on `MeshPhysicalMaterial`, no custom shader code), which gives real refraction through the
 * glass at the cost of an extra render pass per object. Lower tiers fall back to ordinary alpha
 * blending, which has no such cost and still reads as glass at typical camera distances.
 *
 * The vessel's *silhouette* thickness is geometric and real (`geometry/latheProfile.ts`'s
 * `glassShellPoints` actually offsets the outer wall by `wallThicknessM`). The `thickness` value
 * given to the material below is a separate, exaggerated rendering parameter that controls how far
 * the transmission pass's refraction ray travels through the volume — real glassware walls are
 * only ~1-2 mm, which would barely bend light at all at this scale, so this value is deliberately
 * larger for a legible refraction effect at camera distance. It is a look parameter, not a
 * measurement, and is not used anywhere a chemical quantity is read from.
 */
import { Color, DoubleSide, MeshPhysicalMaterial } from 'three';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface GlassMaterialOptions {
  readonly wallThicknessM: number;
  /** Optional body tint, e.g. the amber of a UV-protective reagent bottle. Omit for clear glass. */
  readonly tintHex?: string;
}

const CLEAR_GLASS = '#f3f8f7';
/** Soda-lime glass's refractive index, as commonly tabulated (~1.5) — used purely for the look of the refraction, not asserted as a measurement of any specific real vessel. */
const GLASS_IOR = 1.5;

export function createGlassMaterial(quality: FluidQualitySettings, options: GlassMaterialOptions): MeshPhysicalMaterial {
  const tint = options.tintHex ?? CLEAR_GLASS;
  const color = new Color(tint);
  if (quality.glassTransmission) {
    const material = new MeshPhysicalMaterial({
      color,
      metalness: 0,
      roughness: 0.045,
      transmission: 1,
      thickness: Math.max(options.wallThicknessM, 0.0004) * 24,
      ior: GLASS_IOR,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    if (options.tintHex) {
      material.attenuationColor.set(options.tintHex);
      material.attenuationDistance = 0.12;
    }
    return material;
  }
  return new MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.12,
    transparent: true,
    opacity: options.tintHex ? 0.5 : 0.22,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
    envMapIntensity: 1.1,
    side: DoubleSide,
    depthWrite: false,
  });
}
