import { describe, expect, it } from 'vitest';
import { apparatusRegistry } from '../apparatus/registry';
import { connectedStirring, fluidTransferPaths } from './composition';
import { fixture } from './fixtures.test-support';

describe('canonical apparatus composition', () => {
  it('derives the real 30 mm burette/flask gap from sockets with exactly one world transform', () => {
    const { snapshot, ids } = fixture();
    const [path] = fluidTransferPaths(snapshot, apparatusRegistry);
    expect(path).toMatchObject({
      sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, supported: true,
    });
    expect(path!.sourceM[1]).toBeCloseTo(1.18, 10);
    expect(path!.receiverM[1]).toBeCloseTo(1.15, 10);
    expect(path!.sourceM[1] - path!.receiverM[1]).toBeCloseTo(0.03, 10);
    const disabled = { ...snapshot, scene: { ...snapshot.scene, connections: snapshot.scene.connections.map((connection) =>
      connection.kind === 'FLUID' ? { ...connection, enabled: false } : connection) } };
    expect(fluidTransferPaths(disabled, apparatusRegistry)).toHaveLength(0);
  });

  it('allows stirring only through one enabled same-station CONTROL link', () => {
    const { snapshot, ids } = fixture();
    const stirring = { enabled: true, frequencyHz: 8 };
    const enabled = { ...snapshot, apparatusStates: { ...snapshot.apparatusStates, [ids.stirrerId]: { stirring } } };
    expect(connectedStirring(enabled, ids.flaskId)).toBe(stirring);
    expect(connectedStirring(enabled, ids.buretteId)).toBeUndefined();
    const noControl = { ...enabled, scene: { ...enabled.scene, connections: enabled.scene.connections.filter((connection) => connection.kind !== 'CONTROL') } };
    expect(connectedStirring(noControl, ids.flaskId)).toBeUndefined();
    const control = enabled.scene.connections.find((connection) => connection.kind === 'CONTROL')!;
    const ambiguous = { ...enabled, scene: { ...enabled.scene, connections: [...enabled.scene.connections, { ...control, id: 'second-control' }] } };
    expect(connectedStirring(ambiguous, ids.flaskId)).toBeUndefined();
  });
});
