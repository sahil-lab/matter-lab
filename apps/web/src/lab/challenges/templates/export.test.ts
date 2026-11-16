import { describe, expect, it } from 'vitest';
import { buildAssembledScene } from '../fixtures/strongAcidStrongBaseFixture';
import { buildTemplateFromScene, parseTemplate, serializeTemplate } from './export';

describe('lab templates', () => {
  it('round-trips a guided setup through JSON without losing apparatus, connections or starting fills', () => {
    const scene = buildAssembledScene();
    const template = buildTemplateFromScene(scene, { name: 'My titration setup', description: 'Stand, clamp, burette and flask ready to titrate.', objectiveId: 'titration-strong-acid-strong-base-guided' });
    const json = serializeTemplate(template);
    const parsed = parseTemplate(json);
    expect(parsed.apparatus).toHaveLength(scene.apparatus.length);
    expect(parsed.connections).toHaveLength(scene.connections.length);
    expect(parsed.containerStates).toEqual(scene.containerStates);
    expect(parsed.name).toBe('My titration setup');
  });

  it('rejects a file that is not a MATTER LAB lab template', () => {
    expect(() => parseTemplate(JSON.stringify({ hello: 'world' }))).toThrow(/not a MATTER LAB lab template/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseTemplate('{not json')).toThrow(/not valid JSON/);
  });
});
