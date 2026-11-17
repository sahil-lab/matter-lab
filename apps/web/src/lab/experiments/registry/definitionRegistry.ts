/**
 * Apparatus definition registry (brief item 2: "Build a plugin-based apparatus capability
 * registry"). Agent 03 owns authoring the real instrument library; this registry is just the
 * lookup surface the reducer (and Agent 04's editor, and test fixtures) use to resolve a
 * `definitionId` on an `ApparatusInstance` to its `ApparatusDefinition`. It is deliberately a thin,
 * mutable-at-startup Map: new definitions can be registered by future plugins without touching the
 * reducer (brief item 6: "asset loading registry ... without modifying editor core").
 */
import type { ApparatusDefinition, ApparatusDefinitionLookup } from '@matterlab/contracts';

export class DefinitionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionRegistryError';
  }
}

/**
 * Read-write apparatus definition registry. Implements `ApparatusDefinitionLookup` (contracts
 * `plugin.ts`) so a plugin or the reducer can depend on the narrow read-only surface instead of
 * this whole class.
 */
export class DefinitionRegistry implements ApparatusDefinitionLookup {
  private readonly definitions = new Map<string, ApparatusDefinition>();

  /** Throws on a duplicate id: a type id must never be silently reassigned to a different design. */
  register(definition: ApparatusDefinition): void {
    const existing = this.definitions.get(definition.id);
    if (existing && existing !== definition) {
      throw new DefinitionRegistryError(
        `An apparatus definition with id "${definition.id}" is already registered; ids are stable and must not be reused for a different design.`,
      );
    }
    this.definitions.set(definition.id, definition);
  }

  registerAll(definitions: readonly ApparatusDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  get(definitionId: string): ApparatusDefinition | undefined {
    return this.definitions.get(definitionId);
  }

  require(definitionId: string): ApparatusDefinition {
    const definition = this.get(definitionId);
    if (!definition) {
      throw new DefinitionRegistryError(`No apparatus definition is registered with id "${definitionId}".`);
    }
    return definition;
  }

  has(definitionId: string): boolean {
    return this.definitions.has(definitionId);
  }

  list(): readonly ApparatusDefinition[] {
    return [...this.definitions.values()];
  }
}

export function createDefinitionRegistry(initial: readonly ApparatusDefinition[] = []): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  registry.registerAll(initial);
  return registry;
}
