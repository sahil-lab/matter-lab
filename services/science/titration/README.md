# MATTER LAB Astra — Titration and Equilibrium Engine (Agent 06)

Scientific validation report and API reference for `services/science/titration/`: the pure,
dependency-free Python package that solves acid/base equilibria for the MATTER LAB Astra lab
expansion. This package is the **sole source of truth for pH and equilibrium chemistry** in the
expansion; nothing elsewhere (Agent 07's apparatus reducer, Agent 05's fluid renderer, Agent 08's
challenge logic) may compute or infer a pH value independently (`00_SHARED_INTEGRATION_CONTRACT.md`
Section 4).

Method id: **`acid-base-electroneutrality-v1`**, version **`2.0.0`** (`titration/types.py`).

> **v2 scope note.** The original brief (`Agent_06_Scientific_Chemistry_and_Titration_Engine.md`)
> scoped v1 to monoprotic systems, one weak-acid-or-base system at a time, ideal activity only, and
> Kw(T) as the only temperature model. By explicit user request in this session, four of those
> deliberate v1 cuts have been lifted: **polyprotic acids/bases**, **multiple simultaneous weak
> systems** (mixtures), a **non-ideal (Davies-equation) activity model**, and a **sourced Ka(T)
> model** for the one species (acetic acid) with ionization thermodynamics found in this session.
> Section 3 states exactly what is and is not covered now.

## 1. Governing equations

### 1.1 Mass balance and electroneutrality (the master equation)

For a well-mixed aqueous solution containing a strong acid, a strong base, and any number of
distinct weak-acid and weak-base systems (each itself monoprotic or polyprotic), mass balance for
every weak system and charge balance (electroneutrality) combine into one equation in a single
unknown, the free hydrogen-ion concentration `h = [H+]`:

```
G(h) = h + C_sb + C_cat,extra + sum_j C_wb,j * Z_base(h, Ka_steps_wb,j)
     - Kw/h - C_sa - C_an,extra - sum_i C_wa,i * Z_acid(h, Ka_steps_wa,i)   = 0
```

| Symbol | Meaning |
|---|---|
| `C_sa`, `C_sb` | Total analytical concentration (mol/L) of strong acid / strong base. Modelled as completely dissociated: contributes its full concentration as a spectator ion, never through an equilibrium term. |
| `C_wa,i`, `Ka_steps_wa,i` | Total analytical concentration and the ordered stepwise acid dissociation constants (`Ka_1, ..., Ka_n`) of weak-acid system `i` (`n = 1` for a monoprotic system, e.g. acetic acid; `n = 3` for phosphoric acid). |
| `C_wb,j`, `Ka_steps_wb,j` | Total analytical concentration of weak-base system `j` and the stepwise acid dissociation constants **of its conjugate acid** (most-protonated form first). |
| `C_cat,extra`, `C_an,extra` | Inert (non-equilibrating) spectator ion concentrations: e.g. the Na+ of sodium acetate, or a simple supporting electrolyte such as NaCl. |
| `Kw` | Ion product of water at the working temperature and ionic strength (Sections 1.2-1.3). |

`Z_acid`/`Z_base` are the **n-step distribution functions** (Section 1.1.1): for a monoprotic
system `Z_acid(h, (Ka,)) = Ka/(Ka+h)` and `Z_base(h, (Ka,)) = h/(h+Ka)`, recovering the familiar
single-step formulas exactly.

`G` is **strictly increasing** in `h` on `(0, infinity)` for *any* number of strong/weak/polyprotic
terms (Section 1.1.1 proves this for `Z_acid`/`Z_base`; `d(h)/dh = 1 > 0` and `d(-Kw/h)/dh = Kw/h^2
> 0` as before), so the equation has **exactly one positive root** regardless of how many systems
are summed — this is what lets a single root finder replace a hand-written piecewise formula
(before/at/after equivalence, or one buffer region per dissociation step of a polyprotic acid) with
one continuous, always-applicable calculation. Mixing a strong acid with a strong base, or two
distinct weak acids, needs no special-casing: the terms simply partially or fully cancel inside
`G`, and equivalence points (where they cancel exactly) fall out of the solved curve rather than
being asserted.

#### 1.1.1 The n-step distribution function Z

