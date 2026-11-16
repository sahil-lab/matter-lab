import { describe, expect, it } from 'vitest';
import type { ExperimentScene } from '@matterlab/contracts';
import { createDefinitionRegistry, VERTICAL_SLICE_DEFINITIONS } from '../registry';
import { buildCreateStationAction } from './actions';
import { applyLabAction, type ReducerContext } from './reducer';

const registry = createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS);
const context: ReducerContext = { registry };

const ORIGIN = { positionM: [0, 0, 0] as const, quaternion: [0, 0, 0, 1] as const };

function emptyScene(): ExperimentScene {
  return {
    id: 'scene-1',
    revision: 0,
    schemaVersion: 1,
    stations: [],
    apparatus: [],
    connections: [],
    containerStates: {},
    simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
  };
}

function withStation(stationId = 'station-1'): ExperimentScene {
  const outcome = applyLabAction(emptyScene(), buildCreateStationAction(stationId, 'Station 1', { actionId: 'create-station' }), context);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.scene;
}

function place(scene: ExperimentScene, instanceId: string, definitionId: string, stationId = 'station-1') {
  const outcome = applyLabAction(
    scene,
    { actionId: `place-${instanceId}`, atSimulationS: 0, targetInstanceId: instanceId, type: 'PLACE', payload: { definitionId, stationId, transform: ORIGIN } },
    context,
  );
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.scene;
}

describe('applyLabAction: CUSTOM (station creation)', () => {
  it('creates a station via CREATE_STATION', () => {
    const scene = withStation();
    expect(scene.stations).toEqual([{ id: 'station-1', name: 'Station 1' }]);
  });

  it('rejects creating a station with an id that already exists', () => {
    const scene = withStation();
    const outcome = applyLabAction(scene, buildCreateStationAction('station-1', 'Again', { actionId: 'dup' }), context);
    expect(outcome.ok).toBe(false);
  });

  it('is a harmless no-op for an unrecognised CUSTOM payload', () => {
    const scene = withStation();
    const outcome = applyLabAction(scene, { actionId: 'c1', atSimulationS: 0, targetInstanceId: 'x', type: 'CUSTOM', payload: { kind: 'SOMETHING_ELSE' } }, context);
    expect(outcome.ok).toBe(true);
  });
});

