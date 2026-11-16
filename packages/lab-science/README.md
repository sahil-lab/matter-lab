# @matterlab/lab-science

The single authoritative, pure TypeScript chemistry implementation for MATTER LAB's bounded educational titrations. Browser workers and the Node runtime use **the same functions**, constants and numerical routine. No API server, database writer, Python numerical implementation, hardcoded trajectory or UI pH approximation is included.

Method/model ID: **`aqueous-acid-base-ideal-v1`**, method version **`1.0.0`**.

## Public API

Canonical input/result types are imported from and re-exported through `@matterlab/contracts`; they are not redeclared here.

```ts
solveEquilibrium(input: EquilibriumInput): EquilibriumResult
prepareSolution(input: PreparationInput): PreparationResult
getReagentDefinitions(): readonly ReagentDefinition[]
getAnalyticalComponentDefinitions(): readonly AnalyticalComponentDefinition[]
getIndicatorDefinitions(): readonly IndicatorDefinition[]
getScienceSources(): readonly ScienceSource[]
getScienceMethod(): /* model, constants, assumptions and eligibility limits */
getScienceCatalog(): /* serializable curated catalogue */
getTitrationReference(input: TitrationReferenceInput): TitrationReferenceResult
executeScienceRequest(request: unknown): ScienceResponse
solveJson(inputJson: string): string
```

`SCIENCE_METHOD_ID`, `SCIENCE_METHOD_VERSION`, `DEFAULT_ASSUMPTIONS`, and `MODEL_LIMITS` are exported. Type-only exports include the canonical solver/preparation types, `EquilibriumSolver`, `AsyncEquilibriumSolver`, and the package-owned catalogue/reference/JSON types.

```ts
import {
  DEFAULT_ASSUMPTIONS, SCIENCE_METHOD_ID,
  prepareSolution, solveEquilibrium,
} from '@matterlab/lab-science';

const prepared = prepareSolution({
  reagentId: 'hcl',
  volumeL: 0.025,             // 25.00 mL
  concentrationMolL: 0.100,   // analytical reagent concentration
  temperatureK: 298.15,
  mixing: 'WELL_MIXED',
});
if (prepared.status === 'SUCCEEDED') {
  const result = solveEquilibrium({
    contents: prepared.contents,
    methodId: SCIENCE_METHOD_ID,
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  if (result.status === 'SUCCEEDED') {
    console.log(result.pH); // {value: approximately 1, unit: 'pH'}
  }
}
```

**Only Agent 07's runtime writes apparatus inventory.** `prepareSolution` returns a proposed, validated inventory; it does not fill a vessel. Apply accepted preparations/transfers through that runtime. Fluid rendering, UI, backend and gameplay must not implement their own reagent composition or pH.

### Canonical solver shapes

`EquilibriumInput = {contents, methodId, assumptions, indicatorIds?}`. `contents` is exactly `{volumeL, species:[{speciesId,moles,sourceId?}], temperatureK, mixing, modelId}`.

- `SUCCEEDED`: `evidence:'MODEL_CALCULATED'`, `pH:Quantity<'pH'>`, `equilibriumSpecies:[{speciesId,concentrationMolL}]`, `indicators`, provenance and diagnostics.
- `UNSUPPORTED`: `evidence:'UNSUPPORTED'`, RFC 9457-style `error`; **no pH, species or indicator result**.
- `FAILED`: `evidence:'UNVERIFIED'`, RFC 9457-style `error`; **no invented fallback result**.
- Common provenance: `methodId`, `methodVersion`, `sourceIds`, `warnings`, `assumptions`, `limitations`, `diagnostics`.
- No physical `uncertainty` is invented. A root bracket is a numerical diagnostic, not a pH electrode error bar.

Use all three `DEFAULT_ASSUMPTIONS`: `IDEAL_ACTIVITIES`, `ADDITIVE_VOLUMES`, `CLOSED_AQUEOUS_SYSTEM`. Other activity models or condition modifiers are rejected. Boundary fields have explicit units in their names; quantity results also carry `unit`.

`PreparationInput = {reagentId,volumeL,concentrationMolL,temperatureK?,mixing?}`. Temperature defaults to 298.15 K and mixing to `WELL_MIXED` only when omitted, not when null. Success adds `contents` to provenance, never pH. An explicitly `UNMIXED` preparation can be stored, but cannot be assigned bulk pH until mixed.

