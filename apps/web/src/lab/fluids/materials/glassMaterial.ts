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
 * given to the material below is a separate rendering parameter that controls how far the
 * transmission pass's refraction ray samples into the background: it must stay on the order of the
 * vessel's own size (meters), not the real 1-2 mm wall — offsetting the sample by several
 * centimeters (an earlier version of this file multiplied the real wall thickness by 24, giving
 * several centimeters on a vessel only a few centimeters wide) pushes the sampled point off the
 * pre-rendered transmission texture entirely, which reads back as solid black with stray edge
 * artifacts instead of a refracted background. It is a look parameter, not a measurement.
 */
import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial } from 'three';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface GlassMaterialOptions {
  readonly wallThicknessM: number;
  /** Optional body tint, e.g. the amber of a UV-protective reagent bottle. Omit for clear glass. */
  readonly tintHex?: string;
}

const CLEAR_GLASS = '#f3f8f7';
/** Soda-lime glass's refractive index, as commonly tabulated (~1.5) — used purely for the look of the refraction, not asserted as a measurement of any specific real vessel. */
const GLASS_IOR = 1.5;
/** A legible but bounded refraction depth for vessels a few centimeters across; see the header comment. */
const TRANSMISSION_THICKNESS_M = 0.006;

export function createGlassMaterial(quality: FluidQualitySettings, options: GlassMaterialOptions): MeshPhysicalMaterial {
  const tint = options.tintHex ?? CLEAR_GLASS;
  const color = new Color(tint);
  if (quality.glassTransmission) {
    const material = new MeshPhysicalMaterial({
      color,
      metalness: 0,
      roughness: 0.045,
      transmission: 1,
      thickness: TRANSMISSION_THICKNESS_M,
      ior: GLASS_IOR,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
      // FrontSide, not DoubleSide: with transmission, DoubleSide submits the shell's near AND far
      // walls as two separate transmissive fragments along the same camera ray, each running its
      // own transmission sample — verified visually to render as solid black instead of refracting
      // the background. A single outward-facing wall plus `thickness` already gives the "seeing
      // through glass" effect; `GlassVessel`'s lathe geometry does not need a visible back wall.
      side: FrontSide,
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