For an n-protic weak-acid system with stepwise constants `Ka_1, ..., Ka_n` (`H_nA -> H_(n-1)A^- +
H+` is `Ka_1`, and so on), define the cumulative products `beta_0 = 1`, `beta_i = Ka_1 . Ka_2 ...
Ka_i` and the distribution polynomial

```
D(h) = sum_{i=0}^{n} beta_i . h^(n-i)
alpha_i(h) = beta_i . h^(n-i) / D(h)        (fraction present with i protons removed, i = 0..n)
```

`Z_acid(h) = sum_{i=0}^{n} i . alpha_i(h)` is the mean number of protons the system has lost at a
given `h` (the "bound proton deficiency function" of systematic equilibrium treatments; see e.g.
Butler, *Ionic Equilibrium*). It ranges from `0` (`h -> infinity`, fully protonated) to `n` (`h ->
0`, fully deprotonated) and is **strictly monotonically decreasing in `h`** for any positive
`Ka_1..Ka_n`. A weak-base system uses the *same* function on its conjugate acid's stepwise
constants: `Z_base(h, Ka_steps) = n - Z_acid(h, Ka_steps)`, strictly **increasing** in `h`.
`services/science/tests/test_titration_equilibrium.py` checks monotonicity numerically for `n = 1,
2, 3` systems, not only asserts it; `test_titration_benchmarks.py` exercises a real triprotic
titration curve (phosphoric acid, Section 4).

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

### 1.3 Non-ideal activity: the Davies equation (`activity_model="davies"`)

The ideal model (`activity_model="ideal"`, the default) takes activity = concentration; `"davies"`
instead corrects every Ka and Kw for ionic strength using the **Davies equation**, an extended
Debye-Huckel expression that needs only each ion's integer charge (no ion-specific size parameter):

```
log10(gamma_z) = -A . z^2 . ( sqrt(I)/(1 + sqrt(I)) - 0.3 . I )          A = 0.509 at 25 degC
```

For one dissociation step `j` of an n-step system (the species losing proton `j` carries charge
`-j`), substituting Davies activity coefficients into `Ka_j,thermodynamic = a(H+).a(A^j-)/a(HA^(j-1)-)`
and simplifying (the `(j-1)^2`, `1^2` and `j^2` terms combine) gives the **apparent (concentration-
based) constant** actually used in the alpha/Z formulas:

```
log10(Ka_j,apparent / Ka_j,thermodynamic) = 2 . A . f(I) . j,     f(I) = sqrt(I)/(1+sqrt(I)) - 0.3I
```

i.e. **larger ionic strength makes a weak acid appear to dissociate more** — the well-documented
"salt effect", not an artefact of the derivation (`titration/activity.py` module docstring has the
full derivation). The same substitution for water (`H2O <=> H+ + OH-`, both ions singly charged)
gives `Kw_apparent = Kw_thermodynamic . 10^(2 A f(I))`. Because `I` depends on the equilibrium
concentrations, which depend on the apparent constants, which depend on `I`,
`activity.solve_with_activity_model` **iterates**: solve with the current apparent constants,
recompute `I`, rebuild the apparent constants, repeat until `I` stops changing (a fixed-point
iteration; converges within a handful of steps for the concentration ranges this package
validates). The Davies equation is commonly cited as usable to about `I = 0.5 mol/L`
(`activity.MAX_VALIDATED_IONIC_STRENGTH_MOLAR`); above that the result still returns, with a
warning that the correction is an increasingly uncertain extrapolation.

### 1.4 Temperature dependence of Ka/Kb (`ka_temperature.py`)

Separately from Kw(T) (Section 1.2), a weak system's own Ka/Kb can have a temperature model where
sourced ionization thermodynamics exist. Starting from `deltaG = RT ln(10) pK` and the standard
constant-heat-capacity expansion `deltaH(T) = deltaH(theta) + deltaCp(T-theta)`, `deltaS(T) =
deltaS(theta) + deltaCp ln(T/theta)` (`theta` = 298.15 K):

```
pK(T) = pK(theta) - [deltaH(theta)/(R ln10)] . (1/theta - 1/T)
                   - [deltaCp/(R ln10)]      . ( (theta/T - 1) + ln(T/theta) )
```