## Analytical inventory is not equilibrium speciation

| Conserved `speciesId` | Meaning | Equilibrium output members |
|---|---|---|
| `ion:sodium` | resolved spectator Na+(aq) | `ion:sodium` |
| `ion:chloride` | resolved spectator Cl−(aq) | `ion:chloride` |
| `family:acetate` | total CH3COOH + CH3COO− | `molecule:acetic-acid`, `ion:acetate` |
| `family:ammonia` | total NH3 + NH4+ | `molecule:ammonia`, `ion:ammonium` |

Water is the implicit solvent/proton reservoir. The solver obtains `ion:hydronium` and `ion:hydroxide` from equilibrium and electroneutrality; they are **not conserved free-ion inputs**. Do not transfer computed H3O+, OH− or individual weak-family equilibrium species back into inventory.

For example, one analytical mole of HCl contributes one mole of chloride inventory. Its charge imbalance is balanced by hydronium in aqueous equilibrium; this does **not** assert intact HCl molecules persist in solution. NaOH contributes sodium inventory. Sodium acetate contributes equal sodium and acetate-family moles; ammonium chloride contributes equal chloride and ammonia-family moles.

Reagent IDs: `water`, `hcl`, `naoh`, `acetic-acid`, `sodium-acetate`, `ammonia`, `ammonium-chloride`, `sodium-chloride`. Water requires zero *tracked solute* concentration, not 55.5 M. Reagent formulas are explicitly analytical formula labels, not equilibrium species declarations. Get definitions instead of maintaining another recipe table.

## Validated model scope

- HCl/NaOH, acetic acid/NaOH, ammonia/HCl, their selected conjugate buffers/salts, and dilution.
- At most **one** weak family: acetate **or** ammonia, optionally with sodium/chloride. Mixed weak families and unknown/polyprotic identities are explicit `UNSUPPORTED`, including unknown IDs at zero amount.
- Exactly **298.15 K**. No temperature interpolation/extrapolation of Kw, Ka, Kb, neutral pH or indicator constants.
- Finite volume **1e−9 through 100 L**, nonnegative finite analytical moles; at most 128 entries.
- Each analytical component at most **0.100 mol/L**, summed analytical concentration at most **0.200 mol/L**.
- Computed ionic strength at most **0.100001 mol/L**, allowing the water-ion contribution in a nominal 0.100 M neutral salt. Ionic strengths above 0.01 mol/L emit an explicit ideal-activity warning.
- The concentration/ionic-strength bounds are an **educational eligibility policy**, not validated experimental accuracy. Ideal concentration pH at 0.1 M can differ materially from measured activity pH.
- No CO2 absorption, gas exchange, precipitation, polyprotic equilibria, complexation, thermal/mixing kinetics, evaporation or universal mixture/product prediction.

Duplicate supported analytical entries are stably aggregated without mutation. There is no random state, clock, network access, I/O or global inventory in the solver.

## Indicators and endpoints

IDs: `phenolphthalein`, `methyl-orange`, `bromothymol-blue`.

Indicator fraction uses a trace two-state equilibrium. The selected effective pKa values are 9.5, `−log10(4e−4)`, and 7.2 respectively. They are **educational effective constants**, not a full dye-speciation/temperature calibration. Source records disclose their provenance and limitations; bromothymol blue's university numerical excerpt was available through search indexing, while direct retrieval was denied.

`IndicatorResult` contains the calculated `baseFraction`, a normalized `[r,g,b]` display `colorSrgb`, `colorEvidence:'ILLUSTRATIVE'`, and `sourceIds`. Colors use original piecewise-linear sRGB anchors through a midpoint, not Beer–Lambert optics or measured spectra. Phenolphthalein's white/no-tint anchor means colorless, not opaque white liquid. Indicator mass/charge perturbation is explicitly neglected.

Phenolphthalein's selected model is unsupported above pH 12 because alkaline fading is not modeled. Selecting it there makes the request `UNSUPPORTED`; request the valid bulk calculation without that dye rather than fabricating a pink color. Apply indicator IDs only to the relevant receiver, not automatically to a concentrated titrant stock.

```ts
type TitrationReferenceInput = {
  analyte: PreparationInput;
  titrantReagentId: string;
  titrantConcentrationMolL: number;
  deliveredVolumeL: number;
  indicatorId?: string;
  endpointBaseFraction?: number;
};
```

