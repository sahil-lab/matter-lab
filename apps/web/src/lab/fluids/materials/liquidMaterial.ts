/**
 * Liquid body material. The color passed in must already be the final composited color (the
 * liquid's own tint blended with any indicator reading — see `color/liquidTint.ts` and
 * `color/indicatorColor.ts`); this module only turns a color into a convincing wet/translucent
 * surface, the same transmission-vs-alpha-fallback choice as `materials/glassMaterial.ts`.
 */
import { Color, DoubleSide, MeshPhysicalMaterial } from 'three';
import type { FluidQualitySettings } from '../quality/fluidQuality';

export interface LiquidMaterialOptions {
  readonly colorHex: string;
  /** 0 (almost invisible, like pure water) to 1 (strongly tinted); a look parameter, not a concentration reading. */
  readonly opacity?: number;
}

const DEFAULT_OPACITY = 0.78;
/** Water's refractive index, as commonly tabulated (~1.33). */
const WATER_IOR = 1.33;

export function createLiquidMaterial(quality: FluidQualitySettings, options: LiquidMaterialOptions): MeshPhysicalMaterial {
  const color = new Color(options.colorHex);
  if (quality.liquidTransmission) {
    const material = new MeshPhysicalMaterial({
      color,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.92,
      thickness: 0.05,
      ior: WATER_IOR,
      clearcoat: 0.25,
      clearcoatRoughness: 0.1,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    material.attenuationColor.set(options.colorHex);
    material.attenuationDistance = 0.1;
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
