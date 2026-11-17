import { describe, expect, it } from 'vitest';
import type { ContainerContents } from '@matterlab/contracts';
import { applyTransfer, buildFilledContents, clampTransferVolume, totalMoles } from './inventory';

function contents(overrides: Partial<ContainerContents> = {}): ContainerContents {
  return { volumeL: 0, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'test-v1', ...overrides };
}

describe('buildFilledContents', () => {
  it('builds contents from a valid FILL request', () => {
    const result = buildFilledContents(
      { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' },
      0.25,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.volumeL).toBeCloseTo(0.025);
      expect(result.value.species).toEqual([{ speciesId: 'HCl', moles: 0.0025 }]);
    }
  });

  it('rejects a negative volume', () => {
    const result = buildFilledContents({ volumeL: -1, species: [], temperatureK: 298.15, modelId: 'x' }, undefined);
    expect(result.ok).toBe(false);
  });

  it('rejects a volume exceeding declared capacity', () => {
    const result = buildFilledContents({ volumeL: 1, species: [], temperatureK: 298.15, modelId: 'x' }, 0.5);
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate speciesId', () => {
    const result = buildFilledContents(
      { volumeL: 0.1, species: [{ speciesId: 'HCl', moles: 1 }, { speciesId: 'HCl', moles: 2 }], temperatureK: 298.15, modelId: 'x' },
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive temperature', () => {
    const result = buildFilledContents({ volumeL: 0.1, species: [], temperatureK: 0, modelId: 'x' }, undefined);
    expect(result.ok).toBe(false);
  });
});

describe('applyTransfer', () => {
  it('conserves volume exactly: source decrease equals receiver increase', () => {
    const source = contents({ volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }] });
    const receiver = contents({ volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }] });
    const result = applyTransfer(source, receiver, 0.01, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sourceDecrease = source.volumeL - result.value.source.volumeL;
    const receiverIncrease = result.value.receiver.volumeL - receiver.volumeL;
    expect(sourceDecrease).toBeCloseTo(receiverIncrease, 12);
    expect(result.value.appliedVolumeL).toBeCloseTo(0.01, 12);
  });

  it('conserves species moles exactly across source and receiver', () => {
    const source = contents({ volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }] });
    const receiver = contents({ volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }] });
    const totalBefore = totalMoles([source, receiver], 'NaOH');
    const result = applyTransfer(source, receiver, 0.01, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totalAfter = totalMoles([result.value.source, result.value.receiver], 'NaOH');
    expect(totalAfter).toBeCloseTo(totalBefore, 12);
  });

  it('clamps to the available source volume and warns, instead of over-draining', () => {
    const source = contents({ volumeL: 0.01, species: [{ speciesId: 'NaOH', moles: 0.001 }] });
    const receiver = contents({ volumeL: 0, species: [] });
    const result = applyTransfer(source, receiver, 0.05, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appliedVolumeL).toBeCloseTo(0.01, 12);
    expect(result.value.source.volumeL).toBeCloseTo(0, 12);
    expect(result.value.warnings.some((w) => /clamped/i.test(w))).toBe(true);
  });

  it('clamps to the receiver headroom and warns, instead of overflowing capacity', () => {
    const source = contents({ volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }] });
    const receiver = contents({ volumeL: 0.24, species: [] });
    const result = applyTransfer(source, receiver, 0.02, 0.25);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appliedVolumeL).toBeCloseTo(0.01, 12);
    expect(result.value.receiver.volumeL).toBeCloseTo(0.25, 12);
    expect(result.value.warnings.some((w) => /headroom/i.test(w))).toBe(true);
  });

  it('rejects a non-positive requested volume', () => {
    const source = contents({ volumeL: 0.05 });
    const receiver = contents();
    expect(applyTransfer(source, receiver, 0, undefined).ok).toBe(false);
    expect(applyTransfer(source, receiver, -0.01, undefined).ok).toBe(false);
  });

  it('rejects a transfer from an empty source', () => {
    const source = contents({ volumeL: 0 });
    const receiver = contents();
    const result = applyTransfer(source, receiver, 0.01, undefined);
    expect(result.ok).toBe(false);
  });

  it('merges a species already present in the receiver by summing moles', () => {
    const source = contents({ volumeL: 0.01, species: [{ speciesId: 'NaOH', moles: 0.001 }] });
    const receiver = contents({ volumeL: 0.01, species: [{ speciesId: 'NaOH', moles: 0.0005 }] });
    const result = applyTransfer(source, receiver, 0.01, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receiver.species).toHaveLength(1);
    expect(result.value.receiver.species[0]!.moles).toBeCloseTo(0.0015, 12);
  });

  it('mixes temperature by volume-weighted average', () => {
    const source = contents({ volumeL: 0.01, temperatureK: 320, species: [] });
    const receiver = contents({ volumeL: 0.01, temperatureK: 300, species: [] });
    const result = applyTransfer(source, receiver, 0.01, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receiver.temperatureK).toBeCloseTo(310, 6);
  });
});

describe('clampTransferVolume', () => {
  it('never returns a negative applied volume', () => {
    const source = contents({ volumeL: 0 });
    const receiver = contents({ volumeL: 0 });
    const preview = clampTransferVolume(source, receiver, -5, undefined);
    expect(preview.appliedVolumeL).toBe(0);
  });
});
