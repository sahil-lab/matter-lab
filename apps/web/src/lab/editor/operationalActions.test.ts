import { beforeEach, describe, expect, it } from 'vitest';
import { installLabActionSink } from './actionSink';
import { createLabReducer } from '../experiments/labReducer';
import type { LabReducer } from '../experiments/labReducer';
import { fillContainer, resetExperiment, setProbe, setValve, startStirrer, transfer } from './operationalActions';
import { IDENTITY_TRANSFORM } from './contracts';

let reducer: LabReducer;

beforeEach(() => {
  reducer = createLabReducer();
  installLabActionSink(reducer);
  reducer.dispatch({ actionId: 'place-flask', atSimulationS: 0, targetInstanceId: 'flask', type: 'PLACE', payload: { kind: 'FLASK', definitionId: 'flask.conical250', transform: IDENTITY_TRANSFORM, capabilities: ['CONTAINER', 'FLOW_RECEIVER'], stationId: 's1', config: {} } });
  reducer.dispatch({ actionId: 'place-burette', atSimulationS: 0, targetInstanceId: 'burette', type: 'PLACE', payload: { kind: 'BURETTE', definitionId: 'burette.50ml', transform: IDENTITY_TRANSFORM, capabilities: ['CONTAINER', 'FLOW_SOURCE'], stationId: 's1', config: { valveOpenFraction: 0 } } });
  reducer.dispatch({ actionId: 'place-stirrer', atSimulationS: 0, targetInstanceId: 'stirrer', type: 'PLACE', payload: { kind: 'STIRRER', definitionId: 'stirrer.magnetic', transform: IDENTITY_TRANSFORM, capabilities: ['MOUNT', 'STIRRING'], stationId: 's1', config: { speed: 0 } } });
  reducer.dispatch({ actionId: 'place-probe', atSimulationS: 0, targetInstanceId: 'probe', type: 'PLACE', payload: { kind: 'PH_PROBE', definitionId: 'probe.ph', transform: IDENTITY_TRANSFORM, capabilities: ['MOUNTABLE', 'PH_SENSOR'], stationId: 's1', config: {} } });
});

describe('operational actions dispatch typed LabActions, never touching chemistry directly', () => {
  it('fillContainer reaches the reducer and is reflected in getContainerStates', () => {
    const result = fillContainer('flask', 'HCl', 0.1, 0.025);
    expect(result.accepted).toBe(true);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBeCloseTo(0.025, 9);
  });

  it('setValve updates the authoritative valve position', () => {
    const result = setValve('burette', 0.5);
    expect(result.accepted).toBe(true);
    expect(reducer.getApparatus().find((a) => a.id === 'burette')!.config['valveOpenFraction']).toBe(0.5);
  });

  it('transfer moves volume conservatively between two named containers', () => {
    fillContainer('burette', 'NaOH', 0.1, 0.05);
    const result = transfer('burette', 'flask', 0.01);
    expect(result.accepted).toBe(true);
    expect(reducer.getContainerStates()['burette']!.volumeL).toBeCloseTo(0.04, 9);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBeCloseTo(0.01, 9);
  });

  it('startStirrer updates the authoritative speed', () => {
    const result = startStirrer('stirrer', 0.7);
    expect(result.accepted).toBe(true);
    expect(reducer.getApparatus().find((a) => a.id === 'stirrer')!.config['speed']).toBe(0.7);
  });

  it('setProbe seats the probe and immediately reads back a pH observation when supported', () => {
    fillContainer('flask', 'HCl', 0.1, 0.025);
    const result = setProbe('probe', 0.05, 'flask');
    expect(result.accepted).toBe(true);
    expect(reducer.getObservations('probe').some((o) => o.type === 'PH')).toBe(true);
  });

  it('resetExperiment empties containers without removing any apparatus', () => {
    fillContainer('flask', 'HCl', 0.1, 0.025);
    const result = resetExperiment('all');
    expect(result.accepted).toBe(true);
    expect(reducer.getContainerStates()['flask']!.volumeL).toBe(0);
    expect(reducer.getApparatus()).toHaveLength(4);
  });

  it('rejects an operation on a target missing the required capability, instead of silently no-op-ing', () => {
    const result = startStirrer('flask', 0.5); // the flask has no STIRRING capability
    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('MISSING_CAPABILITY');
  });
});
