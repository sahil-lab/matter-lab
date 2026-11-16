import { describe, expect, it } from 'vitest';
import { getApparatusDefinition } from '../apparatus/catalog';
import { IDENTITY_TRANSFORM, newUUID } from '../editor/contracts';
import type { LabAction } from '../editor/contracts';
import { createLabReducer } from './labReducer';

function place(targetInstanceId: string, definitionId: string, stationId = 'station-1'): LabAction {
  const definition = getApparatusDefinition(definitionId)!;
  return {
    actionId: newUUID(),
    atSimulationS: 0,
    targetInstanceId,
    type: 'PLACE',
    payload: { kind: definition.kind, definitionId, transform: IDENTITY_TRANSFORM, capabilities: definition.capabilities, stationId, config: definition.defaultConfig },
  };
}

function attach(connectionId: string, fromId: string, fromSocket: string, toId: string, toSocket: string, kind: 'MECHANICAL' | 'FLUID' | 'SENSOR' | 'CONTROL'): LabAction {
  return { actionId: newUUID(), atSimulationS: 0, targetInstanceId: fromId, type: 'ATTACH', payload: { connectionId, from: { instanceId: fromId, socketId: fromSocket }, to: { instanceId: toId, socketId: toSocket }, kind } };
}

describe('LabReducer — placement and connection graph', () => {
  it('accepts placing an instance and rejects placing the same id twice', () => {
    const reducer = createLabReducer();
    expect(reducer.dispatch(place('flask', 'flask.conical250')).accepted).toBe(true);
    const second = reducer.dispatch({ ...place('flask', 'flask.conical250'), actionId: newUUID() });
    expect(second.accepted).toBe(false);
    expect(second.rejection?.code).toBe('DUPLICATE_INSTANCE');
  });

  it('is idempotent: dispatching the exact same action twice only applies it once', () => {
    const reducer = createLabReducer();
    const action = place('flask', 'flask.conical250');
    reducer.dispatch(action);
    const revisionAfterFirst = reducer.getRevision();
    const second = reducer.dispatch(action);
    expect(second.accepted).toBe(true);
    expect(reducer.getRevision()).toBe(revisionAfterFirst);
    expect(reducer.getApparatus()).toHaveLength(1);
  });

  it('rejects ATTACH between sockets whose kinds are incompatible, with a clear reason', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('clamp', 'clamp.burette'));
    reducer.dispatch(place('beaker', 'beaker.400ml'));
    const result = reducer.dispatch(attach('c1', 'clamp', 'jaw', 'beaker', 'base', 'MECHANICAL'));
    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('INCOMPATIBLE_KIND');
  });

  it('accepts a valid ATTACH and rejects a second one to the same (non-multiple) socket', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('stand', 'stand.retort'));
    reducer.dispatch(place('clamp-1', 'clamp.burette'));
    reducer.dispatch(place('clamp-2', 'clamp.burette'));
    const first = reducer.dispatch(attach('c1', 'stand', 'rail-mid', 'clamp-1', 'mount', 'MECHANICAL'));
    expect(first.accepted).toBe(true);
    const second = reducer.dispatch(attach('c2', 'stand', 'rail-mid', 'clamp-2', 'mount', 'MECHANICAL'));
    expect(second.accepted).toBe(false);
    expect(second.rejection?.code).toBe('SOCKET_OCCUPIED');
  });

  it('DETACH removes a connection and frees its socket for reuse', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('stand', 'stand.retort'));
    reducer.dispatch(place('clamp-1', 'clamp.burette'));
    reducer.dispatch(attach('c1', 'stand', 'rail-mid', 'clamp-1', 'mount', 'MECHANICAL'));
    const detach = reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'stand', type: 'DETACH', payload: { connectionId: 'c1' } });
    expect(detach.accepted).toBe(true);
    expect(reducer.getConnections()).toHaveLength(0);
    reducer.dispatch(place('clamp-2', 'clamp.burette'));
    const reattach = reducer.dispatch(attach('c2', 'stand', 'rail-mid', 'clamp-2', 'mount', 'MECHANICAL'));
    expect(reattach.accepted).toBe(true);
  });

  it('CUSTOM REMOVE deletes the instance, its container state and any connections referencing it', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('stand', 'stand.retort'));
    reducer.dispatch(place('clamp-1', 'clamp.burette'));
    reducer.dispatch(attach('c1', 'stand', 'rail-mid', 'clamp-1', 'mount', 'MECHANICAL'));
    const remove = reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'clamp-1', type: 'CUSTOM', payload: { op: 'REMOVE' } });
    expect(remove.accepted).toBe(true);
    expect(reducer.getApparatus().some((a) => a.id === 'clamp-1')).toBe(false);
    expect(reducer.getConnections()).toHaveLength(0);
  });
});

