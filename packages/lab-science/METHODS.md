# Scientific methods and validation — version 1.0.0

**Executed implementation:** `aqueous-acid-base-ideal-v1`, pure TypeScript, one common engine for Node and browser-worker builds. All numerical observations are `MODEL_CALCULATED`, not measured. This report accompanies the actual machine-readable `validation-results.json`; it does not claim independent experimental calibration.

## 1. Governing equations and component semantics

Let `h = [H3O+]`, `o = [OH−]`, and each concentration be in mol/L. Water is implicit solvent; its hydrogen and oxygen are not treated as a conserved solute inventory.

```text
o = Kw / h

C_A = [CH3COOH] + [CH3COO−]
[CH3COOH] = C_A h / (Ka_A + h)
[CH3COO−] = C_A Ka_A / (Ka_A + h)

C_B = [NH3] + [NH4+]
[NH4+] = C_B h / (Ka_B + h)
[NH3]  = C_B Ka_B / (Ka_B + h)
Ka_B = Kw / Kb_NH3

F(h) = h − Kw/h + C_Na − C_Cl − [CH3COO−] + [NH4+] = 0
pH = −log10(h / (1 mol/L))
I = 1/2 Σ c_i z_i²
```

Here `Ka_B` is the **acid** constant of ammonium, not ammonia's base constant. One weak family is admitted at a time; writing both terms explains the equation, not permission to run mixed weak-family chemistry.

`C_A`, `C_B`, `C_Na`, and `C_Cl` come from conserved analytical moles divided by actual total volume. Reagent preparation is the only recipe authority. HCl means an analytical reagent giving chloride inventory, not stable intact HCl in solution; NaOH gives sodium inventory. Hydronium/hydroxide and individual weak-family species are equilibrium outputs, never transferred inventories.

Concentration-form constants are used with ideal activity coefficients equal to one and standard concentration 1 mol/L. Thermodynamic equilibrium constants themselves are dimensionless; the concentration-form equation is the stated ideal approximation.

## 2. Constants, references and licensing

| Adopted parameter | Value | Reference / verification |
|---|---:|---|
| Water concentration ion product at 298.15 K | `1.0e−14 (mol/L)²` | OpenStax Chemistry 2e §14.2, directly retrieved |
| Acetic acid concentration-form Ka | `1.8e−5 mol/L` | OpenStax Chemistry 2e §14.3, directly retrieved |
| Ammonia concentration-form Kb | `1.8e−5 mol/L` | OpenStax Chemistry 2e §14.3, directly retrieved |
| Ammonium concentration-form Ka | `Kw / Kb` | Derived without separately rounding a conjugate constant |
| Phenolphthalein effective pKa | `9.5` | LibreTexts page 24301, Figure 3 discussion, directly retrieved |
| Methyl orange effective Ka | `4.0e−4`, pKa `3.3979400086720375` | OpenStax §14.7, directly retrieved |
| Bromothymol blue effective pKa | `7.2` | Harvard demonstration's indexed numerical excerpt; direct host retrieval returned HTTP 403 |

References, authors, source IDs, page/edition versions, access dates, URLs and license notices are in `src\sources.ts` and generated `dist\source-references.json`.

- OpenStax's **current** preface says CC BY-NC-SA 4.0. An older permissive-license assumption was not substituted for the verified current notice.
- LibreTexts page 24301 has a CC BY-NC-SA 4.0 page notice and separately attributes an underlying OpenStax contribution. Only small numerical facts and citation metadata are retained.
- Harvard's content license was not verified. No prose/artwork is redistributed; the one numerical value and transition boundaries are cited. This is an educational effective dye constant, **not a verified 298.15 K thermodynamic calibration**.
- No handbook, image, table, PubChem dataset or restricted source was bulk copied. Solver, explanations and display color anchors are original.

The bulk equilibrium constants are adopted textbook reference values at the model's reference conditions, not claimed to carry measured standard uncertainties. Indicator constants and colors have a deliberately weaker, effective-display interpretation.

## 3. Numerical method and diagnostics

For nonnegative family totals,

```text
dF/dh = 1 + Kw/h²
        + C_A Ka_A/(Ka_A+h)²
        + C_B Ka_B/(Ka_B+h)² > 0.
```

The residual is therefore strictly decreasing as pH increases, with a unique root. A bracket `−2 ≤ pH ≤ 16` encloses every admitted concentration-domain solution. Deterministic bisection uses at most 96 iterations and a pH bracket width tolerance of `1e−12`.

The implementation aggregates duplicate component amounts with stable summation. Close to complete neutralization, it uses the minority weak-family form and conserved-mole charge offset instead of subtracting large nearly equal equilibrium concentrations. It validates both this stabilized residual and a separately reconstructed charge residual from returned equilibrium species.

Acceptance checks:

- `|chargeResidualMolL| ≤ 1e−12`;
- `|reconstructedChargeResidualMolL| ≤ 1e−12`;
- maximum analytical-family mass residual `≤ 1e−12 mol/L`;
- bounded finite root and valid computed ionic strength.

Results also report iterations/evaluations, numerical pH bracket, water-product residual, family residuals, analytical concentrations, pOH, neutral pH, volume, temperature and activity model. Invalid/unsupported requests do not expose a successful pH or species result; out-of-domain ionic strength retains only eligibility diagnostics, not a rejected root disguised as an observation.