derived from first principles in `ka_temperature.py` (not copied from a possibly-misremembered
printed equation) and checked against three independently reported data points for acetic acid
(Section 2): using only `deltaH = -0.41 kJ/mol` and `deltaCp = -142 J/(mol K)` (Goldberg, Kishore &
Lennen, 2002), it reproduces their reported pKa(0 degC) = 4.781 and pKa(50 degC) = 4.788 to within
0.003 pKa units, with pKa(25 degC) = 4.756 exactly by construction (the reference point). Only
acetic acid carries this model in this session (`species.py`'s `ionization_thermodynamics` field);
every other weak system still uses the conservative generic band (Section 3).

### 1.5 Indicators

An indicator is itself a weak acid/base pair, `HIn <=> In- + H+`, with its own `pKin`:

```
fraction_basic_form(pH) = 1 / (1 + 10^(pKin - pH))
```

identical in form to `Z_acid` for `n=1`. A colour is rendered by linearly interpolating the
acid-form and base-form colours in that fraction (`titration/indicators.py::indicator_color`); this
is a simplified display model, not a measured absorption spectrum, so **colours are labelled
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
| Davies equation constant A | `0.509` at 25 degC | Standard literature value for the Davies equation in water |
| Acetic acid, Ka (pKa) | `1.75e-5` (`4.756`) | Goldberg, R. N.; Kishore, N.; Lennen, R. M. "Thermodynamic Quantities for the Ionization Reactions of Buffers." *J. Phys. Chem. Ref. Data* **2002**, *31*, 231-370 (NIST) |
| Acetic acid ionization thermodynamics | `deltaH = -0.41 kJ/mol`, `deltaCp = -142 J/(mol K)` | Same source; enables the Ka(T) model of Section 1.4, validated 273.15-323.15 K |
| Ammonium ion (NH4+), Ka (pKa) | `5.62e-10` (`9.25`) | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. (2004) |
| Formic acid, pKa | `3.75` | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. |
| Benzoic acid, pKa | `4.20` | NIST Chemistry WebBook / CRC Handbook of Chemistry and Physics, 84th ed. |
| Sulfuric acid, pKa1/pKa2 | `-3.0` (representative modelling value, not an independent citation — see note below) / `1.99` (`Ka2 = 1.0e-2`) | CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook (pKa2 only) |
| Phosphoric acid, pKa1/pKa2/pKa3 | `2.15` / `7.21` / `12.32` | CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook |
| Carbonic acid, pKa1 (apparent)/pKa2 | `6.35` / `10.33` | CRC Handbook of Chemistry and Physics (apparent pKa1 lumps dissolved CO2(aq) with true H2CO3, the universal practical convention) |
| Oxalic acid, pKa1/pKa2 | `1.25` / `3.81` | CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook |
| Phenolphthalein, methyl orange, bromothymol blue: pKin and visual transition ranges | `9.4` (8.3-10.0); `3.7` (3.1-4.4); `7.1` (6.0-7.6) | The Engineering ToolBox; Wired Chemist acid-base indicator tables |
| Molar gas constant R | `8.31446261815324 J/(mol K)` | Exact, 2019 SI redefinition; same value as `packages/core/src/constants.ts` |

Every value above was checked against a live source during this session (web search citations in
the implementation commit), not recalled from training data and left unverified. `titration/species.py`
and `titration/indicators.py` carry the same citations as machine-readable `Provenance` records
returned with every API response (`GET /v1/titration/species`, `GET /v1/titration/indicators`).

Strong acids (HCl, HNO3, HBr) and strong bases (NaOH, KOH) carry no Ka/Kb: they are modelled as
completely dissociated, which is itself the (textbook-level) claim being made, not a separate
numerical value requiring a citation. **Sulfuric acid's pKa1 is different**: the literature
describes the first dissociation only as "essentially complete" without a precise measured value,
so `-3.0` here is this package's own representative modelling choice (checked numerically to keep
undissociated H2SO4 below 1% across the whole pH range 0-14), not an independent citation; its
`Provenance.evidence` is `MODEL_CALCULATED`, not `REFERENCE_MEASURED`, to reflect that honestly.

## 3. Scope, validation and tolerances

### Supported systems
Strong or weak, monoprotic or polyprotic acids and bases (sulfuric, phosphoric, carbonic and
oxalic acid; calcium and barium hydroxide as diacidic strong bases); any number of distinct
weak-acid and weak-base systems together (e.g. two weak acids, or a weak acid and a weak base);
water autoionization and dilution; buffers prepared either by partial titration or by direct
dosing of a weak acid/base together with its conjugate salt (sodium acetate, ammonium chloride);
simple supporting electrolytes (NaCl, KNO3) for ionic-strength tracking; an ideal or a
Davies-equation non-ideal activity model; a sourced Ka(T) model for acetic acid, the generic
+/-10 K band for every other weak system.

