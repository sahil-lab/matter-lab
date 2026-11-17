# MATTER LAB Astra — Titration and Equilibrium Engine (Agent 06)

Scientific validation report and API reference for `services/science/titration/`: the pure,
dependency-free Python package that solves acid/base equilibria for the MATTER LAB Astra lab
expansion. This package is the **sole source of truth for pH and equilibrium chemistry** in the
expansion; nothing elsewhere (Agent 07's apparatus reducer, Agent 05's fluid renderer, Agent 08's
challenge logic) may compute or infer a pH value independently (`00_SHARED_INTEGRATION_CONTRACT.md`
Section 4).

Method id: **`monoprotic-acid-base-electroneutrality-v1`**, version **`1.0.0`** (`titration/types.py`).

## 1. Governing equations

### 1.1 Mass balance and electroneutrality (the master equation)

For a well-mixed aqueous solution containing, in general, one strong acid, one strong base, at
most one weak-acid system and at most one weak-base system (Section 3 explains why v1 stops
there), mass balance for each weak system and charge balance (electroneutrality) combine into one
equation in a single unknown, the free hydrogen-ion concentration `h = [H+]`:

```
G(h) = h + C_sb + C_wb * h/(h + Ka_wb) + C_cat,extra
     - Kw/h - C_sa - C_wa * Ka_wa/(Ka_wa + h) - C_an,extra   = 0
```

| Symbol | Meaning |
|---|---|
| `C_sa`, `C_sb` | Total analytical concentration (mol/L) of strong acid / strong base. Modelled as completely dissociated: contributes its full concentration as a spectator ion, never through an equilibrium term. |
| `C_wa`, `Ka_wa` | Total analytical concentration and acid dissociation constant of the (at most one) weak-acid system. `alpha_A- = Ka_wa / (Ka_wa + h)` is the fraction present as the conjugate base, from mass balance `[HA] + [A-] = C_wa` and `Ka_wa = h[A-]/[HA]`. |
| `C_wb`, `Ka_wb` | Total analytical concentration of the (at most one) weak-base system and the acid dissociation constant **of its conjugate acid** BH+. `alpha_BH+ = h / (h + Ka_wb)` is the fraction present as BH+. |
| `C_cat,extra`, `C_an,extra` | Inert (non-equilibrating) spectator ion concentrations: e.g. the Na+ of sodium acetate, or a simple supporting electrolyte such as NaCl. |
| `Kw` | Ion product of water at the working temperature (Section 1.2). |

`G` is **strictly increasing** in `h` on `(0, infinity)`: `d(h)/dh = 1 > 0`, `d(-Kw/h)/dh = Kw/h^2 >
0`, and each `d(C . Ka/(Ka + h))/dh` term has a fixed sign for every value of `h`. The equation
therefore has **exactly one positive root** for any physically valid set of concentrations — this
is what lets a single root finder replace a hand-written piecewise formula (before/at/after
equivalence) with one continuous, always-applicable calculation. Mixing a strong acid with a strong
base, for instance, needs no special-casing: the two concentrations simply partially or fully
cancel inside `G`, and the equivalence point (where they cancel exactly) falls out of the solved
curve rather than being asserted.

**Root finding.** `titration/equilibrium.py` solves `G(h) = 0` by bracketing plus Brent's method
(`scipy.optimize.brentq`) on `pH = -log10(h)`, not on `h` directly, so that the search works in a
well-conditioned, linear variable instead of across many orders of magnitude of concentration. The
default search bracket is pH `-3` to `20`; given the concentration cap in Section 3
(`MAX_VALID_CONCENTRATION_MOLAR = 18 mol/L`), `h = 10^3 mol/L` at pH `-3` and `[OH-] = Kw / 10^-20
mol/L` at pH `20` both dominate any accepted analytical concentration, so the bracket is
guaranteed to contain a sign change. A solve typically takes 12-20 Brent iterations (about
15-25 function evaluations) and well under a millisecond — fast enough to recompute at every
simulated transfer tick, not only when a user asks for a reading.

### 1.2 Water autoionization, Kw(T)

`H2O(l) <=> H+(aq) + OH-(aq)`, `Kw = [H+][OH-]` (ideal dilute solution: activity = concentration).

- **Reference value**: `Kw(298.15 K) = 1.0e-14` (pKw = 14.00; a more precise evaluation gives pKw =
  13.995), the long-established IUPAC/NIST-recommended value. Used directly, unmodified, at 25 degC.