These numerical tolerances are **not** physical pH uncertainty.

## 4. Executed scientific results

The committed 14-snapshot fixture produced **11 supported numerical results and 3 explicit unsupported results**. Representative values from the generated report:

| Case | Actual calculated pH | Check |
|---|---:|---|
| Closed pure water, 298.15 K | 6.999999999999744 | 7 within `1e−8` |
| 25 mL 0.100 M HCl | 0.999999999999574 | 1 within `1e−8` |
| +12.5 mL 0.100 M NaOH | 1.477121254715513 | independent excess-acid check |
| +25 mL 0.100 M NaOH | 6.999999999999744 | required 50 mL equivalence |
| +37.5 mL 0.100 M NaOH | 12.301029995674668 | independent excess-base check |
| HCl diluted twofold | 1.301029995662333 | conserved amount, doubled volume |
| Initial 0.100 M acetic acid | 2.875277060319178 | full equilibrium, not square-root shortcut |
| Acetic acid half-equivalence | 4.745196012763955 | within 0.001 of pKa 4.7447274949 |
| Acetic acid equivalence | 8.721904031581886 | near textbook 8.72, correctly basic |
| Ammonia half-equivalence | 9.254803987236045 | within 0.001 of conjugate pKa 9.2552725051 |
| Ammonia equivalence | 5.278095968418114 | near 5.28, correctly acidic |

The small half-equivalence departure from `pH = pKa` is intentional: the full charge balance includes water and weak-family dissociation instead of assuming the final equilibrium acid/base concentrations are exactly equal.

Largest stabilized charge residual in these snapshots: **less than `1.85e−14 mol/L`**. Largest analytical-family mass residual: **less than `4.10e−18 mol/L`**. Phosphate, mixed acetate/ammonia, and 310.15 K returned `UNSUPPORTED` with no pH.

### Endpoint is not equivalence

For 25 mL 0.100 M HCl / 0.100 M NaOH, explicitly selecting **50% base-form fraction** gives:

| Indicator | Target pH | Estimated endpoint (mL) | Offset from 25 mL equivalence (mL) |
|---|---:|---:|---:|
| Phenolphthalein | 9.5 | 25.015816231689 | +0.015816231689 |
| Methyl orange | 3.397940008672 | 24.800796825139 | −0.199203174861 |
| Bromothymol blue | 7.2 | 25.000047696858 | +0.000047696858 |

Each crossing volume is obtained by evaluating actual hypothetical analytical mixtures with the same solver, not interpolation in a stored curve. These are model thresholds, not observed persistent endpoints or recommendations about an optimal indicator.

## 5. Tests and bounded timing

**91 automated tests passed** across the final 83-test numerical/model/reference run and the focused 8-test transport rerun. The transport harness initially hit 5/10-second process-start deadlines on the shared host; its child processes remain bounded at 45 seconds, with a 60-second test deadline. Unnecessary catalogue-generator process startup was removed. These are test-harness allowances, not solver latency or production job-budget changes.

The four package-local test files cover:

- an independent stable strong-electrolyte quadratic before/after and very near sharp equivalence;
- dilution and `1e−9 M` water-autoionization behavior;
- weak acid/base half-equivalence, hydrolysis, prepared conjugate buffers and dilution;
- independent mass/charge/Kw/Ka reconstruction from returned species;
- physical units, nonfinite/negative/overflow/underflow inputs, mixing and unsupported identities/mixtures/models;
- trace indicator fractions, illustrative color range and explicit unmodeled phenolphthalein fading;
- endpoint/equivalence distinction and an independently derived strong-pair crossing volume;
- deterministic frozen replay, byte-identical Node CLI/library results, generated catalogue parity;
- actual browser-target bundle execution in a JS context without Node globals;
- frozen shared-contract JSON-schema validation of successful/unsupported results and preparations.

Strict TypeScript checking passes against the canonical shared contracts. Worker validation is **not** a full graphical-browser/E2E test; it proves the browser-target bundle and message adapter execute without Node APIs. Full app integration and visual/performance checks belong to Agent 10.

The generated report includes one deliberately small warm timing check: 16 warm-ups, 64 serial weak-buffer solves, Node v24.14.1, Windows x64, Intel Core Ultra 7 165H. Recorded median **0.0550 ms**, p95 **0.2442 ms**, maximum **0.9212 ms**. This shared-host observation is not a performance guarantee or a 60 FPS claim.

## 6. Scientific limits and integration boundary

Only the explicitly admitted reference temperature, concentrations, ionic strengths and analytical families are validated. Activity corrections, uncertain reagent concentrations, CO2 exposure, gas loss, finite indicator loading, full dye protonation/fading, temperature-dependent constants, fluid kinetics and thermal effects are absent.

The model has no validated physical uncertainty, even though its numerical residuals are small. At nominal 0.1 M, ideal-concentration pH may differ materially from activity/electrode measurements; that warning is carried with results.

`prepareSolution` proposes contents; the runtime owns accepted inventory changes, volume conservation, source attribution, simulation time and observation ledger. `getTitrationReference` requires caller-supplied cumulative accepted delivered volume. The canonical backend replay CLI imports this solver; no Python numerical duplicate, database edit or API server is part of this package.
