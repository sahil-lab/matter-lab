# MATTER LAB — AGENT 06: SCIENTIFIC CHEMISTRY AND TITRATION ENGINE

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 06 — Scientific Simulation Engineer**. Own *correct, reproducible and evidence-labeled* chemistry calculations. The visuals depend on you; do not fabricate results for appearance or game scoring.

## Owned surfaces
`services/science/titration/**`, scientific model registry, validated numerical routines, chemistry benchmark fixtures, scientific explanation quantities, calculation-result schema and method provenance. Coordinate with existing RDKit/NIST/other scientific infrastructure. Agent 07 owns apparatus timing and inventory event reducer; you own chemical equilibria from its state.

## v1 scientific scope
Implement supported educational systems: strong monoprotic acid/strong base; weak monoprotic acid/strong base; weak base/strong acid; selected indicators; water autoionization at specified temperature; dilution and buffer cases where model applicability is clear. Do not imply universal reaction or pharmaceutical synthesis support.

## Required implementation
1. Define pure solver entrypoint accepting validated species composition (moles), total volume in L, temperature K, model ID and explicit assumptions, returning pH, species/equilibrium concentrations, status, diagnostics, method/version and optional numerical uncertainty.
2. Use mass-balance and electroneutrality equations with robust root solving across pH range instead of hardcoded curves or direct shape interpolation. Track ionic activities / ionic strength applicability; for v1 dilute solutions may use ideal activities explicitly labeled.
3. Validate physical inputs: positive volumes, non-negative moles, resolved species identity, supported chemical systems, concentration/temperature range and model compatibility. Emit `UNSUPPORTED` or `FAILED` with clear diagnostics rather than plausible numbers.
4. Provide indicator state from equilibrium/transition models (phenolphthalein, methyl orange, bromothymol blue) with documented color interpolation and why endpoint differs from equivalence.
5. Compute reference quantities for the scientific panel: initial concentrations, delivered volume, equivalence estimate, half-equivalence where relevant, pH, assumptions, units and source IDs. Do not invent uncertainty; include model limitations when no validated uncertainty exists.
6. Expose a typed local function or service API to Agent 07. Ensure numerical methods are benchmarked, deterministic for identical inputs and efficient enough to recompute at meaningful transfer ticks.
7. Use safe, realistic educational reagent defaults; do not expand to unrestricted hazardous reaction planning.

## Benchmarks and tests
- 25.00 mL of 0.100 M HCl titrated by 0.100 M NaOH should have theoretical equivalence at 25.00 mL and pH approximately 7 at 25°C under stated ideal conditions.
- Before/after equivalence, acid/base excess gives chemically sensible monotonic pH trend; pH curve is not hardcoded.
- Equal concentrations of weak monoprotic acetic acid / strong base reproduce buffer behavior, near `pH≈pKa` at half-equivalence under assumptions, and pH >7 at equivalence.
- Verify mass balance, charge balance residuals, unit conversions and solver behavior near sharp equivalence gradients.
- Test unsupported polyprotic/mixtures and out-of-range conditions; errors must propagate correctly.
- Supply a scientific validation report with governing equations, data sources, tolerances and method IDs.

## Deliverables
Working solver/service, reference datasets, automated numerical tests, documented API contracts, result provenance, warnings and integration fixtures for Agent 07/10.