- **Temperature dependence**: the standard reaction enthalpy is derived (not independently
  tabulated) from the CODATA Key Values already used by `packages/reactions`
  (`packages/reactions/src/data/thermo.generated.ts`, source id `codata-key-values`; Cox, Wagman &
  Medvedev, *CODATA Key Values for Thermodynamics*, 1989):

  ```
  species    deltaHf298 (kJ/mol)      S298 (J/(mol K))
  H+(aq)     0 (exact, convention)    0 (exact, convention)
  OH-(aq)   -230.015 +/- 0.04        -10.9 +/- 0.2
  H2O(l)    -285.83  +/- 0.04         69.95 +/- 0.03

  deltaH_rxn = deltaHf(H+) + deltaHf(OH-) - deltaHf(H2O) = +55.815 kJ/mol
  deltaS_rxn = S(H+) + S(OH-) - S(H2O)   = -80.85 J/(mol K)
  ```

  `titration/water.py::codata_cross_check_kw` recomputes Kw purely from these values via `deltaG =
  deltaH - T.deltaS`, `Kw = exp(-deltaG / RT)`: it gives `9.967e-15` (pKw 14.0015) at 298.15 K,
  within 0.4% of the literature reference — an independent consistency check, not the value the
  solver actually uses.
- For `T != 298.15 K`, `Kw(T)` is the van't Hoff extrapolation of the 298.15 K reference value with
  `deltaH_rxn` held constant: `ln(Kw(T)/Kw(298.15 K)) = -(deltaH_rxn/R)(1/T - 1/298.15)`. This is
  the same "constant-enthalpy approximation" `packages/reactions` already uses and labels for
  reaction thermodynamics away from 298.15 K (`docs/feature-status.md`). Results at `T != 298.15 K`
  are labelled `MODEL_CALCULATED` (not `REFERENCE_MEASURED`) with a warning naming the
  approximation. Validated range: **273.15 K to 373.15 K** (0 degC to 100 degC at 1 atm).

### 1.3 Indicators

An indicator is itself a weak acid/base pair, `HIn <=> In- + H+`, with its own `pKin`:

```
fraction_basic_form(pH) = 1 / (1 + 10^(pKin - pH))
```

identical in form to `alpha_A-` above. A colour is rendered by linearly interpolating the acid-form
and base-form colours in that fraction (`titration/indicators.py::indicator_color`); this is a
simplified display model, not a measured absorption spectrum, so **colours are labelled
`ILLUSTRATIVE`** even though the underlying fraction is `MODEL_CALCULATED` from a cited `pKin`.

**Why the endpoint differs from the equivalence point.** The equivalence point
(`titration_curve.py::equivalence_volume_l`) is defined purely by stoichiometry: moles of titrant
delivered equal moles of analyte, for the 1:1 monoprotic reactions this package supports. The
colour change is seen when the *indicator's own* equilibrium crosses its `pKin`, a fixed property
of the dye, unrelated to the titration. `titration_curve.py::indicator_endpoint_volume_l` finds the
delivered volume where the solved curve's own pH crosses `pKin` by the same bracketing
root-finding idiom as the main solver (not interpolated from a table), and
`compare_endpoint_to_equivalence` reports the difference with an explanation. Two concrete,
computed examples (see `titration/fixtures/indicators.json`):

- **Strong acid/strong base** (25.00 mL 0.100 M HCl + 0.100 M NaOH): the pH gradient at equivalence
  is so steep (more than 2 pH units within 2 microlitres either side of 25.00 mL) that both
  phenolphthalein (pKin 9.4) and methyl orange (pKin 3.7) give endpoints within about 0.1 mL of the
  true 25.0000 mL equivalence volume — the textbook reason either indicator "works" here.
- **Weak acid/strong base** (25.00 mL 0.100 M acetic acid + 0.100 M NaOH, equivalence pH approx
  8.73): phenolphthalein's endpoint falls about 0.012 mL after equivalence (still an excellent
  choice); methyl orange's crosses at about 1.97 mL, **23 mL short of the true 25.00 mL
  equivalence** — a large, computed titration error, the concrete reason methyl orange is the wrong
  indicator for a weak-acid titration, rather than an assertion about it.

## 2. Data sources

