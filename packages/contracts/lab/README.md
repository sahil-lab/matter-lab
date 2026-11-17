# @matterlab/contracts-lab

Shared Astra lab domain model: the `ExperimentScene` aggregate (`00_SHARED_INTEGRATION_CONTRACT.md`
Section 3), equipment/reagent catalog shapes, and the `/api/v1/lab/**` REST request/response
envelopes. Co-owned by Agent 07 (experiment graph/simulation runtime, the authoritative writer of
live apparatus state) and Agent 09 (persistence, the authoritative writer of durable snapshots).

Zod schemas (`*Schema`) are the source of truth; every exported type (`ExperimentScene`,
`ApparatusInstance`, `Connection`, `Observation`, `RunResult`, `EquipmentDefinition`,
`ReagentDefinition`, `SceneRecord`, `RunRecord`, `ProblemDetails`, ...) is `z.infer`'d from one, so
runtime validation (used by `apps/api`) and the compile-time contract (used by Agent 07's browser
code) can never drift apart. Pure TypeScript, one dependency (`zod`); runs in Node, in a browser, or
in a Web Worker.

```ts
import { experimentSceneSchema, type ExperimentScene } from '@matterlab/contracts-lab';

const scene: ExperimentScene = experimentSceneSchema.parse(responseBody);
```

## Units (fixed, see `domain.ts`)

Scene coordinates in metres, chemical volume in litres, concentration in mol/L, temperature in
kelvin, time in seconds. `Evidence` is `REFERENCE_MEASURED | MODEL_CALCULATED | ILLUSTRATIVE |
UNVERIFIED | UNSUPPORTED` - the Astra lab vocabulary, distinct from `@matterlab/core`'s
`EvidenceLevel`, which labels the pre-existing molecular/reaction editor's results.

## Files

| File | Contents |
|---|---|
| `domain.ts` | The contract's own types verbatim: `UUID`, `Evidence`, `Quantity`, `Transform`, `ApparatusKind`, `Capability`, `ApparatusInstance`, `Connection`, `SpeciesAmount`, `ContainerContents`, `ExperimentScene`, `LabAction`, `Observation`, `RunResult` |
| `equipment.ts` | `EquipmentDefinition` (apparatus catalog entries) and `ReagentDefinition` (the curated, safe reagent allow-list) |
| `api.ts` | HTTP envelopes: `ProblemDetails` (RFC 9457), `Page<T>`, `SceneRecord`/`SceneSummary`, create/patch/duplicate request bodies, `RunRecord`/`RunSummary`/`RunEvent`, `TemplateRecord` |

## Tests

`vitest run --project contracts-lab`: schema round trips against the shared contract's own
vertical-slice example (25.00 mL 0.100 mol/L HCl vs. 0.100 mol/L NaOH), and rejection of invalid
data (wrong `schemaVersion`, unknown capability, negative volume, ...).
