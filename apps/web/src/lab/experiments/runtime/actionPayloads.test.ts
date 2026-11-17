import { describe, expect, it } from 'vitest';
import {
  parseAttachPayload,
  parseFillPayload,
  parsePlacePayload,
  parseResetPayload,
  parseSetValvePayload,
  parseTransferPayload,
} from './actionPayloads';

describe('action payload parsers', () => {
  it('parsePlacePayload rejects a missing transform', () => {
    const result = parsePlacePayload({ definitionId: 'x', stationId: 'y' });
    expect(result.ok).toBe(false);
  });

  it('parsePlacePayload rejects a transform with the wrong vector lengths', () => {
    const result = parsePlacePayload({ definitionId: 'x', stationId: 'y', transform: { positionM: [0, 0], quaternion: [0, 0, 0, 1] } });
    expect(result.ok).toBe(false);
  });

  it('parsePlacePayload accepts a well-formed payload', () => {
    const result = parsePlacePayload({ definitionId: 'x', stationId: 'y', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] } });
    expect(result.ok).toBe(true);
  });

  it('parseFillPayload rejects a non-array species list', () => {
    const result = parseFillPayload({ volumeL: 0.1, species: 'not-an-array', temperatureK: 298, modelId: 'x' });
    expect(result.ok).toBe(false);
  });

  it('parseFillPayload rejects a species entry missing moles', () => {
    const result = parseFillPayload({ volumeL: 0.1, species: [{ speciesId: 'HCl' }], temperatureK: 298, modelId: 'x' });
    expect(result.ok).toBe(false);
  });

  it('parseAttachPayload requires all three socket fields', () => {
    expect(parseAttachPayload({ socketId: 'a', toInstanceId: 'b' }).ok).toBe(false);
    expect(parseAttachPayload({ socketId: 'a', toInstanceId: 'b', toSocketId: 'c' }).ok).toBe(true);
  });

  it('parseSetValvePayload rejects a non-numeric valveOpening', () => {
    expect(parseSetValvePayload({ valveOpening: 'half' }).ok).toBe(false);
    expect(parseSetValvePayload({ valveOpening: 0.5 }).ok).toBe(true);
  });

  it('parseTransferPayload requires toInstanceId and a finite volumeL', () => {
    expect(parseTransferPayload({ volumeL: 0.01 }).ok).toBe(false);
    expect(parseTransferPayload({ toInstanceId: 'x', volumeL: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(parseTransferPayload({ toInstanceId: 'x', volumeL: 0.01 }).ok).toBe(true);
  });

  it('parseResetPayload requires a stationId for STATION scope but not for SCENE scope', () => {
    expect(parseResetPayload({ scope: 'STATION' }).ok).toBe(false);
    expect(parseResetPayload({ scope: 'STATION', stationId: 's1' }).ok).toBe(true);
    expect(parseResetPayload({ scope: 'SCENE' }).ok).toBe(true);
  });
});
