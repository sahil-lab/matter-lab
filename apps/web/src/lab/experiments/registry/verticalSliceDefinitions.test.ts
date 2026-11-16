import { describe, expect, it } from 'vitest';
import { canSocketsConnect, type ApparatusDefinition } from '@matterlab/contracts';
import {
  BENCH_DEFINITION,
  BURETTE_DEFINITION,
  CLAMP_DEFINITION,
  FLASK_DEFINITION,
  PH_PROBE_DEFINITION,
  STAND_DEFINITION,
  STIRRER_DEFINITION,
  VERTICAL_SLICE_DEFINITIONS,
} from './verticalSliceDefinitions';

function socketOf(definition: ApparatusDefinition, socketId: string) {
  const socket = definition.sockets.find((s) => s.id === socketId);
  if (!socket) throw new Error(`${socketId} not found`);
  return socket;
}

describe('vertical-slice apparatus definitions', () => {
  it('every definition is marked isPlaceholder (Agent 03 reconciliation pending)', () => {
    for (const definition of VERTICAL_SLICE_DEFINITIONS) {
      expect(definition.isPlaceholder).toBe(true);
    }
  });

  it('declares no duplicate ids', () => {
    const ids = VERTICAL_SLICE_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['stand.foot -> bench.surface', STAND_DEFINITION, 'foot', BENCH_DEFINITION, 'surface'],
    ['clamp.grip -> stand.pole', CLAMP_DEFINITION, 'grip', STAND_DEFINITION, 'pole'],
    ['burette.barrel -> clamp.bore', BURETTE_DEFINITION, 'barrel', CLAMP_DEFINITION, 'bore'],
    ['burette.tip -> flask.mouth', BURETTE_DEFINITION, 'tip', FLASK_DEFINITION, 'mouth'],
    ['flask.base -> stirrer.platform', FLASK_DEFINITION, 'base', STIRRER_DEFINITION, 'platform'],
    ['probe.grip -> stand.pole', PH_PROBE_DEFINITION, 'grip', STAND_DEFINITION, 'pole'],
    ['probe.tip -> flask.probePort', PH_PROBE_DEFINITION, 'tip', FLASK_DEFINITION, 'probePort'],
  ] as const)('%s is a compatible socket pair', (_label, fromDef, fromSocketId, toDef, toSocketId) => {
    const result = canSocketsConnect(
      { definition: fromDef, socket: socketOf(fromDef, fromSocketId) },
      { definition: toDef, socket: socketOf(toDef, toSocketId) },
    );
    expect(result.ok).toBe(true);
  });
});