describe('applyLabAction: PLACE', () => {
  it('creates a new apparatus instance and auto-initialises empty contents for a CONTAINER', () => {
    const scene = withStation();
    const outcome = applyLabAction(
      scene,
      { actionId: 'p1', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'PLACE', payload: { definitionId: 'flask.conical.250ml', stationId: 'station-1', transform: ORIGIN } },
      context,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const instance = outcome.scene.apparatus.find((a) => a.id === 'flask-1');
    expect(instance?.kind).toBe('FLASK');
    expect(outcome.scene.containerStates['flask-1']).toEqual({ volumeL: 0, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'matterlab.lab.empty-container-v1' });
    expect(outcome.scene.revision).toBe(scene.revision + 1);
  });

  it('rejects placing an instance id that already exists', () => {
    const scene = place(withStation(), 'flask-1', 'flask.conical.250ml');
    const outcome = applyLabAction(
      scene,
      { actionId: 'p2', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'PLACE', payload: { definitionId: 'flask.conical.250ml', stationId: 'station-1', transform: ORIGIN } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('rejects an unknown apparatus definition', () => {
    const scene = withStation();
    const outcome = applyLabAction(
      scene,
      { actionId: 'p3', atSimulationS: 0, targetInstanceId: 'x', type: 'PLACE', payload: { definitionId: 'no.such.definition', stationId: 'station-1', transform: ORIGIN } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('rejects an unknown station', () => {
    const outcome = applyLabAction(
      emptyScene(),
      { actionId: 'p4', atSimulationS: 0, targetInstanceId: 'x', type: 'PLACE', payload: { definitionId: 'flask.conical.250ml', stationId: 'no-such-station', transform: ORIGIN } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('never mutates scene state on a rejected PLACE', () => {
    const scene = withStation();
    const outcome = applyLabAction(
      scene,
      { actionId: 'p5', atSimulationS: 0, targetInstanceId: 'x', type: 'PLACE', payload: { definitionId: 'no.such.definition', stationId: 'station-1', transform: ORIGIN } },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(scene.apparatus).toHaveLength(0);
    expect(scene.revision).toBe(1); // unchanged from withStation()'s own revision bump
  });
});

describe('applyLabAction: MOVE', () => {
  it('updates transform and bumps the instance revision', () => {
    const scene = place(withStation(), 'flask-1', 'flask.conical.250ml');
    const newTransform = { positionM: [1, 2, 3] as const, quaternion: [0, 0, 0, 1] as const };
    const outcome = applyLabAction(scene, { actionId: 'm1', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'MOVE', payload: { transform: newTransform } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const instance = outcome.scene.apparatus.find((a) => a.id === 'flask-1')!;
    expect(instance.transform).toEqual(newTransform);
    expect(instance.revision).toBe(1);
  });

  it('rejects moving an unknown instance', () => {
    const outcome = applyLabAction(withStation(), { actionId: 'm2', atSimulationS: 0, targetInstanceId: 'missing', type: 'MOVE', payload: { transform: ORIGIN } }, context);
    expect(outcome.ok).toBe(false);
  });
});

function createStation(scene: ExperimentScene, stationId: string, name: string): ExperimentScene {
  const outcome = applyLabAction(scene, buildCreateStationAction(stationId, name, { actionId: `create-${stationId}` }), context);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.scene;
}

describe('applyLabAction: ATTACH / DETACH', () => {
  function rigScene(): ExperimentScene {
    let scene = withStation();
    scene = place(scene, 'clamp-1', 'clamp.burette.standard');
    scene = place(scene, 'burette-1', 'burette.class-a.50ml');
    scene = place(scene, 'bench-1', 'bench.standard');
    return scene;
  }

  it('connects two compatible sockets', () => {
    const outcome = applyLabAction(
      rigScene(),
      { actionId: 'a1', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'barrel', toInstanceId: 'clamp-1', toSocketId: 'bore' } },
      context,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.connections).toHaveLength(1);
    expect(outcome.scene.connections[0]!.kind).toBe('MECHANICAL');
  });

  it('rejects connecting an instance to itself', () => {
    const outcome = applyLabAction(
      rigScene(),
      { actionId: 'a2', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'barrel', toInstanceId: 'burette-1', toSocketId: 'barrel' } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('rejects an incompatible capability requirement (bench lacks MOUNTABLE for the clamp bore)', () => {
    const outcome = applyLabAction(
      rigScene(),
      { actionId: 'a3', atSimulationS: 0, targetInstanceId: 'bench-1', type: 'ATTACH', payload: { socketId: 'surface', toInstanceId: 'clamp-1', toSocketId: 'bore' } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('rejects attaching apparatus from two different stations', () => {
    let scene = rigScene();
    scene = createStation(scene, 'station-2', 'Station 2');
    scene = place(scene, 'flask-other', 'flask.conical.250ml', 'station-2');
    const outcome = applyLabAction(
      scene,
      { actionId: 'a4', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'tip', toInstanceId: 'flask-other', toSocketId: 'mouth' } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('DETACH removes the connection; a second DETACH of the same connection fails cleanly', () => {
    const attached = applyLabAction(
      rigScene(),
      { actionId: 'a5', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'barrel', toInstanceId: 'clamp-1', toSocketId: 'bore' } },
      context,
    );
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const connectionId = attached.scene.connections[0]!.id;
    const detached = applyLabAction(attached.scene, { actionId: 'd1', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'DETACH', payload: { connectionId } }, context);
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    expect(detached.scene.connections).toHaveLength(0);
    const detachAgain = applyLabAction(detached.scene, { actionId: 'd2', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'DETACH', payload: { connectionId } }, context);
    expect(detachAgain.ok).toBe(false);
  });
});

describe('applyLabAction: FILL / SET_VALVE / TRANSFER', () => {
  function connectedRig(): ExperimentScene {
    let scene = withStation();
    scene = place(scene, 'burette-1', 'burette.class-a.50ml');
    scene = place(scene, 'flask-1', 'flask.conical.250ml');
    const attach = applyLabAction(scene, { actionId: 'attach-fluid', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'tip', toInstanceId: 'flask-1', toSocketId: 'mouth' } }, context);
    if (!attach.ok) throw new Error(attach.reason);
    return attach.scene;
  }

  it('FILL sets a container to the requested absolute contents', () => {
    const outcome = applyLabAction(
      connectedRig(),
      { actionId: 'f1', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'FILL', payload: { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' } },
      context,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.containerStates['flask-1']!.volumeL).toBeCloseTo(0.025);
    expect(outcome.affectedContainerIds).toEqual(['flask-1']);
  });

  it('FILL rejects a volume beyond the declared capacity', () => {
    const outcome = applyLabAction(
      connectedRig(),
      { actionId: 'f2', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'FILL', payload: { volumeL: 999, species: [], temperatureK: 298.15, modelId: 'x' } },
      context,
    );
    expect(outcome.ok).toBe(false);
  });

  it('FILL rejects an instance without CONTAINER capability', () => {
    const scene = place(withStation(), 'stand-1', 'stand.retort.standard');
    const outcome = applyLabAction(scene, { actionId: 'f3', atSimulationS: 0, targetInstanceId: 'stand-1', type: 'FILL', payload: { volumeL: 0.1, species: [], temperatureK: 298.15, modelId: 'x' } }, context);
    expect(outcome.ok).toBe(false);
  });

  it('SET_VALVE clamps the opening to [0,1] and requires FLOW_SOURCE', () => {
    const outcome = applyLabAction(connectedRig(), { actionId: 's1', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'SET_VALVE', payload: { valveOpening: 1.5 } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.apparatus.find((a) => a.id === 'burette-1')!.config.valveOpening).toBe(1);
  });

  it('SET_VALVE rejects an instance without FLOW_SOURCE', () => {
    const outcome = applyLabAction(connectedRig(), { actionId: 's2', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'SET_VALVE', payload: { valveOpening: 0.5 } }, context);
    expect(outcome.ok).toBe(false);
  });

  it('TRANSFER rejects when there is no enabled FLUID connection between source and receiver', () => {
    let scene = withStation();
    scene = place(scene, 'burette-1', 'burette.class-a.50ml');
    scene = place(scene, 'flask-1', 'flask.conical.250ml'); // not attached
    const outcome = applyLabAction(scene, { actionId: 't1', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'TRANSFER', payload: { toInstanceId: 'flask-1', volumeL: 0.001 } }, context);
    expect(outcome.ok).toBe(false);
  });

  it('TRANSFER moves volume and species between an attached burette and flask, conserving both', () => {
    let scene = connectedRig();
    const filled = applyLabAction(
      scene,
      { actionId: 'f4', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'FILL', payload: { volumeL: 0.05, species: [{ speciesId: 'NaOH', moles: 0.005 }], temperatureK: 298.15, modelId: 'aqueous-ideal-v1' } },
      context,
    );
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    scene = filled.scene;
    const outcome = applyLabAction(scene, { actionId: 't2', atSimulationS: 1, targetInstanceId: 'burette-1', type: 'TRANSFER', payload: { toInstanceId: 'flask-1', volumeL: 0.01 } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.containerStates['burette-1']!.volumeL).toBeCloseTo(0.04, 12);
    expect(outcome.scene.containerStates['flask-1']!.volumeL).toBeCloseTo(0.01, 12);
    expect(outcome.scene.containerStates['flask-1']!.species[0]).toEqual({ speciesId: 'NaOH', moles: expect.closeTo(0.001, 12) });
    expect([...outcome.affectedContainerIds].sort()).toEqual(['burette-1', 'flask-1'].sort());
  });
});

describe('applyLabAction: START_STIRRER / SET_PROBE', () => {
  it('START_STIRRER clamps rpm to the control max and requires STIRRING', () => {
    const scene = place(withStation(), 'stirrer-1', 'stirrer.magnetic.standard');
    const outcome = applyLabAction(scene, { actionId: 'ss1', atSimulationS: 0, targetInstanceId: 'stirrer-1', type: 'START_STIRRER', payload: { running: true, rpm: 5000 } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.apparatus[0]!.config.stirrerRpm).toBe(1000);
    expect(outcome.scene.apparatus[0]!.config.running).toBe(true);
  });

  it('SET_PROBE requires the probe and the target to share a station', () => {
    let scene = withStation('station-1');
    scene = place(scene, 'probe-1', 'probe.ph.standard', 'station-1');
    const createSecond = applyLabAction(scene, buildCreateStationAction('station-2', 'Station 2', { actionId: 'cs' }), context);
    expect(createSecond.ok).toBe(true);
    if (!createSecond.ok) return;
    scene = place(createSecond.scene, 'flask-other', 'flask.conical.250ml', 'station-2');
    const outcome = applyLabAction(scene, { actionId: 'sp1', atSimulationS: 0, targetInstanceId: 'probe-1', type: 'SET_PROBE', payload: { targetApparatusId: 'flask-other' } }, context);
    expect(outcome.ok).toBe(false);
  });
});

describe('applyLabAction: RESET', () => {
  function filledStation(): ExperimentScene {
    let scene = withStation();
    scene = place(scene, 'burette-1', 'burette.class-a.50ml');
    scene = place(scene, 'flask-1', 'flask.conical.250ml');
    const attach = applyLabAction(scene, { actionId: 'attach', atSimulationS: 0, targetInstanceId: 'burette-1', type: 'ATTACH', payload: { socketId: 'tip', toInstanceId: 'flask-1', toSocketId: 'mouth' } }, context);
    if (!attach.ok) throw new Error(attach.reason);
    const filled = applyLabAction(attach.scene, { actionId: 'fill', atSimulationS: 0, targetInstanceId: 'flask-1', type: 'FILL', payload: { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, modelId: 'x' } }, context);
    if (!filled.ok) throw new Error(filled.reason);
    return filled.scene;
  }

  it('RESET STATION clears contents but keeps apparatus and (by default) connections', () => {
    const scene = filledStation();
    const outcome = applyLabAction(scene, { actionId: 'r1', atSimulationS: 0, targetInstanceId: 'station-1', type: 'RESET', payload: { scope: 'STATION', stationId: 'station-1' } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.apparatus).toHaveLength(2);
    expect(outcome.scene.connections).toHaveLength(1);
    expect(outcome.scene.containerStates['flask-1']!.volumeL).toBe(0);
    expect(outcome.scene.containerStates['flask-1']!.species).toEqual([]);
  });

  it('RESET STATION with clearConnections also drops the connections', () => {
    const scene = filledStation();
    const outcome = applyLabAction(scene, { actionId: 'r2', atSimulationS: 0, targetInstanceId: 'station-1', type: 'RESET', payload: { scope: 'STATION', stationId: 'station-1', clearConnections: true } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.connections).toHaveLength(0);
    expect(outcome.scene.apparatus).toHaveLength(2);
  });

  it('RESET SCENE wipes all apparatus, connections and contents', () => {
    const scene = filledStation();
    const outcome = applyLabAction(scene, { actionId: 'r3', atSimulationS: 0, targetInstanceId: '', type: 'RESET', payload: { scope: 'SCENE' } }, context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scene.apparatus).toHaveLength(0);
    expect(outcome.scene.connections).toHaveLength(0);
    expect(outcome.scene.containerStates).toEqual({});
    expect(outcome.scene.stations).toHaveLength(1); // stations themselves survive a RESET
  });
});

describe('applyLabAction: unknown type', () => {
  it('rejects an action whose type is not a recognised LabActionType', () => {
    const outcome = applyLabAction(withStation(), { actionId: 'u1', atSimulationS: 0, targetInstanceId: 'x', type: 'NOT_A_TYPE' as never, payload: {} }, context);
    expect(outcome.ok).toBe(false);
  });
});