### Explicitly out of scope (checked, not merely undocumented)
- **Boric acid** (and any other Lewis acid that raises pH by accepting OH- rather than donating a
  proton of its own) is pre-registered in `species.py` with that specific reason, so a request for
  it answers `UNSUPPORTED` with that reason, not a generic "unknown species" message and never a
  plausible-looking pH. This is a chemical-mechanism exclusion, not a scope-size one: no amount of
  additional Ka steps would make the n-step Bronsted model describe it correctly.
- **Non-ideal activity beyond Davies**: only `activity_model="ideal"` or `"davies"` are implemented;
  any other value is `UNSUPPORTED`. Ionic strength `I = 0.5 * sum(C_i z_i^2)` (correctly weighted by
  the square of each ion's *actual* integer charge, including the multivalent ions a polyprotic
  system produces) is computed and returned as a diagnostic on every successful solve. Under the
  ideal model, a warning above `0.1 mol/L` (roughly the edge of where the Debye-Huckel limiting law
  is still a reasonable guide) says the ideal-activity assumption is increasingly approximate
  there; under Davies, the equivalent warning is above `0.5 mol/L` (`activity.MAX_VALIDATED_IONIC_STRENGTH_MOLAR`).
- **Temperature**: `273.15 K` to `373.15 K` for the aqueous/Kw model. For a weak system with no
  sourced Ka(T) model (every weak-acid/weak-base species except acetic acid), a tighter `288.15 K`
  to `308.15 K` band, because Ka/Kb is otherwise held constant rather than silently extrapolated.
  Acetic acid's own Ka(T) model (Section 1.4) widens its band to `273.15 K` to `323.15 K`.
- **Concentration**: `0` to `18 mol/L` per named concentration (strong acid, strong base, each weak
  system, each spectator pool); above that the ideal-dilute-solution model is not considered valid
  and the result is `UNSUPPORTED`.

### FAILED vs. UNSUPPORTED
`FAILED` means the request is physically malformed (negative or non-finite volume/moles, a volume
outside `1e-9 L` to `1000 L`) or, in principle, that the root finder itself did not converge for a
validated input (not observed in testing: see Section 4). `UNSUPPORTED` means the request is
well-formed but names chemistry or conditions outside the validated scope above. Both carry a
human-readable `reason` and structured `diagnostics`; neither carries a `pH`.

### Tolerances
- Root finder: `scipy.optimize.brentq` with `xtol=1e-13`, `rtol≈8.88e-16` on pH, `maxiter=200`
  (typically needs 12-20). The charge-balance residual at the reported root is itself returned as
  `diagnostics.charge_balance_residual_molar` and is below `1e-8 mol/L` on every benchmark and test
  case (see Section 4); mass-balance residuals per weak system (`sum(alpha_i) . C_total - C_total`,
  etc.) are reported the same way and are equally small.
- The Davies activity model adds an outer self-consistent iteration on ionic strength
  (`diagnostics.activity_model_iterations`, `None` under the ideal model, typically 3-8 under
  Davies), converged to `1e-10 mol/L` on ionic strength itself.
- `numerical_uncertainty.ph_numerical_tolerance = 1e-9` is the root finder's own convergence
  tolerance, **not** a propagated measurement uncertainty from the Ka/Kw source data — the package
  does not have those uncertainties in a form it can honestly propagate, and says so in
  `numerical_uncertainty.limitations` rather than inventing an error bar.

## 4. Benchmark results (from the brief's "Benchmarks and tests", plus v2 extensions)

All of the following are automated tests (`services/science/tests/test_titration_*.py`, run with
real numerics, not asserted by inspection) and/or committed fixtures (`titration/fixtures/*.json`,
generated by `titration/fixtures/generate_fixtures.py` from the live solver, with a regression test
— `test_titration_fixtures.py` — that fails if the committed files and the live solver ever
disagree).

