import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three';
import type { StageVolume } from './viewApi';
import { volumeTextureData } from './VolumeLayer';

const volume = (): StageVolume => ({
  values: new Float32Array([0, 0.01, -0.01, 1, -1, 500, -500, 0.25]),
  dimensions: [2, 2, 2], origin: [-1, 2, 3], spacing: [0.1, 0.2, 0.3],
  referenceValue: 0.02, colorPositive: '#8080ff', colorNegative: '#ffaa80', opacity: 0.5,
});
describe('scientific volume uploads', () => {
  it('preserves signed scalar samples while mapping grid centers to their physical extent', () => {
    const source = volume();
    const before = source.values.slice();
    const prepared = volumeTextureData(source);
    expect(prepared.size).toEqual([0.1, 0.2, 0.3]);
    for (let i = 0; i < source.values.length; i++) {
      const reconstructed = DataUtils.fromHalfFloat(prepared.data[i]!) * prepared.magnitude;
      const expected = source.values[i]!;
      expect(Math.sign(reconstructed)).toBe(Math.sign(expected));
      expect(Math.abs(reconstructed - expected)).toBeLessThanOrEqual(Math.max(1e-5, Math.abs(expected) * 0.002));
    }
    expect(source.values).toEqual(before);
  });
  it('rejects nonfinite fields, invalid extents and mismatched grids rather than uploading invalid GPU data', () => {
    expect(() => volumeTextureData({ ...volume(), dimensions: [2, 2, 3] })).toThrow(/grid/);
    expect(() => volumeTextureData({ ...volume(), spacing: [0, 1, 1] })).toThrow(/coordinates/);
    const invalid = volume();
    invalid.values[2] = NaN;
    expect(() => volumeTextureData(invalid)).toThrow(/non-finite/);
  });
});