describe('LabReducer — the Section 6 vertical slice (strong acid/base titration)', () => {
  function setUpTitration() {
    const reducer = createLabReducer();
    reducer.dispatch(place('burette', 'burette.50ml'));
    reducer.dispatch(place('flask', 'flask.conical250'));
    reducer.dispatch(attach('c1', 'burette', 'tip', 'flask', 'mouth', 'FLUID'));
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'flask', type: 'FILL', payload: { speciesId: 'HCl', concentrationMolPerL: 0.1, volumeL: 0.025, temperatureK: 298.15 } });
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'FILL', payload: { speciesId: 'NaOH', concentrationMolPerL: 0.1, volumeL: 0.05, temperatureK: 298.15 } });
    return reducer;
  }

  it('reads back the initial aliquot pH as strongly acidic before any titrant is delivered', () => {
    const reducer = setUpTitration();
    const states = reducer.getContainerStates();
    expect(states['flask']!.volumeL).toBeCloseTo(0.025, 9);
    const ph = reducer.getObservations('flask').filter((o) => o.type === 'PH').at(-1)!;
    expect(ph.quantity.value).toBeCloseTo(-Math.log10(0.1), 3);
    expect(ph.evidence).toBe('UNVERIFIED');
  });

  it('delivers metered, conserving transfer as the valve opens and the clock advances', () => {
    const reducer = setUpTitration();
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'SET_VALVE', payload: { openFraction: 1 } });
    const burretteVolumeBefore = reducer.getContainerStates()['burette']!.volumeL;
    const flaskVolumeBefore = reducer.getContainerStates()['flask']!.volumeL;
    for (let i = 0; i < 100; i++) reducer.advanceSimulation(0.1); // 10 simulated seconds
    const states = reducer.getContainerStates();
    const delivered = burretteVolumeBefore - states['burette']!.volumeL;
    expect(delivered).toBeGreaterThan(0);
    // Source loss exactly equals receiver gain: conservation of volume within numerical tolerance.
    expect(states['flask']!.volumeL - flaskVolumeBefore).toBeCloseTo(delivered, 9);
  });

  it('reaches pH close to 7 at the equivalence point (25.00 mL of 0.100 M NaOH into 25.00 mL of 0.100 M HCl)', () => {
    const reducer = setUpTitration();
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'SET_VALVE', payload: { openFraction: 1 } });
    // Deliver exactly 25.00 mL via direct TRANSFERs (bypassing the flow-rate model) to land precisely on equivalence.
    for (let i = 0; i < 25; i++) {
      reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'TRANSFER', payload: { fromInstanceId: 'burette', toInstanceId: 'flask', volumeL: 0.001 } });
    }
    const ph = reducer.getObservations('flask').filter((o) => o.type === 'PH').at(-1)!;
    expect(ph.quantity.value).toBeCloseTo(7, 4);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBeCloseTo(0.05, 9);
  });

  it('rejects a transfer larger than the source actually holds', () => {
    const reducer = setUpTitration();
    const result = reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'TRANSFER', payload: { fromInstanceId: 'burette', toInstanceId: 'flask', volumeL: 1 } });
    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('INSUFFICIENT_VOLUME');
  });

  it('rejects a fill that would exceed the vessel capacity', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('flask', 'flask.conical250'));
    const result = reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'flask', type: 'FILL', payload: { speciesId: 'HCl', concentrationMolPerL: 0.1, volumeL: 10, temperatureK: 298.15 } });
    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('CAPACITY_EXCEEDED');
  });

  it('pause suspends metered transfer, and resume lets it continue', () => {
    const reducer = setUpTitration();
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'SET_VALVE', payload: { openFraction: 1 } });
    reducer.pause();
    const before = reducer.getContainerStates()['flask']!.volumeL;
    reducer.advanceSimulation(5);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBe(before);
    reducer.resume();
    reducer.advanceSimulation(1);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBeGreaterThan(before);
  });

  it('RESET (scope "all") empties every container and resets the simulation clock, but keeps apparatus placed', () => {
    const reducer = setUpTitration();
    reducer.advanceSimulation(1);
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'RESET', payload: { scope: 'all' } });
    expect(reducer.getContainerStates()['flask']!.volumeL).toBe(0);
    expect(reducer.getContainerStates()['burette']!.volumeL).toBe(0);
    expect(reducer.getSimulationS()).toBe(0);
    expect(reducer.getApparatus()).toHaveLength(2); // equipment stays on the bench; reset is not deletion
  });

  it('two independent stations do not interfere: filling one flask never changes the other', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('flask-a', 'flask.conical250', 'station-a'));
    reducer.dispatch(place('flask-b', 'flask.conical250', 'station-b'));
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'flask-a', type: 'FILL', payload: { speciesId: 'HCl', concentrationMolPerL: 0.2, volumeL: 0.02, temperatureK: 298.15 } });
    expect(reducer.getContainerStates()['flask-b']!.volumeL).toBe(0);
    expect(reducer.getContainerStates()['flask-a']!.volumeL).toBeCloseTo(0.02, 9);
  });

  it('saves (exportScene) and reopens (loadScene) without losing the connection graph or contents', () => {
    const reducer = setUpTitration();
    for (let i = 0; i < 10; i++) reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'burette', type: 'TRANSFER', payload: { fromInstanceId: 'burette', toInstanceId: 'flask', volumeL: 0.001 } });
    const saved = reducer.exportScene();

    const reopened = createLabReducer();
    reopened.loadScene(saved);
    expect(reopened.getConnections()).toHaveLength(1);
    expect(reopened.getContainerStates()['flask']!.volumeL).toBeCloseTo(saved.containerStates['flask']!.volumeL, 9);
    expect(reopened.getContainerStates()['burette']!.volumeL).toBeCloseTo(saved.containerStates['burette']!.volumeL, 9);
  });

  it('refuses species outside the stub chemistry list as unsupported rather than guessing a pH', () => {
    const reducer = createLabReducer();
    reducer.dispatch(place('flask', 'flask.conical250'));
    reducer.dispatch({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: 'flask', type: 'FILL', payload: { speciesId: 'CH3COOH', concentrationMolPerL: 0.1, volumeL: 0.025, temperatureK: 298.15 } });
    expect(reducer.getObservations('flask').some((o) => o.type === 'PH')).toBe(false);
    expect(reducer.getObservations('flask').some((o) => o.type === 'VOLUME')).toBe(true);
  });
});
