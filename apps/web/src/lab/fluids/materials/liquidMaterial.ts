/**
 * Liquid body material. The color passed in must already be the final composited color (the
 * liquid's own tint blended with any indicator reading — see `color/liquidTint.ts` and
 * `color/indicatorColor.ts`); this module only turns a color into a convincing wet/translucent
 * surface, the same transmission-vs-alpha-fallback choice as `materials/glassMaterial.ts`.
 */
import { Color, DoubleSide, FrontSide, MeshPhysicalMaterial } from 'three';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface LiquidMaterialOptions {
  readonly colorHex: string;
  /** 0 (almost invisible, like pure water) to 1 (strongly tinted); a look parameter, not a concentration reading. */
  readonly opacity?: number;
}

const DEFAULT_OPACITY = 0.78;
/** Water's refractive index, as commonly tabulated (~1.33). */
const WATER_IOR = 1.33;
/**
 * Transmission-ray sample depth, meters — must stay on the order of the vessel's own size (a few
 * centimeters here), not an arbitrary "real" liquid depth; too large pushes the refraction sample
 * off the pre-rendered transmission texture and reads back as solid black (see
 * `materials/glassMaterial.ts`'s header comment for the same failure mode found via screenshots).
 */
const TRANSMISSION_THICKNESS_M = 0.012;

export function createLiquidMaterial(quality: FluidQualitySettings, options: LiquidMaterialOptions): MeshPhysicalMaterial {
  const color = new Color(options.colorHex);
  if (quality.liquidTransmission) {
    const material = new MeshPhysicalMaterial({
      color,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.92,
      thickness: TRANSMISSION_THICKNESS_M,
      ior: WATER_IOR,
      clearcoat: 0.25,
      clearcoatRoughness: 0.1,
      // FrontSide, not DoubleSide — see the matching note in materials/glassMaterial.ts: the liquid
      // body's own side wall is an open (hollow) lathe shell, so DoubleSide would submit its near
      // and far walls as two separate transmissive fragments per ray.
      side: FrontSide,
      transparent: true,
      depthWrite: false,
    });
    material.attenuationColor.set(options.colorHex);
    // Beer-Lambert over `thickness`: exp(-thickness/attenuationDistance). 0.1 m here gave under
    // 15% absorption over a 1.2 cm path — visually indistinguishable from clear, which is how a
    // "tinted liquid" regression scene was found to show no visible tint at all. 0.006 m gives
    // ~86% absorption over the same path: a clearly saturated color for strongly colored species,
    // while a pale `colorHex` (plain water) still nets out pale since it attenuates toward itself.
    material.attenuationDistance = 0.006;
    return material;
  }
  return new MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.15,
    transparent: true,
    opacity: options.opacity ?? DEFAULT_OPACITY,
    clearcoat: 0.3,
    side: DoubleSide,
    depthWrite: false,
  });
}

/**
 * Updates an existing liquid material's color in place — much cheaper than rebuilding the material
 * every time the indicator color eases to a new value, which can happen every frame near an
 * endpoint transition.
 */
export function updateLiquidMaterial(material: MeshPhysicalMaterial, options: LiquidMaterialOptions): void {
  material.color.set(options.colorHex);
  if (material.transmission > 0) material.attenuationColor.set(options.colorHex);
  else if (options.opacity !== undefined) material.opacity = options.opacity;
}
