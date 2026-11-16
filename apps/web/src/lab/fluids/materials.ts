import { Color, FrontSide, MeshPhysicalMaterial, SRGBColorSpace } from 'three';
import type { ColorSrgb, FluidVisualSettings } from './types';
import { resolveFluidSettings } from './quality';

export interface GlassMaterialOptions extends FluidVisualSettings {
  readonly thicknessM?: number;
}

export interface LiquidAppearance {
  readonly colorSrgb: ColorSrgb;
  readonly opacity: number;
  readonly evidence: 'ILLUSTRATIVE';
  readonly indicatorRecordId?: string;
}

export const CLEAR_LIQUID_APPEARANCE: LiquidAppearance = Object.freeze({
  colorSrgb: [1, 1, 1] as const, opacity: 0.24, evidence: 'ILLUSTRATIVE',
});

function srgb(color: ColorSrgb): Color {
  return new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace);
}

/** Standard physical materials are converted by Three's node renderer; there is no GLSL patch. */
export function createGlassMaterial(options: GlassMaterialOptions = {}): MeshPhysicalMaterial {
  const settings = resolveFluidSettings(options);
  const physical = settings.materialMode === 'physical';
  const thicknessM = Number.isFinite(options.thicknessM) && options.thicknessM! > 0
    ? Math.min(0.02, options.thicknessM!) : 0.0012;
  const material = new MeshPhysicalMaterial({
    color: '#f4fbff', roughness: physical ? 0.07 : 0.18, metalness: 0,
    transmission: physical ? 0.96 : 0, thickness: thicknessM, ior: 1.47,
    attenuationColor: '#d5f3f3', attenuationDistance: 0.6,
    transparent: true, opacity: physical ? 0.92 : 0.17,
    depthWrite: false, depthTest: true, side: FrontSide,
    clearcoat: settings.lowPower ? 0 : 0.3, clearcoatRoughness: 0.09,
  });
  material.name = 'lab-glass-illustrative';
  material.userData = { evidence: 'ILLUSTRATIVE', units: 'm', materialMode: settings.materialMode };
  return material;
}

export function createLiquidMaterial(
  settings: FluidVisualSettings = {}, appearance: LiquidAppearance = CLEAR_LIQUID_APPEARANCE,
): MeshPhysicalMaterial {
  const quality = resolveFluidSettings(settings);
  const physical = quality.materialMode === 'physical';
  const material = new MeshPhysicalMaterial({
    color: srgb(appearance.colorSrgb), roughness: physical ? 0.14 : 0.23, metalness: 0,
    transmission: physical ? 0.35 : 0, thickness: 0.015, ior: 1.333,
    attenuationColor: srgb(appearance.colorSrgb), attenuationDistance: 0.12,
    transparent: true, opacity: appearance.opacity,
    depthWrite: false, depthTest: true, side: FrontSide,
    clearcoat: quality.lowPower ? 0 : 0.22, clearcoatRoughness: 0.12,
  });
  material.name = 'lab-liquid-illustrative';
  material.userData = { evidence: 'ILLUSTRATIVE', units: 'm', materialMode: quality.materialMode };
  return material;
}

export function setLiquidAppearance(material: MeshPhysicalMaterial, appearance: LiquidAppearance): void {
  material.color.setRGB(...appearance.colorSrgb, SRGBColorSpace);
  material.attenuationColor.copy(material.color);
  material.opacity = appearance.opacity;
}