| Benchmark (brief wording) | Result |
|---|---|
| 25.00 mL of 0.100 M HCl titrated by 0.100 M NaOH: equivalence at 25.00 mL, pH approx 7 at 25 degC | Equivalence volume `0.025000000000000005 L` (25.0000 mL); pH at equivalence `7.000000000002128` |
| Before/after equivalence: chemically sensible monotonic trend, not hardcoded | pH strictly increases across 15 independently solved points from 0 to 50 mL delivered; cross-checked against the classical pre-/post-equivalence closed-form approximations (`pH = -log10(excess/volume)`) to within 0.01 pH units away from equivalence, where that approximation is valid |
| Equal-concentration acetic acid/NaOH: pH approx pKa at half-equivalence, pH > 7 at equivalence | pH at half-equivalence (12.500 mL) = `4.756456525381417` vs. pKa `4.756`; pH at equivalence = `8.727537982749062` (basic, as expected for a salt of a weak acid and a strong base) |
| Mass balance, charge balance residuals, unit conversions, behaviour near sharp gradients | Charge-balance residual `≈1e-15` to `0` at every tested point; mass-balance residual for the weak system `≈1e-15` to `0`; a 1 mL vs. 1000 mL-scaled description of the same system gives bit-identical pH; the solver converges cleanly 1 microlitre either side of the strong-acid/strong-base equivalence point, where pH changes by more than 2 units |
| Weak base/strong acid (ammonia/HCl) | pH at half-equivalence `≈ pKa(NH4+) = 9.25`; pH at equivalence `< 7` (acidic, ammonium chloride solution) |
| Out-of-range conditions propagate correctly | Boric acid (Lewis-acid exclusion), five out-of-range temperatures, excessive concentration, an unresolvable species id, a malformed model id, negative moles and negative/zero/non-finite volume each produce the expected `UNSUPPORTED`/`FAILED` status with a reason naming the actual problem |

### v2 extensions (polyprotic, mixtures, activity, Ka(T))

| Case | Result |
|---|---|
| 0.100 M phosphoric acid (triprotic), dilute solution | pH ≈ 1.63; undissociated H3PO4 is the single largest species (≈77%), *not* H2PO4- — the textbook fact that Ka1 = 6.9e-3 is not large enough, relative to 0.1 M, for "complete" first-step behaviour, reproduced rather than assumed |
| 25.00 mL 0.100 M phosphoric acid titrated by 0.100 M NaOH | Three buffer regions: pH ≈ pKa1 (2.15) at 0.5 equivalents (within 0.2, the textbook approximation's known weak point for this step), pH ≈ pKa2 (7.21) at 1.5 equivalents (within 0.05), pH approaching pKa3 (12.32) at 2.5 equivalents (within 0.6, water autoionization interferes near the practical pH ceiling); strictly monotonic throughout |
| 0.05 M sulfuric acid vs. an equivalent monoprotic strong acid | More acidic than pH 1.30 (what 0.05 M HCl would give) but less acidic than pH 1.00 (what a *fully* dissociated diprotic strong acid would give) — because the second dissociation (Ka2 = 1.0e-2) is real but incomplete |
| Calcium/barium hydroxide (diacidic strong bases) | pH identical (to 1e-6) to an NaOH solution with twice the formal concentration — confirms two OH- released per mole |
| Two distinct weak acids together (acetic + formic, 0.1 M each) | pH bounded between 0.2 M formic acid alone (more acidic) and 0.2 M acetic acid alone (less acidic) — the correct comparison is against solutions of the *same total acid concentration*, not the individual 0.1 M components |
| Weak acid + weak base together (acetic acid + ammonia, equal moles) | pH = 7.00 +/- 0.05 — reproduces the textbook fact that ammonium acetate solution is almost exactly neutral, because Ka(acetic acid) and Kb(ammonia) are nearly equal; this combination was `UNSUPPORTED` before this session |
| Davies activity model vs. ideal, 0.1 M acetic acid | pH lower under Davies (the salt effect: higher *apparent* Ka at nonzero ionic strength), converging in a handful of outer iterations, self-consistent (`ionic_strength(root, apparent_totals) == diagnostics.ionic_strength_molar`) |
| Acetic acid Ka(T) model vs. the generic +/-10 K band | Solves successfully from 0 degC to 50 degC (wider than the generic 15-35 degC band every other weak system is restricted to); pH(T) shows the same shallow minimum near 25 degC that the underlying pKa(T) curve has |

## 5. API surface for Agent 07/09/10

### Local Python function (no service needed)
```python
from titration.solver import solve_equilibrium
from titration.types import SpeciesAmountInput

result = solve_equilibrium(
    species=[SpeciesAmountInput("hydrochloric-acid", 0.0025), SpeciesAmountInput("sodium-hydroxide", 0.0025)],
    volume_l=0.05,       # litres
    temperature_k=298.15,
    assumptions={"activity_model": "davies"},   # or omit for "ideal" (the default)
)
result.status          # "SUCCEEDED" | "UNSUPPORTED" | "FAILED"
result.pH               # float | None
result.evidence         # "REFERENCE_MEASURED" | "MODEL_CALCULATED" | "ILLUSTRATIVE" | "UNVERIFIED" | "UNSUPPORTED"
result.diagnostics      # residuals, ionic strength, root-finder iterations/bracket, activity-model iterations, input hash
```
Pure and deterministic: identical inputs always produce an identical `SolveResult` (same `pH`,
same `diagnostics.input_hash`), with no I/O. Any number of species may be passed at once, including
polyprotic acids/bases and multiple distinct weak systems together (Section 3).

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
`polyprotic_phosphoric_acid_naoh.json`, `unsupported_and_failed_cases.json`,
`activity_model_cases.json`, `indicators.json`, `species_registry.json`. A consumer in another
language only needs to reproduce each case's `input` through its own channel (e.g. an HTTP call)
and compare the `expected` fields within `tolerance_pH`.

## 6. Known limitations (for the orchestrator and for Agent 07/09/10)

- Evidence vocabulary: this package uses the **shared contract's** uppercase enum
  (`REFERENCE_MEASURED`/`MODEL_CALCULATED`/`ILLUSTRATIVE`/`UNVERIFIED`/`UNSUPPORTED`,
  `00_SHARED_INTEGRATION_CONTRACT.md` Section 3), which is a different vocabulary from the existing
  v1 app's lowercase one (`matterlab_science.provenance.EvidenceLevel`:
  `reference`/`computed`/`rule-based`/`illustrative`/`user-input`/`unsupported`, documented in
  `docs/architecture.md`). `titration/provenance.py` documents an explicit mapping
  (`evidence_to_legacy`/`evidence_from_legacy`) but the two vocabularies are not unified anywhere
  else in the service; flagged for Agent 10 to reconcile before the Astra expansion ships.