| Quantity | Value (25 degC) | Source |
|---|---|---|
| Kw | `1.0e-14` (pKw 14.00; 13.995 more precisely) | IUPAC / NIST Chemistry WebBook recommended value |
| deltaH, deltaS of water autoionization | `+55.815 kJ/mol`, `-80.85 J/(mol K)` | Derived from CODATA Key Values (Cox, Wagman & Medvedev, 1989), already cited in `packages/reactions` |
| Acetic acid, Ka (pKa) | `1.75e-5` (`4.756`) | Goldberg, R. N.; Kishore, N.; Lennen, R. M. "Thermodynamic Quantities for the Ionization Reactions of Buffers." *J. Phys. Chem. Ref. Data* **2002**, *31*, 231-370 (NIST) |
| Ammonium ion (NH4+), Ka (pKa) | `5.62e-10` (`9.25`) | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. (2004) |
| Formic acid, pKa | `3.75` | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. |
| Benzoic acid, pKa | `4.20` | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. |
| Phenolphthalein, methyl orange, bromothymol blue: pKin and visual transition ranges | `9.4` (8.3-10.0); `3.7` (3.1-4.4); `7.1` (6.0-7.6) | The Engineering ToolBox; Wired Chemist acid-base indicator tables |
| Molar gas constant R | `8.31446261815324 J/(mol K)` | Exact, 2019 SI redefinition; same value as `packages/core/src/constants.ts` |

Every value above was checked against a live source during this session (web search citations in
the implementation commit), not recalled from training data and left unverified. `titration/species.py`
and `titration/indicators.py` carry the same citations as machine-readable `Provenance` records
returned with every API response (`GET /v1/titration/species`, `GET /v1/titration/indicators`).

Strong acids (HCl, HNO3, HBr) and strong bases (NaOH, KOH) carry no Ka/Kb: they are modelled as
completely dissociated, which is itself the (textbook-level) claim being made, not a separate
numerical value requiring a citation.

## 3. Scope, validation and tolerances

### v1 supported systems
Strong monoprotic acid/strong base; weak monoprotic acid/strong base; weak base/strong acid; pure
water/dilution; buffers prepared either by partial titration or by direct dosing of a weak
acid/base together with its conjugate salt (sodium acetate, ammonium chloride); simple supporting
electrolytes (NaCl, KNO3) for ionic-strength tracking.

### Explicitly out of scope (checked, not merely undocumented)
- **Polyprotic acids/bases**: sulfuric, phosphoric, carbonic and oxalic acid, and calcium
  hydroxide, are pre-registered in `species.py` with a specific reason (`"Diprotic..."`,
  `"Triprotic..."`) so a request for them answers `UNSUPPORTED` with that reason, not a generic
  "unknown species" message and never a plausible-looking pH.
- **Mixtures**: two distinct weak-acid systems, two distinct weak-base systems, a weak acid and a
  weak base together, or a strong and a weak acid/base of the same kind together, are all
  `UNSUPPORTED` (`solver.py::solve_equilibrium`), even though the underlying charge-balance
  arithmetic could in principle sum further terms — this is a deliberate v1 scope decision, not a
  mathematical limit, and is flagged here for the orchestrator if a future agent wants to lift it.
- **Non-ideal activity**: only `activity_model="ideal"` (activity = concentration) is implemented;
  any other value is `UNSUPPORTED`. Ionic strength `I = 0.5 * sum(C_i z_i^2)` is computed and
  returned as a diagnostic on every successful solve, with a warning above `0.1 mol/L` (roughly the
  edge of where the Debye-Huckel limiting law is still a reasonable guide) that the ideal-activity
  assumption is increasingly approximate there — this is the "may use ideal activities explicitly
  labeled" option the brief allows for v1, not a silent inaccuracy.
- **Temperature**: `273.15 K` to `373.15 K` for the aqueous/Kw model; a tighter `288.15 K` to
  `308.15 K` band for any solve that involves a weak acid/base system, because v1 does not give
  Ka/Kb their own temperature model (only Kw(T) is temperature-corrected) — outside that narrower
  band a weak-system solve is `UNSUPPORTED`, not silently computed with a stale Ka.
- **Concentration**: `0` to `18 mol/L` per named concentration (strong acid, strong base, each weak
  system, each spectator pool); above that the ideal-dilute-solution model is not considered valid
  and the result is `UNSUPPORTED`.

