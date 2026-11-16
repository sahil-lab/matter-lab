import { describe, expect, it } from 'vitest';
import { footprintFor, getApparatusDefinition, requireApparatusDefinition } from '../apparatus/catalog';
import { IDENTITY_TRANSFORM } from './contracts';
import type { ApparatusInstance } from './contracts';
import { worldAabbFor } from './footprint';
import { computePlacementPreview } from './placement';
import type { PlacementContext } from './placement';

function instance(id: string, definitionId: string, positionM: readonly [number, number, number]): ApparatusInstance {
  const definition = requireApparatusDefinition(definitionId);
  return { id, kind: definition.kind, definitionId, transform: { positionM, quaternion: IDENTITY_TRANSFORM.quaternion }, revision: 1, config: {}, capabilities: definition.capabilities, stationId: 's1' };
}

function baseContext(overrides: Partial<PlacementContext>): PlacementContext {
  return {
    definition: getApparatusDefinition('flask.conical250')!,
    candidateTransform: { positionM: [0, 0, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
    snapNearby: [],
    collisionNearby: [],
    connections: [],
    ...overrides,
  };
}

describe('computePlacementPreview', () => {
  it('reports support and a valid snap when placed on a benchtop', () => {
    const bench = instance('bench', 'bench.standard', [0, 0, 0]);
    const preview = computePlacementPreview(
      baseContext({
        candidateTransform: { positionM: [0.2, 0.05, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
        snapNearby: [{ instance: bench, definition: requireApparatusDefinition('bench.standard') }],
      }),
    );
    expect(preview.snap.status).toBe('valid');
    expect(preview.supported).toBe(true);
    expect(preview.collisions).toHaveLength(0);
  });

  it('reports unsupported when a support-requiring instrument has nothing to rest on', () => {
    const preview = computePlacementPreview(
      baseContext({ definition: getApparatusDefinition('stand.retort')!, candidateTransform: { positionM: [5, 0, 5], quaternion: IDENTITY_TRANSFORM.quaternion } }),
    );
    expect(preview.snap.status).toBe('none');
    expect(preview.supported).toBe(false);
  });

  it('never requires support for apparatus whose definition does not need it', () => {
    const preview = computePlacementPreview(baseContext({ definition: getApparatusDefinition('pipette.10ml')! }));
    expect(preview.supported).toBe(true);
  });

  it('excludes the snap target from its own collision warnings', () => {
    const stand = instance('stand', 'stand.retort', [0, 0, 0]);
    const standBox = worldAabbFor(footprintFor(requireApparatusDefinition('stand.retort')), stand.transform);
    const preview = computePlacementPreview(
      baseContext({
        definition: getApparatusDefinition('clamp.burette')!,
        candidateTransform: { positionM: [0.06, 0.38, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
        snapNearby: [{ instance: stand, definition: requireApparatusDefinition('stand.retort') }],
        collisionNearby: [{ instanceId: 'stand', label: 'the retort stand', box: standBox }],
      }),
    );
    expect(preview.snap.status).toBe('valid');
    expect(preview.collisions).toHaveLength(0);
  });

  it('flags an overlap with an unrelated instance that was not snapped to', () => {
    const otherBeaker = instance('beaker-1', 'beaker.400ml', [0, 0, 0]);
    const otherBox = worldAabbFor(footprintFor(requireApparatusDefinition('beaker.400ml')), otherBeaker.transform);
    const preview = computePlacementPreview(
      baseContext({
        definition: getApparatusDefinition('beaker.400ml')!,
        candidateTransform: { positionM: [0.02, 0, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
        collisionNearby: [{ instanceId: 'beaker-1', label: 'another beaker', box: otherBox }],
      }),
    );
    expect(preview.collisions).toHaveLength(1);
    expect(preview.collisions[0]!.withInstanceId).toBe('beaker-1');
  });
});
