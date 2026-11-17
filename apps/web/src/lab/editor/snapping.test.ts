import { describe, expect, it } from 'vitest';
import { getApparatusDefinition, requireApparatusDefinition } from '../apparatus/catalog';
import { IDENTITY_TRANSFORM } from './contracts';
import type { ApparatusInstance, Connection } from './contracts';
import { findSnapTarget, resolveSockets } from './snapping';
import type { SnapCandidate } from './snapping';

function instance(id: string, definitionId: string, positionM: readonly [number, number, number]): ApparatusInstance {
  const definition = requireApparatusDefinition(definitionId);
  return {
    id,
    kind: definition.kind,
    definitionId,
    transform: { positionM, quaternion: IDENTITY_TRANSFORM.quaternion },
    revision: 1,
    config: definition.defaultConfig,
    capabilities: definition.capabilities,
    stationId: 'station-1',
  };
}

function candidateFor(inst: ApparatusInstance): SnapCandidate {
  return { instance: inst, definition: requireApparatusDefinition(inst.definitionId) };
}

describe('findSnapTarget', () => {
  it('snaps a clamp onto a stand rail socket when dragged close to it', () => {
    const stand = instance('stand', 'stand.retort', [0, 0, 0]);
    // The stand's rail-mid socket sits 0.38 m up; aim the clamp's mount socket (local [-0.06,0,0]) right at it.
    const candidateTransform = { positionM: [0.06, 0.38, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const result = findSnapTarget({
      draggedKind: 'CLAMP',
      draggedDefinition: getApparatusDefinition('clamp.burette')!,
      candidateTransform,
      nearby: [candidateFor(stand)],
      connections: [],
    });
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.socket.socketId).toBe('rail-mid');
      expect(result.draggedSocketId).toBe('mount');
      // The clamp's mount socket (local x=-0.06) must land exactly on the stand's rail (world x=0).
      expect(result.worldTransform.positionM[0]).toBeCloseTo(0.06, 6);
      expect(result.worldTransform.positionM[1]).toBeCloseTo(0.38, 6);
    }
  });

  it('rejects an incompatible pair (a beaker aimed at a clamp jaw) with a clear reason', () => {
    const clamp = instance('clamp', 'clamp.burette', [0, 0.38, 0]);
    const candidateTransform = { positionM: [0.07 - 0, 0.38, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const result = findSnapTarget({
      draggedKind: 'BEAKER',
      draggedDefinition: getApparatusDefinition('beaker.400ml')!,
      candidateTransform,
      nearby: [candidateFor(clamp)],
      connections: [],
    });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.reason).toBe('INCOMPATIBLE_KIND');
  });

  it('rejects a socket that is already occupied', () => {
    const stand = instance('stand', 'stand.retort', [0, 0, 0]);
    // A connection already uses the stand's rail-mid socket (the other end, clamp-1, need not be in `nearby`).
    const connections: Connection[] = [{ id: 'c1', from: { instanceId: 'stand', socketId: 'rail-mid' }, to: { instanceId: 'clamp-1', socketId: 'mount' }, kind: 'MECHANICAL', enabled: true }];
    const candidateTransform = { positionM: [0.06, 0.38, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const result = findSnapTarget({
      draggedKind: 'CLAMP',
      draggedDefinition: getApparatusDefinition('clamp.burette')!,
      candidateTransform,
      nearby: [candidateFor(stand)],
      connections,
    });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.reason).toBe('SOCKET_OCCUPIED');
  });

  it('returns "none" when nothing compatible is within range', () => {
    const stand = instance('stand', 'stand.retort', [10, 0, 10]);
    const result = findSnapTarget({
      draggedKind: 'CLAMP',
      draggedDefinition: getApparatusDefinition('clamp.burette')!,
      candidateTransform: { positionM: [0, 0, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
      nearby: [candidateFor(stand)],
      connections: [],
    });
    expect(result.status).toBe('none');
  });

  it('snaps a flask onto a benchtop surface, preserving its horizontal drag position', () => {
    const bench = instance('bench', 'bench.standard', [0, 0, 0]);
    const candidateTransform = { positionM: [0.3, 0.02, 0.1] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const result = findSnapTarget({
      draggedKind: 'FLASK',
      draggedDefinition: getApparatusDefinition('flask.conical250')!,
      candidateTransform,
      nearby: [candidateFor(bench)],
      connections: [],
    });
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.socket.surface).toBe('planar');
      expect(result.worldTransform.positionM[0]).toBeCloseTo(0.3, 6);
      expect(result.worldTransform.positionM[2]).toBeCloseTo(0.1, 6);
      // The flask's base socket (local y=0) lands exactly on the bench surface (world y=0, the
      // bench instance's own origin height — see the comment on bench.standard's socket).
      expect(result.worldTransform.positionM[1]).toBeCloseTo(0, 6);
    }
  });

  it('never proposes snapping an instance to itself', () => {
    const stand = instance('stand', 'stand.retort', [0, 0, 0]);
    const result = findSnapTarget({
      draggedKind: 'STAND',
      draggedDefinition: getApparatusDefinition('stand.retort')!,
      candidateTransform: stand.transform,
      nearby: [candidateFor(stand)],
      connections: [],
      excludeInstanceId: 'stand',
    });
    expect(result.status).not.toBe('valid');
  });
});

describe('resolveSockets', () => {
  it('reports occupied only for the connected socket, not the whole instance', () => {
    const stand = instance('stand', 'stand.retort', [0, 0, 0]);
    const connections: Connection[] = [{ id: 'c1', from: { instanceId: 'stand', socketId: 'rail-mid' }, to: { instanceId: 'clamp-1', socketId: 'mount' }, kind: 'MECHANICAL', enabled: true }];
    const sockets = resolveSockets(stand, requireApparatusDefinition('stand.retort'), connections);
    const railMid = sockets.find((s) => s.socketId === 'rail-mid')!;
    const railLow = sockets.find((s) => s.socketId === 'rail-low')!;
    expect(railMid.occupied).toBe(true);
    expect(railLow.occupied).toBe(false);
  });

  it('a planar socket with multiple=true is never reported as occupied', () => {
    const bench = instance('bench', 'bench.standard', [0, 0, 0]);
    const connections: Connection[] = [{ id: 'c1', from: { instanceId: 'bench', socketId: 'surface' }, to: { instanceId: 'stand-1', socketId: 'base' }, kind: 'MECHANICAL', enabled: true }];
    const sockets = resolveSockets(bench, requireApparatusDefinition('bench.standard'), connections);
    expect(sockets.find((s) => s.socketId === 'surface')!.occupied).toBe(false);
  });
});
