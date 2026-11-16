/**
 * The apparatus definition registry: a simple, additive plugin point. New definitions (including
 * future ones contributed by a different package) register themselves by calling
 * `registerApparatus`; nothing about the editor, renderer or reducer needs to change to support
 * them (brief point 6, "asset loading registry ... without modifying editor core").
 *
 * Registration validates the definition's internal consistency (unique ids, sane ranges,
 * capability/control/container agreement). This is what the "automated metadata tests"
 * deliverable exercises: every definition in `definitions/**` is registered through this path.
 */
import type { ApparatusDefinition } from './types';

export class ApparatusDefinitionError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApparatusDefinitionError(message);
}

/** Throws `ApparatusDefinitionError` with a precise message on the first problem found. Exported
 * so tests (and other agents' integration checks) can validate a definition without registering it. */
export function validateDefinition(def: ApparatusDefinition): void {
  const where = `Apparatus definition "${def.id || '(missing id)'}"`;
  assert(def.id && def.id.trim().length > 0, `${where}: id must be a non-empty string.`);
  assert(Number.isInteger(def.version) && def.version >= 1, `${where}: version must be a positive integer.`);
  assert(def.label.trim().length > 0, `${where}: label must not be empty.`);
  assert(def.dimensionsM.width > 0 && def.dimensionsM.depth > 0 && def.dimensionsM.height > 0, `${where}: dimensionsM must all be positive.`);
  assert(def.capabilities.length === new Set(def.capabilities).size, `${where}: capabilities must not repeat.`);

  const socketIds = new Set<string>();
  for (const socket of def.sockets) {
    assert(socket.id.trim().length > 0, `${where}: a socket has an empty id.`);
    assert(!socketIds.has(socket.id), `${where}: duplicate socket id "${socket.id}".`);
    socketIds.add(socket.id);
    assert(socket.maxConnections >= 1, `${where}: socket "${socket.id}" must allow at least one connection.`);
    assert(socket.accepts.length > 0, `${where}: socket "${socket.id}" declares no accepted roles.`);
    assert(socket.highlightRadiusM > 0, `${where}: socket "${socket.id}" must have a positive highlight radius.`);
    const qLenSq = socket.transform.quaternion.reduce((s, c) => s + c * c, 0);
    assert(Math.abs(qLenSq - 1) < 1e-3, `${where}: socket "${socket.id}" transform quaternion is not normalized.`);
    if (socket.mate === 'axial') {
      assert(!!socket.axialRangeM, `${where}: socket "${socket.id}" is 'axial' but declares no axialRangeM.`);
      assert(socket.axialRangeM![0] <= socket.axialRangeM![1], `${where}: socket "${socket.id}" axialRangeM must be ordered [min, max].`);
    }
    if (socket.mate === 'planar') {
      assert(!!socket.planarAreaM, `${where}: socket "${socket.id}" is 'planar' but declares no planarAreaM.`);
      assert(socket.planarAreaM!.width > 0 && socket.planarAreaM!.depth > 0, `${where}: socket "${socket.id}" planarAreaM must be positive.`);
    }
    if (socket.geometryCheck.kind === 'cylinder-fit') {
      assert(socket.geometryCheck.minDiameterM <= socket.geometryCheck.maxDiameterM, `${where}: socket "${socket.id}" cylinder-fit range is inverted.`);
    }
    if (socket.nominalDiameterM !== undefined) {
      assert(socket.nominalDiameterM > 0, `${where}: socket "${socket.id}" nominalDiameterM must be positive.`);
    }
  }

  const controlIds = new Set<string>();
  for (const control of def.controls) {
    assert(control.id.trim().length > 0, `${where}: a control has an empty id.`);
    assert(!controlIds.has(control.id), `${where}: duplicate control id "${control.id}".`);
    controlIds.add(control.id);
    if (control.requiresCapability) {
      assert(def.capabilities.includes(control.requiresCapability), `${where}: control "${control.id}" requires capability ${control.requiresCapability}, which is not declared.`);
    }
    if (control.valueType === 'number') {
      assert(!!control.range, `${where}: control "${control.id}" is numeric but declares no range.`);
      assert(control.range!.min < control.range!.max, `${where}: control "${control.id}" range must satisfy min < max.`);
      assert(control.range!.default >= control.range!.min && control.range!.default <= control.range!.max, `${where}: control "${control.id}" default is outside its range.`);
    }
    if (control.valueType === 'string') {
      assert(!!control.options && control.options.length > 0, `${where}: control "${control.id}" is string-valued but declares no options.`);
    }
  }

  const hasContainerCapability = def.capabilities.includes('CONTAINER');
  assert(hasContainerCapability === !!def.container, `${where}: CONTAINER capability and a container spec must be declared together.`);
  if (def.container) {
    assert(def.container.capacityL > 0, `${where}: container capacityL must be positive.`);
    const atZero = def.container.fillLevelForVolume(0);
    assert(atZero.heightM >= 0, `${where}: fillLevelForVolume(0) must not be negative.`);
    const atFull = def.container.fillLevelForVolume(def.container.capacityL);
    assert(atFull.heightM <= def.dimensionsM.height + 1e-6, `${where}: fillLevelForVolume(capacity) exceeds the declared height.`);
  }

  if (def.graduation) {
    assert(!!def.container, `${where}: graduation requires a container spec.`);
    assert(def.graduation.majorIntervalML > 0 && def.graduation.minorIntervalML > 0, `${where}: graduation intervals must be positive.`);
    assert(def.graduation.majorIntervalML >= def.graduation.minorIntervalML, `${where}: majorIntervalML must be >= minorIntervalML.`);
  }

  for (const field of def.configSchema) {
    assert(field.key.trim().length > 0, `${where}: a configSchema field has an empty key.`);
    assert(field.key in def.defaultConfig, `${where}: defaultConfig is missing a value for configSchema field "${field.key}".`);
  }

  assert(def.asset.polyCount >= 0, `${where}: asset.polyCount must not be negative.`);
  assert(def.asset.textureMemoryKB >= 0, `${where}: asset.textureMemoryKB must not be negative.`);
  assert(def.asset.license.trim().length > 0, `${where}: asset.license must be documented (brief: "licensing/provenance").`);
  assert(def.asset.materialSlots.length > 0, `${where}: asset.materialSlots must list at least one material slot.`);
}