`getTitrationReference` supports one known strong/weak acid or base and its opposite **strong** titrant. It returns unit-bearing initial volume/concentration, analyte amount, titrant concentration, explicit delivered volume, initial pH, equivalence volume/pH, and weak-only half-equivalence volume/pH. These pH references use the **same** solver on private hypothetical reference mixtures; they never write apparatus state.

For an optional endpoint, both `indicatorId` and an explicit `0 < endpointBaseFraction < 1` are required. The helper solves the crossing volume and returns `targetPH`, `estimatedVolume`, `offsetFromEquivalence`, `volumeBracketL` and interpretation. This is a **chosen color-fraction threshold**, not a measured/persistent endpoint, and not stoichiometric equivalence. An unreachable threshold is unsupported; no curve is hardcoded.

The helper **cannot infer delivered volume from current total volume**. The runtime supplies cumulative accepted source→receiver transfers. Agent 07's observation `titration` association retains that exact pairing and station epoch for plotting/export; unassociated data must not be relabeled as a titration curve.

## Node JSON and worker entry

The focused science protocol is `{schemaVersion:1,operation,input?}`:

- `equilibrium`: canonical `EquilibriumInput`;
- `prepare`: canonical `PreparationInput`;
- `titration-reference`: `TitrationReferenceInput`;
- `catalog`: no input.

`solveJson` returns one deterministic JSON result string. The CLI reads one UTF-8 JSON request from stdin and writes one result plus newline to stdout; 262,144 input bytes maximum. Domain failures still produce structured JSON. The science CLI has no server, filesystem access, job queue or persistence. **The production Python backend runs Agent 07's replay CLI bundling this solver**, not a second Python chemistry implementation or a separate scientific trajectory service.

From the repository root on Windows:

```powershell
. .\env.ps1 -Quiet
npm run build --workspace @matterlab/lab-science
$request = @{
  schemaVersion = 1
  operation = 'prepare'
  input = @{ reagentId = 'hcl'; volumeL = 0.025; concentrationMolL = 0.1 }
} | ConvertTo-Json -Depth 8
$request | node .\packages\lab-science\dist\cli.mjs
```

Build also creates `dist\index.mjs`, `dist\worker.mjs`, their shared chunks/maps, and two backend catalogue artifacts:

- `dist\reagent-definitions.json`: generated analytical components, reagents and indicators;
- `dist\source-references.json`: generated source IDs, versions, titles, URLs, access dates and licenses/limitations.

These artifacts are generated from the getters, never maintained as parallel source data. Copy **the whole dist directory** with its chunks when packaging a CLI.

Worker setup, in a dedicated module-worker entry owned by the consumer:

```ts
import { installScienceWorker } from '@matterlab/lab-science/worker';
installScienceWorker(self);
```

`installScienceWorker(scope): () => void` handles the same science request protocol and returns a cleanup callback. It does not register itself on a window or start workers. A consumer requiring request IDs can wrap `executeScienceRequest` in its existing correlated worker transport.

## Validation and sources

```powershell
. .\env.ps1 -Quiet
npm run typecheck --workspace @matterlab/lab-science
npm run test --workspace @matterlab/lab-science
npm run build --workspace @matterlab/lab-science
npm run validate:science --workspace @matterlab/lab-science -- --write
```

Tests cover reference snapshots, a stable independent strong-electrolyte quadratic around sharp equivalence, weak hydrolysis/buffers, mass/charge/Ka/Kw consistency, bounds/failure propagation, deterministic replay, schema interoperability, Node CLI parity and browser-only bundle execution. `fixtures\replay-v1.json` contains inputs, not a solver lookup table. `validation-results.json` is generated from actual execution, with a small 64-call warm CPU timing check, not rendering/FPS claims.

See [METHODS.md](METHODS.md) for governing equations, actual benchmark results, numerical tolerances and the source/accuracy audit.

The existing shared Node installation is used. This package does not modify root manifests/lockfiles or install dependencies; workspace linking is the orchestrator's responsibility.

Numerical facts and citations were curated individually. Source prose, images and restricted datasets are not redistributed. Current OpenStax/LibreTexts license restrictions are recorded, not assumed to be permissive bulk-data licenses. Harvard's content license was not verified; only the individual numerical statement is cited. Original equations, solver, fixtures, explanatory text and display palette are authored for this package.