- Boric acid (a Lewis acid) remains the one deliberate chemical-mechanism exclusion; every other
  species-level "unsupported" case from the original v1 brief (polyprotic acids/bases, mixtures of
  distinct weak systems) has been lifted in this session. Other Lewis acids, metal-ion hydrolysis,
  and solubility/precipitation equilibria (e.g. a true Ksp-limited treatment of calcium hydroxide,
  rather than this package's "assume full dissolution" simplification) remain out of scope.
- The Davies equation's own temperature dependence (its `A` constant) is not modelled; `A = 0.509`
  (the 25 degC value) is used at every solve temperature. A more complete treatment would vary `A`
  with `T` via water's dielectric constant and density.
- Only acetic acid has a sourced Ka(T) model (`ka_temperature.py`); every other weak-acid/weak-base
  species still uses the generic +/-10 K band. Extending this to more species needs sourced
  ionization enthalpy/heat-capacity data for each one, which this session did not gather beyond
  acetic acid.
- This package has not been exercised against the full Docker/PostgreSQL stack in this session (see
  the Agent 06 status report in the session history for why, and what was verified instead: the
  real `matterlab_science.main.create_app()` factory, `TestClient`-driven HTTP contract tests, and
  OpenAPI schema generation, all without a database, since this router needs none).

## 7. Running the tests

From `services/science/` (no Docker, no PostgreSQL needed for any of the files below — they are
plain `pytest`, matching this package's design goal of being testable as a pure library):

```powershell
pip install pytest fastapi httpx "psycopg[binary]"   # once, if not already present
python -m pytest tests/test_titration_equilibrium.py tests/test_titration_benchmarks.py tests/test_titration_indicators.py tests/test_titration_api.py tests/test_titration_activity.py tests/test_titration_ka_temperature.py tests/test_titration_fixtures.py -v
```

To regenerate the committed fixtures after a deliberate, reviewed change to the solver:

```powershell
python -m titration.fixtures.generate_fixtures
```