export class ApparatusRegistry {
  private readonly definitions = new Map<string, ApparatusDefinition>();

  /** Validates and registers a definition. Throws `ApparatusDefinitionError` on a duplicate id
   * unless `replace` is set (used by hot-reload and tests), or on any metadata problem. */
  register(def: ApparatusDefinition, options: { replace?: boolean } = {}): void {
    validateDefinition(def);
    if (this.definitions.has(def.id) && !options.replace) {
      throw new ApparatusDefinitionError(`Apparatus definition id "${def.id}" is already registered.`);
    }
    this.definitions.set(def.id, def);
  }

  get(id: string): ApparatusDefinition | undefined {
    return this.definitions.get(id);
  }

  require(id: string): ApparatusDefinition {
    const def = this.definitions.get(id);
    if (!def) throw new ApparatusDefinitionError(`No apparatus definition registered with id "${id}".`);
    return def;
  }

  list(): ApparatusDefinition[] {
    return [...this.definitions.values()];
  }

  byKind(kind: ApparatusDefinition['kind']): ApparatusDefinition[] {
    return this.list().filter((d) => d.kind === kind);
  }

  byCategory(category: ApparatusDefinition['category']): ApparatusDefinition[] {
    return this.list().filter((d) => d.category === category);
  }

  /** Simple substring match over label, short label and tags, for the palette's search box. */
  search(query: string): ApparatusDefinition[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter(
      (d) => d.label.toLowerCase().includes(q) || d.shortLabel?.toLowerCase().includes(q) || d.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }

  clear(): void {
    this.definitions.clear();
  }
}

/** The process-wide registry used by the running application. Tests that need isolation should
 * construct their own `new ApparatusRegistry()` instead of mutating this singleton. */
export const apparatusRegistry = new ApparatusRegistry();

export function registerApparatus(def: ApparatusDefinition, options?: { replace?: boolean }): void {
  apparatusRegistry.register(def, options);
}
