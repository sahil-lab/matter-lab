import { describe, expect, it } from 'vitest';
import { createUnavailableSolverClient, type SolverRequest } from '../lab/solver';

describe('createUnavailableSolverClient', () => {
  it('never fabricates an observation and always reports UNSUPPORTED', async () => {
    const client = createUnavailableSolverClient();
    const request: SolverRequest = {
      requestId: 'req-1',
      stationId: 'station-1',
      apparatusId: 'flask-1',
      contents: { volumeL: 0.025, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'n/a' },
      conditions: { temperatureK: 298.15, methodId: 'strong-acid-strong-base-v1' },
      atSimulationS: 0,
    };
    const response = await client.evaluate(request);
    expect(response.status).toBe('UNSUPPORTED');
    expect(response.observations).toHaveLength(0);
    expect(response.assumptions.join(' ')).toMatch(/not connected/i);
  });

  it('is deterministic for the same request shape (same status/assumptions every call)', async () => {
    const client = createUnavailableSolverClient();
    const request: SolverRequest = {
      requestId: 'req-2',
      stationId: 'station-1',
      apparatusId: 'flask-1',
      contents: { volumeL: 0.025, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'n/a' },
      conditions: { temperatureK: 298.15, methodId: 'strong-acid-strong-base-v1' },
      atSimulationS: 1,
    };
    const first = await client.evaluate(request);
    const second = await client.evaluate(request);
    expect(second.status).toBe(first.status);
    expect(second.assumptions).toEqual(first.assumptions);
  });
});