### FAILED vs. UNSUPPORTED
`FAILED` means the request is physically malformed (negative or non-finite volume/moles, a volume
outside `1e-9 L` to `1000 L`) or, in principle, that the root finder itself did not converge for a
validated input (not observed in testing: see Section 4). `UNSUPPORTED` means the request is
well-formed but names chemistry or conditions outside the validated v1 scope above. Both carry a
human-readable `reason` and structured `diagnostics`; neither carries a `pH`.

### Tolerances
- Root finder: `scipy.optimize.brentq` with `xtol=1e-13`, `rtol≈8.88e-16` on pH, `maxiter=200`
  (typically needs 12-20). The charge-balance residual at the reported root is itself returned as
  `diagnostics.charge_balance_residual_molar` and is below `1e-8 mol/L` on every benchmark and test
  case (see Section 4); mass-balance residuals per weak system (`[HA] + [A-] - C_total`, etc.) are
  reported the same way and are equally small.
- `numerical_uncertainty.ph_numerical_tolerance = 1e-9` is the root finder's own convergence
  tolerance, **not** a propagated measurement uncertainty from the Ka/Kw source data — the package
  does not have those uncertainties in a form it can honestly propagate in v1, and says so in
  `numerical_uncertainty.limitations` rather than inventing an error bar.

## 4. Benchmark results (from the brief's "Benchmarks and tests")

All of the following are automated tests (`services/science/tests/test_titration_benchmarks.py`,
run with real numerics, not asserted by inspection) and/or committed fixtures
(`titration/fixtures/*.json`, generated by `titration/fixtures/generate_fixtures.py` from the live
solver, with a regression test — `test_titration_fixtures.py` — that fails if the committed files
and the live solver ever disagree).

| Benchmark (brief wording) | Result |
|---|---|
| 25.00 mL of 0.100 M HCl titrated by 0.100 M NaOH: equivalence at 25.00 mL, pH approx 7 at 25 degC | Equivalence volume `0.025000000000000005 L` (25.0000 mL); pH at equivalence `7.000000000002128` |
| Before/after equivalence: chemically sensible monotonic trend, not hardcoded | pH strictly increases across 15 independently solved points from 0 to 50 mL delivered; cross-checked against the classical pre-/post-equivalence closed-form approximations (`pH = -log10(excess/volume)`) to within 0.01 pH units away from equivalence, where that approximation is valid |
| Equal-concentration acetic acid/NaOH: pH approx pKa at half-equivalence, pH > 7 at equivalence | pH at half-equivalence (12.500 mL) = `4.756456525381417` vs. pKa `4.756`; pH at equivalence = `8.727537982749062` (basic, as expected for a salt of a weak acid and a strong base) |
| Mass balance, charge balance residuals, unit conversions, behaviour near sharp gradients | Charge-balance residual `≈1e-15` to `0` at every tested point; mass-balance residual for the weak system `≈1e-15` to `0`; a 1 mL vs. 1000 mL-scaled description of the same system gives bit-identical pH; the solver converges cleanly 1 microlitre either side of the strong-acid/strong-base equivalence point, where pH changes by more than 2 units |
| Unsupported polyprotic/mixtures and out-of-range conditions propagate correctly | All five pre-registered polyprotic/diacidic species, three kinds of mixture, five out-of-range temperatures, excessive concentration, an unresolvable species id, a malformed model id, negative moles and negative/zero/non-finite volume each produce the expected `UNSUPPORTED`/`FAILED` status with a reason naming the actual problem |

