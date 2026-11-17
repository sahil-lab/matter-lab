import { describe, expect, it } from 'vitest';
import { canSocketsConnect, type ApparatusDefinition, type SocketDefinition } from '../lab/apparatus';

const ORIGIN = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] } as const;

function definition(overrides: Partial<ApparatusDefinition> & Pick<ApparatusDefinition, 'id' | 'kind' | 'capabilities' | 'sockets'>): ApparatusDefinition {
  return {
    label: overrides.id,
    category: 'test',
    dimensionsM: { width: 0.1, height: 0.1, depth: 0.1 },
    permittedTransforms: { translate: true, rotateAxes: ['y'] },
    controls: [],
    defaultConfig: {},
    ...overrides,
  };
}

function socket(overrides: Partial<SocketDefinition> & Pick<SocketDefinition, 'id' | 'kind' | 'gender'>): SocketDefinition {
  return { localTransform: ORIGIN, maxConnections: 1, ...overrides };
}

describe('canSocketsConnect', () => {
  it('accepts a plug/socket pair of the same connection kind with satisfied capability requirements', () => {
    const clamp = definition({
      id: 'clamp.standard',
      kind: 'CLAMP',
      capabilities: ['MOUNT'],
      sockets: [socket({ id: 'bore', kind: 'MECHANICAL', gender: 'SOCKET', requiresCapability: 'MOUNTABLE' })],
    });
    const burette = definition({
      id: 'burette.50ml',
      kind: 'BURETTE',
      capabilities: ['MOUNTABLE', 'FLOW_SOURCE', 'CONTAINER'],
      sockets: [socket({ id: 'barrel', kind: 'MECHANICAL', gender: 'PLUG' })],
    });
    const result = canSocketsConnect(
      { definition: clamp, socket: clamp.sockets[0]! },
      { definition: burette, socket: burette.sockets[0]! },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects sockets of different connection kinds', () => {
    const a = definition({
      id: 'a',
      kind: 'OTHER',
      capabilities: [],
      sockets: [socket({ id: 's', kind: 'FLUID', gender: 'PLUG' })],
    });
    const b = definition({
      id: 'b',
      kind: 'OTHER',
      capabilities: [],
      sockets: [socket({ id: 's', kind: 'MECHANICAL', gender: 'SOCKET' })],
    });
    const result = canSocketsConnect({ definition: a, socket: a.sockets[0]! }, { definition: b, socket: b.sockets[0]! });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/kinds do not match/);
  });

  it('rejects two sockets of the same non-neutral gender', () => {
    const a = definition({ id: 'a', kind: 'OTHER', capabilities: [], sockets: [socket({ id: 's', kind: 'FLUID', gender: 'PLUG' })] });
    const b = definition({ id: 'b', kind: 'OTHER', capabilities: [], sockets: [socket({ id: 's', kind: 'FLUID', gender: 'PLUG' })] });
    const result = canSocketsConnect({ definition: a, socket: a.sockets[0]! }, { definition: b, socket: b.sockets[0]! });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/same gender/);
  });

  it('rejects when the other apparatus kind is not in acceptsKinds', () => {
    const standPole = definition({
      id: 'stand',
      kind: 'STAND',
      capabilities: [],
      sockets: [socket({ id: 'pole', kind: 'MECHANICAL', gender: 'SOCKET', acceptsKinds: ['CLAMP'] })],
    });
    const flask = definition({ id: 'flask', kind: 'FLASK', capabilities: [], sockets: [socket({ id: 'base', kind: 'MECHANICAL', gender: 'PLUG' })] });
    const result = canSocketsConnect({ definition: standPole, socket: standPole.sockets[0]! }, { definition: flask, socket: flask.sockets[0]! });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not accept FLASK/);
  });

  it('rejects when the other apparatus is missing a required capability', () => {
    const clamp = definition({
      id: 'clamp',
      kind: 'CLAMP',
      capabilities: ['MOUNT'],
      sockets: [socket({ id: 'bore', kind: 'MECHANICAL', gender: 'SOCKET', requiresCapability: 'MOUNTABLE' })],
    });
    const bench = definition({ id: 'bench', kind: 'BENCH', capabilities: [], sockets: [socket({ id: 'top', kind: 'MECHANICAL', gender: 'PLUG' })] });
    const result = canSocketsConnect({ definition: clamp, socket: clamp.sockets[0]! }, { definition: bench, socket: bench.sockets[0]! });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lacks the MOUNTABLE capability/);
  });
});
