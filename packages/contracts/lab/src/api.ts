/**
 * HTTP-facing shapes of the lab REST API (`00_SHARED_INTEGRATION_CONTRACT.md` Section 5). These
 * wrap the pure domain model (`domain.ts`) with persistence envelope fields (ids, revisions,
 * timestamps, ownership) and define the request/response bodies Agent 09's API accepts and returns.
 */
import { z } from 'zod';
import {
  apparatusInstanceSchema,
  connectionSchema,
  containerContentsSchema,
  experimentSceneSchema,
  labActionSchema,
  observationSchema,
  runResultSchema,
  runStatusSchema,
  simulationConfigSchema,
  uuidSchema,
} from './domain.js';

/**
 * RFC 9457 Problem Details, the error shape mandated by the shared contract for every
 * `/api/v1/lab/**` response outside the 2xx range. `code` and `errors` are this API's stable
 * extension members.
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1).default('about:blank'),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().min(1).optional(),
  instance: z.string().min(1).optional(),
  /** Stable machine-readable error code, e.g. `revision_conflict` or `scene_not_found`. */
  code: z.string().min(1),
  /** Field-level validation problems, present on `code: "validation_error"`. */
  errors: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export function pageSchema<ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const ownerIdSchema = uuidSchema.nullable();

export const sceneRecordSchema = experimentSceneSchema.extend({
  title: z.string().min(1).max(300),
  ownerId: ownerIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
/** `ExperimentScene` plus the persistence envelope returned by the scene endpoints. */
export type SceneRecord = z.infer<typeof sceneRecordSchema>;

export const sceneSummarySchema = z.object({
  id: uuidSchema,
  title: z.string(),
  revision: z.number().int().nonnegative(),
  stationCount: z.number().int().nonnegative(),
  apparatusCount: z.number().int().nonnegative(),
  ownerId: ownerIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SceneSummary = z.infer<typeof sceneSummarySchema>;

export const sceneCreateRequestSchema = z.object({
  title: z.string().min(1).max(300),
  stations: experimentSceneSchema.shape.stations.default([]),
  apparatus: z.array(apparatusInstanceSchema).default([]),
  connections: z.array(connectionSchema).default([]),
  containerStates: z.record(uuidSchema, containerContentsSchema).default({}),
  simulationConfig: simulationConfigSchema.default({ methodId: 'fixed-tick-v1', timeStepS: 0.1 }),
  viewport: z.record(z.string(), z.unknown()).optional(),
});
export type SceneCreateRequest = z.infer<typeof sceneCreateRequestSchema>;

/** Every field is optional: only fields present in the request body are changed. `If-Match` carries the expected revision. */
export const scenePatchRequestSchema = z
  .object({
    title: z.string().min(1).max(300),
    stations: experimentSceneSchema.shape.stations,
    apparatus: z.array(apparatusInstanceSchema),
    connections: z.array(connectionSchema),
    containerStates: z.record(uuidSchema, containerContentsSchema),
    simulationConfig: simulationConfigSchema,
    viewport: z.record(z.string(), z.unknown()),
  })
  .partial();
export type ScenePatchRequest = z.infer<typeof scenePatchRequestSchema>;

export const sceneDuplicateRequestSchema = z.object({
  title: z.string().min(1).max(300).optional(),
});
export type SceneDuplicateRequest = z.infer<typeof sceneDuplicateRequestSchema>;

export const runCreateRequestSchema = z.object({
  /** Method to run, e.g. `"titration.strong_acid_strong_base.charge_balance.v1"`. */
  methodId: z.string().min(1),
  /** Action log to replay from the scene's current state (`TRANSFER` steps, valve settings...). */
  actions: z.array(labActionSchema).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;

export const runRecordSchema = runResultSchema.extend({
  sceneId: uuidSchema,
  sceneRevision: z.number().int().nonnegative(),
  /** Stable machine-readable reason for a FAILED/UNSUPPORTED status, e.g. `unrecognized_analyte`. */
  failureCode: z.string().min(1).optional(),
  failureMessage: z.string().min(1).optional(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const runSummarySchema = z.object({
  runId: uuidSchema,
  sceneId: uuidSchema,
  status: runStatusSchema,
  methodId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true }),
  status: runStatusSchema,
  message: z.string(),
  observation: observationSchema.optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const templateCreateRequestSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  apparatus: z.array(apparatusInstanceSchema),
  connections: z.array(connectionSchema),
});
export type TemplateCreateRequest = z.infer<typeof templateCreateRequestSchema>;

export const templateRecordSchema = templateCreateRequestSchema.extend({
  id: uuidSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TemplateRecord = z.infer<typeof templateRecordSchema>;

export const EXPORT_FORMATS = ['xlsx', 'json'] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
