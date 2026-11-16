import { describe, expect, it } from 'vitest';
import type { ContainerContents, ExperimentScene } from '@matterlab/contracts';
import { createDefinitionRegistry, VERTICAL_SLICE_DEFINITIONS } from '../registry';
import { applyLabAction, buildAttachAction, buildCreateStationAction, buildPlaceAction, type ReducerContext } from '../runtime';
import { ORIGIN_TRANSFORM } from '../testFixtures';
import { createAcidBaseTitrationPlugin, STRONG_ACID_STRONG_BASE_METHOD_ID } from './titrationPlugin';

const registry = createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS);
const context: ReducerContext = { registry };
const plugin = createAcidBaseTitrationPlugin();

function apply(scene: ExperimentScene, action: Parameters<typeof applyLabAction>[1]): ExperimentScene {
  const outcome = applyLabAction(scene, action, context);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.scene;
}

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

describe('acid-base titration plugin', () => {
  it('reports unsupported when the station has no titrant source or receiver', () => {
    let scene = emptyScene();
    scene = apply(scene, buildCreateStationAction('station-1', 'Station 1'));
    const support = plugin.detectSupport(scene, 'station-1', registry);
    expect(support.supported).toBe(false);
  });

  it('reports unsupported when source and receiver exist but are not connected', () => {
    let scene = emptyScene();
    scene = apply(scene, buildCreateStationAction('station-1', 'Station 1'));
    scene = apply(scene, buildPlaceAction('burette-1', 'burette.class-a.50ml', 'station-1', ORIGIN_TRANSFORM));
    scene = apply(scene, buildPlaceAction('flask-1', 'flask.conical.250ml', 'station-1', ORIGIN_TRANSFORM));
    const support = plugin.detectSupport(scene, 'station-1', registry);
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/not connected/i);
  });

  it('reports supported once a FLOW_SOURCE and FLOW_RECEIVER are linked by an enabled FLUID connection', () => {
    let scene = emptyScene();
    scene = apply(scene, buildCreateStationAction('station-1', 'Station 1'));
    scene = apply(scene, buildPlaceAction('burette-1', 'burette.class-a.50ml', 'station-1', ORIGIN_TRANSFORM));
    scene = apply(scene, buildPlaceAction('flask-1', 'flask.conical.250ml', 'station-1', ORIGIN_TRANSFORM));
    scene = apply(scene, buildAttachAction('burette-1', 'tip', 'flask-1', 'mouth'));
    const support = plugin.detectSupport(scene, 'station-1', registry);
    expect(support.supported).toBe(true);
  });

  it('selects every CONTAINER+FLOW_RECEIVER instance in the station as an observation target', () => {
    let scene = emptyScene();
    scene = apply(scene, buildCreateStationAction('station-1', 'Station 1'));
    scene = apply(scene, buildPlaceAction('burette-1', 'burette.class-a.50ml', 'station-1', ORIGIN_TRANSFORM));
    scene = apply(scene, buildPlaceAction('flask-1', 'flask.conical.250ml', 'station-1', ORIGIN_TRANSFORM));
    const targets = plugin.selectObservationTargets(scene, 'station-1');
    expect(targets).toEqual(['flask-1']);
  });

  it('builds a solver request stamped with the strong-acid/strong-base method id and its assumptions', () => {
    const contents: ContainerContents = { volumeL: 0.025, species: [{ speciesId: 'HCl', moles: 0.0025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'aqueous-ideal-v1' };
    const request = plugin.buildSolverRequest(contents, { temperatureK: 298.15 }, { registry, atSimulationS: 0 });
    expect(request).not.toBeNull();
    expect(request?.conditions.methodId).toBe(STRONG_ACID_STRONG_BASE_METHOD_ID);
    expect(request?.conditions.assumptions?.length).toBeGreaterThan(0);
  });

  it('declines to build a request for an empty container', () => {
    const contents: ContainerContents = { volumeL: 0, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'empty' };
    expect(plugin.buildSolverRequest(contents, { temperatureK: 298.15 }, { registry, atSimulationS: 0 })).toBeNull();
  });
});
