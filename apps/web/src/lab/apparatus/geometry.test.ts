import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Mesh, MeshPhysicalMaterial } from 'three';
import { buildApparatusGeometry, measureApparatusGeometry } from './geometry';
import { APPARATUS_DEFINITIONS, apparatusRegistry } from './registry';

describe('physical apparatus models', () => {
  it('renders every registered instrument within its canonical collision bounds at each quality', () => {
    const measured: Record<string, Record<string, ReturnType<typeof measureApparatusGeometry>>> = {};
    for (const quality of ['low', 'balanced', 'high'] as const) {
      for (const definition of APPARATUS_DEFINITIONS) {
        const model = buildApparatusGeometry(definition, quality);
        try {
          const metrics = measureApparatusGeometry(model);
          (measured[definition.id] ??= {})[quality] = metrics;
          if (quality === 'balanced' && process.env.MATTERLAB_WRITE_APPARATUS_METRICS !== '1') {
            expect(definition.visual, `Regenerate measured asset metadata for ${definition.id}`).toMatchObject({ status: 'COMPLETE', triangleCount: metrics.triangles });
          }
          expect(metrics.triangles, definition.id).toBeGreaterThan(0);
          expect(metrics.meshes, definition.id).toBeGreaterThan(0);
          for (const axis of [0, 1, 2] as const) {
            expect(metrics.boundsM.min[axis], `${quality} ${definition.id} min ${axis}`).toBeGreaterThanOrEqual(definition.boundsM.min[axis] - 0.001);
            expect(metrics.boundsM.max[axis], `${quality} ${definition.id} max ${axis}`).toBeLessThanOrEqual(definition.boundsM.max[axis] + 0.001);
          }
          // Static material batching prevents a draw call for every tick, screw or letter.
          if (definition.kind !== 'BENCH') expect(metrics.meshes, definition.id).toBeLessThanOrEqual(8);
        } finally {
          model.dispose();
        }
      }
      if (process.env.MATTERLAB_WRITE_APPARATUS_METRICS === '1') {
        writeFileSync(new URL('./asset-metrics.generated.json', import.meta.url), `${JSON.stringify(measured, null, 2)}\n`);
      }
    }
  });

  it('moves the real stopcock target from accepted state without changing the apparatus definition', () => {
    const definition = apparatusRegistry.getDefinition('burette-50ml')!;
    const before = JSON.stringify(definition);
    const model = buildApparatusGeometry(definition);
    try {
      const stopcock = model.controls.get('stopcock')!;
      expect(stopcock.children[0]!.userData.labControlId).toBe('stopcock');
      model.setState({ valveOpeningFraction: 0.5 });
      expect(stopcock.rotation.z).toBeCloseTo(-Math.PI / 4, 12);
      model.setState({ valveOpeningFraction: 0 });
      expect(stopcock.rotation.z).toBeCloseTo(0, 12);
      expect(() => model.setState({ valveOpeningFraction: NaN })).toThrow(/stopcock/);
      expect(JSON.stringify(definition)).toBe(before);
    } finally {
      model.dispose();
    }
  });

  it('releases owned geometry once without disposing an injected glass material', () => {
    const borrowed = new MeshPhysicalMaterial();
    const borrowedDisposal = vi.spyOn(borrowed, 'dispose');
    const model = buildApparatusGeometry(apparatusRegistry.getDefinition('burette-50ml')!, 'balanced', { glassMaterial: borrowed });
    const geometrySpies: Array<ReturnType<typeof vi.spyOn>> = [];
    model.object.traverse((object) => {
      if (object instanceof Mesh) geometrySpies.push(vi.spyOn(object.geometry, 'dispose'));
    });
    model.dispose();
    model.dispose();
    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(borrowedDisposal).not.toHaveBeenCalled();
    borrowedDisposal.mockRestore();
    borrowed.dispose();
  });
});
