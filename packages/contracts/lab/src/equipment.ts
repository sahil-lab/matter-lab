/**
 * Equipment (apparatus) definitions: the catalog Agent 03 authors and Agent 09 serves and
 * versions. A definition is the template an `ApparatusInstance` is placed from (Section 3's
 * `ApparatusInstance.definitionId` refers to `EquipmentDefinition.key`).
 */
import { z } from 'zod';
import { apparatusKindSchema, capabilitySchema, connectionKindSchema, evidenceSchema, quantitySchema } from './domain.js';

export const equipmentSocketSchema = z.object({
  id: z.string().min(1),
  kind: connectionKindSchema,
  /** Capability a compatible counterpart socket must provide, when the connection is capability-gated. */
  mates: capabilitySchema.optional(),
  /** Human-readable placement hint, e.g. "clamp jaw", "burette tip". */
  label: z.string().min(1).max(200).optional(),
});
export type EquipmentSocket = z.infer<typeof equipmentSocketSchema>;

export const equipmentDefinitionSchema = z.object({
  /** Stable catalog key, e.g. `"burette-50ml"`. Referenced by `ApparatusInstance.definitionId`. */
  key: z.string().min(1),
  kind: apparatusKindSchema,
  /** Definition schema version; a new version is a new row (see `apparatus_definition_version`), never an edit in place. */
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capabilities: z.array(capabilitySchema),
  sockets: z.array(equipmentSocketSchema),
  /** Liquid capacity, when the definition has `CONTAINER` capability. */
  capacity: quantitySchema.optional(),
  dimensionsM: z
    .object({
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
      depth: z.number().finite().positive(),
    })
    .optional(),
  /** `LabAction.type` values this apparatus accepts, e.g. `["SET_VALVE", "TRANSFER"]` for a burette. */
  controlActions: z.array(z.string().min(1)),
  defaultConfig: z.record(z.string(), z.unknown()),
  /** How this specification was established; placeholder stock definitions are `UNVERIFIED`, never fabricated as measured. */
  evidence: evidenceSchema,
  notes: z.string().max(2000).optional(),
});
export type EquipmentDefinition = z.infer<typeof equipmentDefinitionSchema>;

export const REAGENT_ROLES = ['ANALYTE', 'TITRANT', 'INDICATOR', 'SOLVENT', 'OTHER'] as const;
export const reagentRoleSchema = z.enum(REAGENT_ROLES);

/**
 * One entry of the curated, safe reagent catalog (Section: "searchable catalogs for equipment and
 * safe curated reagents; link to existing elements/compounds and source IDs"). Deliberately a small
 * allow-list, not a claim of completeness.
 */
export const reagentDefinitionSchema = z.object({
  /** Stable species identifier used as `SpeciesAmount.speciesId`, e.g. `"HCl(aq)"`. */
  speciesId: z.string().min(1),
  name: z.string().min(1).max(200),
  formula: z.string().min(1).max(200),
  roles: z.array(reagentRoleSchema),
  /** Compound catalogued by the existing science service (`compounds.id`), when one exists. */
  scienceCompoundId: z.string().uuid().nullable(),
  /** Safe, pre-approved concentration range for the educational titration templates. */
  recommendedConcentrationMolPerL: z
    .object({
      min: z.number().finite().positive(),
      max: z.number().finite().positive(),
    })
    .optional(),
  hazardNotes: z.string().max(2000).optional(),
  sourceKey: z.string().min(1),
});
export type ReagentDefinition = z.infer<typeof reagentDefinitionSchema>;