Weak base/strong acid (ammonia/HCl, the brief's third supported system) is benchmarked the same
way: pH at half-equivalence `≈ pKa(NH4+) = 9.25`, pH at equivalence `< 7` (acidic, ammonium chloride
solution).

## 5. API surface for Agent 07/09/10

### Local Python function (no service needed)
```python
from titration.solver import solve_equilibrium
from titration.types import SpeciesAmountInput

result = solve_equilibrium(
    species=[SpeciesAmountInput("hydrochloric-acid", 0.0025), SpeciesAmountInput("sodium-hydroxide", 0.0025)],
    volume_l=0.05,       # litres
    temperature_k=298.15,
)
result.status          # "SUCCEEDED" | "UNSUPPORTED" | "FAILED"
result.pH               # float | None
result.evidence         # "REFERENCE_MEASURED" | "MODEL_CALCULATED" | "ILLUSTRATIVE" | "UNVERIFIED" | "UNSUPPORTED"
result.diagnostics      # residuals, ionic strength, root-finder iterations/bracket, input hash
```
Pure and deterministic: identical inputs always produce an identical `SolveResult` (same `pH`,
same `diagnostics.input_hash`), with no I/O.

### HTTP (`matterlab_science/api/titration.py`, mounted on the existing FastAPI service)
Needs **no database** (unlike most of this service's other routers): registered in `main.py`
alongside `chem.router` for that reason.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/titration/solve` | One equilibrium snapshot (species + volume + temperature -> status/pH/diagnostics) |
| `POST` | `/v1/titration/curve` | A full pH-vs-delivered-volume curve for one analyte/titrant setup |
| `GET` | `/v1/titration/species` | Every species the solver recognises, supported or explicitly not, with its provenance |
| `GET` | `/v1/titration/indicators` | The three shipped indicators: pKin, colours, visual range, provenance |
| `GET` | `/v1/titration/indicators/{id}/state` | Fraction/colour/state label of one indicator at a given pH |
| `POST` | `/v1/titration/endpoint-comparison` | Indicator colour-change volume vs. the stoichiometric equivalence volume, with an explanation |

A syntactically valid request always answers `200` with a body whose `status` field says whether
the number is usable (`SUCCEEDED`/`UNSUPPORTED`/`FAILED`) — this is not "HTTP 200 with a fake
value" (forbidden by the shared contract) because the body is explicit either way. A request that
cannot even be classified (e.g. an unresolvable species id for the curve/endpoint-comparison
endpoints) is `422` with the service's standard `{"error": {"code","message","details"}}` shape.

### Integration fixtures (`titration/fixtures/*.json`)
Machine-readable input/expected-output pairs for the benchmarks above, generated from (and
regression-tested against) the live solver: `strong_acid_strong_base_hcl_naoh.json`,
`weak_acid_strong_base_acetic_acid_naoh.json`, `weak_base_strong_acid_ammonia_hcl.json`,
`unsupported_and_failed_cases.json`, `indicators.json`, `species_registry.json`. A consumer in
another language only needs to reproduce each case's `input` through its own channel (e.g. an HTTP
call) and compare the `expected` fields within `tolerance_pH`.

## 6. Known limitations (for the orchestrator and for Agent 07/09/10)

- Evidence vocabulary: this package uses the **shared contract's** uppercase enum
  (`REFERENCE_MEASURED`/`MODEL_CALCULATED`/`ILLUSTRATIVE`/`UNVERIFIED`/`UNSUPPORTED`,
  `00_SHARED_INTEGRATION_CONTRACT.md` Section 3), which is a different vocabulary from the existing
  v1 app's lowercase one (`matterlab_science.provenance.EvidenceLevel`:
  `reference`/`computed`/`rule-based`/`illustrative`/`user-input`/`unsupported`, documented in
  `docs/architecture.md`). `titration/provenance.py` documents an explicit mapping
  (`evidence_to_legacy`/`evidence_from_legacy`) but the two vocabularies are not unified anywhere
  else in the service; flagged for Agent 10 to reconcile before the Astra expansion ships.
- Mixtures of acid/base strengths or of several distinct weak systems are a deliberate v1 scope cut
  (Section 3), not a mathematical limit of the charge-balance approach, which would extend to them
  with sourced Ka data and a scope decision from the orchestrator.
- No non-ideal activity correction (Davies/Debye-Huckel) is implemented; only the ideal model the
  brief explicitly allows for v1.
- Ka/Kb values have no temperature model of their own in v1 (only Kw(T) does); weak-system solves
  are restricted to a +/-10 K band around 25 degC rather than silently extrapolated.
- This package has not been exercised against the full Docker/PostgreSQL stack in this session (see
  the Agent 06 status report in the session history for why, and what was verified instead: the
  real `matterlab_science.main.create_app()` factory, `TestClient`-driven HTTP contract tests, and
  OpenAPI schema generation, all without a database, since this router needs none).

## 7. Running the tests

From `services/science/` (no Docker, no PostgreSQL needed for any of the files below — they are
plain `pytest`, matching this package's design goal of being testable as a pure library):

```powershell
pip install pytest fastapi httpx "psycopg[binary]"   # once, if not already present
python -m pytest tests/test_titration_equilibrium.py tests/test_titration_benchmarks.py tests/test_titration_indicators.py tests/test_titration_api.py tests/test_titration_fixtures.py -v
```

To regenerate the committed fixtures after a deliberate, reviewed change to the solver:

```powershell
python -m titration.fixtures.generate_fixtures
```
