import {
  DataTexture, DataUtils, EquirectangularReflectionMapping, HalfFloatType,
  LinearFilter, LinearSRGBColorSpace, RGBAFormat,
} from 'three';
import type { LightingPreset } from './types';

/** Original HDR softbox rig. No remote images, font assets, attribution requirements or network I/O. */
export function createProceduralEnvironment(width = 256, preset: LightingPreset = 'daylight'): DataTexture {
  if (![128, 256, 512].includes(width)) throw new RangeError('Use a bounded environment texture quality.');
  const height = width / 2;
  const pixels = new Uint16Array(width * height * 4);
  const warm = preset === 'evening';
  const neutral = preset === 'neutral';
  for (let row = 0; row < height; row += 1) {
    const theta = (row + 0.5) / height * Math.PI;
    const y = Math.cos(theta);
    for (let column = 0; column < width; column += 1) {
      const phi = (column + 0.5) / width * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi);
      const z = Math.sin(theta) * Math.sin(phi);
      const sky = 0.06 + Math.max(y, 0) * 0.16;
      const key = z < -0.5 && Math.abs(x + 0.14) < 0.38 && Math.abs(y - 0.43) < 0.2 ? 4.5 : 0;
      const rim = x < -0.55 && Math.abs(z - 0.2) < 0.13 && Math.abs(y - 0.28) < 0.5 ? 2.4 : 0;
      const ceiling = y > 0.84 && Math.abs(x) < 0.32 ? 1.8 : 0;
      const fill = z > 0.6 && Math.abs(x - 0.3) < 0.32 && Math.abs(y - 0.3) < 0.26 ? 0.85 : 0;
      const radiance = sky + key + ceiling + fill;
      const offset = (row * width + column) * 4;
      pixels[offset] = DataUtils.toHalfFloat(radiance * (warm ? 1.12 : 0.91) + rim * 0.95);
      pixels[offset + 1] = DataUtils.toHalfFloat(radiance * (warm ? 0.88 : 1) + rim);
      pixels[offset + 2] = DataUtils.toHalfFloat(radiance * (warm ? 0.66 : neutral ? 1 : 1.04) + rim * 0.92);
      pixels[offset + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType);
  texture.name = `matterlab-original-softbox-${preset}-${width}`;
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.userData = { provenance: 'Original procedural environment; generated locally by MATTER LAB.', units: 'render-only' };
  return texture;
}
