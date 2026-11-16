# @matterlab/reactions

Reaction stoichiometry, reference-data thermodynamics and rate-law kinetics for the MATTER LAB Reaction
Laboratory. Dependency-free TypeScript; `src/` runs in the browser.

Three rules shape everything in this package:

1. **It never claims that substances react.** Every function works on an equation or a kinetic model that
   the caller supplies. Balancing an equation, or finding that its Gibbs energy is negative, is not evidence
   that the reaction happens, and the results say so.
2. **It never invents numbers.** Every reference value was read by a script from a saved copy of a cited
   source fetched for this package. Where a source has no value, the species or reaction is left out.
3. **Every result is labelled by how it was obtained** (`evidence`, `provenance`), and anything outside what
   a model was validated for comes back with an explicit status and warnings.

## Contents

- [Quick start](#quick-start)
- [What is supported](#what-is-supported)
- [What is not supported](#what-is-not-supported)
- [Data sources, citations and terms](#data-sources-citations-and-terms)
- [Approximations and their limits](#approximations-and-their-limits)
- [Evidence labels and statuses](#evidence-labels-and-statuses)
- [Public API](#public-api)
- [Regenerating the data](#regenerating-the-data)
- [Tests](#tests)
- [Open points for the project](#open-points-for-the-project)

## Quick start

```ts
import {
  KINETIC_MODELS, balanceEquation, formatEquation, molarMass, parseFormula,
  reactionThermodynamics, rateConstant, simulateKinetics,
} from '@matterlab/reactions';

parseFormula('CuSO4·5H2O');             // { elements: { Cu: 1, S: 1, O: 9, H: 10 }, charge: 0 }
molarMass('Ca3(PO4)2');                  // g/mol, from the atomic weights in @matterlab/core

const balanced = balanceEquation('MnO4- + Fe^2+ + H+ -> Mn^2+ + Fe^3+ + H2O');
balanced.status;                         // 'balanced'
formatEquation(balanced.equation!);      // 'MnO4- + 5 Fe^2+ + 8 H+ -> Mn^2+ + 5 Fe^3+ + 4 H2O'

const thermo = reactionThermodynamics('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
thermo.status;                           // 'ok'
thermo.deltaH;                           // { value, unit: 'kJ/mol', evidence: 'computed', provenance }
thermo.warnings;                         // e.g. values from two reference tables were combined

const model = KINETIC_MODELS.find((m) => m.id === 'no-o3')!;      // NO + O3 -> NO2 + O2
rateConstant(model, 298);                // { k, withinValidatedRange: true, log10Uncertainty, warnings }
const run = simulateKinetics({
  model, temperatureK: 298,
  initialConcentrations: { NO: 1e12, O3: 3e12 },                  // molecule cm-3, the unit of the source
  durationSeconds: 300,
});
run.status;                              // 'ok'
run.concentrations.NO2;                  // Float64Array, one value per entry of run.times
```

## What is supported

### Stoichiometry

- `parseFormula`: element symbols (case-sensitive, all 118), counts, nested `()`, `[]` and `{}`, hydrates and
  adducts with `.`, `*` or a middle dot (`CuSO4.5H2O`, `CuSO4·5H2O`), charges (`NH4+`, `SO4^2-`, `Fe^3+`,
  `SO4-2`, `Ca++`, Unicode superscripts), Unicode subscripts, and the electron `e-`.
- `molarMass`: from the standard atomic weights in `@matterlab/core`. For ions the mass of the electrons
  removed or added is included, so a half-reaction with `e-` conserves mass.
- `parseEquation` / `formatEquation`: coefficients as integers, decimals or fractions; phase labels `(g)`,
  `(l)`, `(s)`, `(aq)` (`(cr)` is read as solid); arrows `->`, `=>`, `=`, `→`, `⟶`, `⇒` and, for
  equilibria, `<=>`, `<->`, `⇌`, `⇄`, `⇋`, `↔`.
- `checkConservation`: products minus reactants for every element, and for the charge.
- `balanceEquation`: the exact rational null space of the composition matrix (one row per element plus one
  for the charge), scaled to the smallest positive whole numbers. No floating point is involved in
  deciding a coefficient. Four outcomes:
  - `balanced` – a unique solution was found;
  - `already-balanced` – the input conserves everything as written and is returned unchanged;
  - `impossible` – no positive coefficients exist (the message says which species is the obstacle);
  - `underdetermined` – conservation leaves two or more independent solutions (typically two reactions
    written as one, or a species on both sides); the package does not pick one. Whether a positive solution
    exists at all is decided exactly, by a rational phase-one simplex.

### Thermodynamics

- `THERMO_SPECIES`: **175 species** at 298.15 K – 76 gases, 6 liquids, 57 solids, 36 aqueous species (33 ions
  and 3 undissociated solutes). 172 have both an enthalpy of formation and an entropy; three (ethane,
  propane and gaseous benzene) have only the enthalpy.
- `reactionThermodynamics(equation, T = 298.15)`: reaction enthalpy and entropy at 298.15 K by Hess's law,
  Gibbs energy and equilibrium constant at `T`, propagated uncertainty where the sources state one, the
  list of assumptions, and warnings.
- Enough for the usual textbook examples: combustion of H2, C, CO, CH4, C2H4, C2H2, methanol, ethanol and
  benzene; formation reactions; gas equilibria (NH3 synthesis, N2O4/NO2, SO2/SO3, H2/I2/HI, water-gas shift);
  neutralisation; dissolution of NaCl, KCl, CaCl2, NH4Cl, NaOH, AgCl, PbSO4, CuSO4 and CO2; precipitation;
  displacement reactions between Li, Na, K, Rb, Cs, Mg, Ca, Al, Zn, Cd, Sn, Pb, Cu, Ag, Hg, H2 and the
  halogens and their aqueous ions.

### Kinetics

- `KINETIC_MODELS`: **8 gas-phase reactions** with evaluated Arrhenius parameters, each with its validated
  temperature range:

  | id | reaction | rate law | range / K |
  | --- | --- | --- | --- |
  | `no-o3` | NO + O3 → NO2 + O2 | k [NO][O3] | 195–308 |
  | `no2-o3` | NO2 + O3 → NO3 + O2 | k [NO2][O3] | 230–360 |
  | `o-o3` | O + O3 → 2 O2 | k [O][O3] | 200–400 |
  | `oh-h2` | OH + H2 → H2O + H | k [OH][H2] | 200–450 |
  | `no-no3` | NO + NO3 → 2 NO2 | k [NO][NO3] | 220–420 |
  | `no-o2-termolecular` | 2 NO + O2 → 2 NO2 | k [NO]²[O2] | 270–600 |
  | `acetylperoxy-self` | 2 CH3C(O)O2 → 2 CH3C(O)O + O2 | k [CH3C(O)O2]² | 200–370 |
  | `mpan-decomposition` | CH2=C(CH3)C(O)OONO2 → CH2=C(CH3)C(O)OO + NO2 | k [MPAN], at 1 bar | 290–330 |

  (The table is for orientation; the authoritative numbers are in `KINETIC_MODELS`, which are generated
  from the source excerpts.) The set covers first-, second- and third-order rate laws.
- `rateConstant(model, T)`: k = A exp(−Ea/RT) with the validated-range flag and, inside the range, the
  uncertainty of log10 k that the source's reliability figures imply.
- `simulateKinetics`: concentration–time curves by numerical integration with error control, the rate at
  each output time, and the half-life of the limiting reactant.
- `integrateOde`: the Dormand–Prince 5(4) integrator used for this, with adaptive step size and dense
  output, exported for reuse.
- `toMolarUnits(model)`: the same model with concentrations in mol/L (exact conversion with N_A).
- `findKineticModels(equation)`: the sourced model for an equation, if there is one. It never substitutes a
  similar reaction.

### Catalogue

- `SUPPORTED_REACTION_CLASSES`: eleven classes with examples, three capability flags and their limits. A
  flag is `true` only if it holds for every example of the class; the test suite checks that.
- `UNSUPPORTED_FEATURES`: what the package deliberately does not do, as data, for the UI to display.
- `reactionSupport(equation)`: for one specific equation, whether it is balanced, whether the table covers
  it, and whether a sourced rate law exists.

### The experiment pipeline

`runExperiment(input, options?)` is what the Reaction Laboratory of the application runs: one synchronous,
deterministic function that takes the species and conditions a user entered and returns everything an
interface has to show. It is meant to be called in a Web Worker.

```ts
import { runExperiment, serializeExperimentResult, parseExperimentResult } from '@matterlab/reactions';

const result = runExperiment({
  title: 'Nitric oxide and ozone',
  species: [
    { formula: 'NO', phase: 'g', role: 'reactant', initialConcentration: 5e11 },
    { formula: 'O3', phase: 'g', role: 'reactant', initialConcentration: 1e12 },
    { formula: 'NO2', phase: 'g', role: 'product' },
    { formula: 'O2', phase: 'g', role: 'product' },
  ],
  conditions: { temperatureK: 298, pressureBar: 1, durationSeconds: 300, environment: 'gas-phase', concentrationUnit: 'molecule/cm3' },
  method: 'auto',                        // or 'stoichiometry' | 'thermodynamics' | 'kinetics'
});
result.status;                           // 'completed' | 'partial' | 'unsupported' | 'invalid' | 'cancelled'
result.steps;                            // always seven, in order (see below)
result.equation?.text;                   // 'NO(g) + O3(g) -> NO2(g) + O2(g)'
result.thermo, result.rateConstant, result.kinetics, result.energyDiagrams;
result.explanation.beginner;             // sections for the explanation panel; also .advanced and .references
result.warnings, result.limitations;
const text = serializeExperimentResult(result);     // JSON; typed arrays become number arrays
parseExperimentResult(text);                        // validates, restores typed arrays, checks the input hash
```

- **The species are given, the coefficients are found.** The equation is built from the species whose role
  is `reactant` or `product` and balanced. Coefficients can instead be entered for every reactant and
  product (`coefficient`), which is how an equation that conservation alone leaves open is fixed.
- **Seven steps, always reported**: `validate-species`, `conservation`, `model-selection`,
  `reference-data`, `engine`, `calculation`, `limitations`. Each has a status (`passed`, `warning`,
  `failed`, `skipped`), a one-sentence summary and details. A step that was not reached says why
  ("Not run: ...").
- **Nothing is guessed.** No products given: status `unsupported`, nothing balanced or calculated, and a
  pointer to `suggestReactions`. An equation that cannot be balanced, or not uniquely: `unsupported`, with
  the balancer's explanation in `balance`. A species missing from the reference table: the equation is still
  reported, the species is named, no value is estimated (`partial`). Kinetics requested where no sourced
  rate law exists: `unsupported`; the rate law of a similar reaction is never substituted. Kinetics without
  the concentrations its rate law needs: `invalid` when kinetics was asked for by name, `partial` under
  `auto`. Input that cannot be run at all (unreadable formula, no reactant, non-physical conditions, a
  species listed twice): `invalid`.
- **What is not modelled is said**, in `limitations`: catalysts and solvents are recorded but change
  nothing; a pressure other than 1 bar is recorded but does not enter (standard-state values); the MPAN
  rate expression is refused away from 1 bar; species that do not fit the chosen environment produce an
  "Environment mismatch" warning; temperatures outside the validated ranges downgrade the evidence label
  to `rule-based`. The key phrases are exported as `LIMITATION_PHRASES` so that tests and interfaces can
  rely on them.
- **Energy diagrams** (`energyDiagrams`): reactants at 0 and products at the reaction enthalpy (and at the
  Gibbs energy in a second diagram when one was computed). A `barrier` level appears only when a sourced
  kinetic model was used and its Arrhenius activation energy is positive, and only together with a product
  level; it is the empirical activation energy of the rate expression, not a computed transition state, and
  its note says so. A negative activation energy (2 NO + O2) gives no barrier and a note. When nothing
  honest can be drawn the diagram has no levels and its notes say why.
- **Explanations** at two levels (`beginner`, `advanced`), each a list of sections with a heading,
  paragraphs, an optional plain-text equation and an evidence label. `references` holds only the sources
  the result actually used.
- **Progress and cancellation.** `onProgress(fraction, step)` is called with strictly increasing fractions
  from 0 to 1. `shouldCancel()` is asked before every step and after every accepted integration step;
  returning `true` ends the run with status `cancelled`, keeping what had been established and returning
  no half-finished curve.
- **Reproducibility.** The result carries a normalised copy of its input, the SHA-256 of the canonical JSON
  of that input (`inputHash`, independent of key order), the engine name and version, the retrieved copies
  of the sources behind its numbers with their hashes, and the solver settings. The function reads no clock
  and uses no random numbers: the same input gives an equal result, and the same serialised text.
  `parseExperimentResult` rejects text with another schema or version, damaged text, and a result whose
  input no longer matches its recorded hash.
- `suggestReactions(species)` lists the catalogued reactions (`REACTION_CATALOGUE`) whose reactants are
  all among the species given. Every entry's `note` states that this is a lookup of known reactions, not a
  prediction that the reaction takes place.
- `EXPERIMENT_PRESETS`: twelve representative experiments, among them three kinetic runs and two
  deliberate refusals (a species without reference data; reactants without products). Each records the
  status it is documented to produce, and the test suite runs all of them.

## What is not supported

- **Predicting reactions.** The package never decides whether substances react, what the products are, or
  under which conditions.
- **Mechanisms and networks.** One reaction at a time. No consecutive, competing or reversible kinetics, no
  chain reactions, steady states or oscillations. A simulated elementary step is not a model of a real
  mixture, in which its products react further.
- **Kinetics outside the eight models.** No reactions in solution, no catalysis, no surface, electrode or
  photochemical processes, no combustion kinetics. No sourced first-order model other than MPAN.
- **Pressure-dependent rate constants** (fall-off). The MPAN model holds at 1 bar only.
- **Non-standard conditions.** No reaction quotient, equilibrium composition, partial pressures,
  concentrations, activity or fugacity coefficients, pH, solubilities or electrode potentials.
- **Temperature-dependent thermodynamic data.** No heat capacities, no phase transitions. Gibbs energies away
  from 298.15 K are constant-enthalpy, constant-entropy estimates (see below).
- **Species outside the table.** Nothing is estimated for a missing species (no group additivity, no bond
  energies). Notably absent: all iron, manganese, chromium, nickel and barium species, CaCO3, liquid H2SO4,
  HNO3 and H2O2, glucose, almost all aqueous molecular solutes (only CO2, H2S and H3BO3 are tabulated), and
  the OH, NO3 and organic radicals of the kinetic models.
- **Dissolved electrolytes as molecules.** `NaCl(aq)` or `HCl(aq)` are not entries; write the ions.
- **Half-reactions in thermodynamics.** They can be balanced; without a value for the electron they cannot
  be evaluated.
- **Structure.** Formulas are compositions. No structural formulas, isomers, isotopes (D, T, ¹³C), names,
  non-integer subscripts (which also excludes the CODATA entry CdSO4·8/3H2O) or polymers.
- **Nuclear reactions.**

## Data sources, citations and terms

Every page that was retrieved is listed in [`data/sources/manifest.json`](data/sources/manifest.json) with its
URL, the time of retrieval, the size and SHA-256 of the response, and the file under `data/sources/` that
holds its snapshot or excerpt. All retrievals were made on 2026-11-13, one request at a time, slower than the
`Crawl-delay` each site publishes in `robots.txt` (3 s for www.codata.info, 5 s for webbook.nist.gov).

### 1. CODATA Key Values for Thermodynamics – 150 species

- Page: <https://www.codata.info/resources/databases/key1.html>, kept in full as
  `data/sources/codata/key1.html`.
- Citation, as the page instructs: J. D. Cox, D. D. Wagman and V. A. Medvedev, *CODATA Key Values for
  Thermodynamics*, Hemisphere Publishing Corp., New York, 1989.
- Terms: the page states that "use of these recommended, internally consistent values is encouraged in the
  analysis of thermodynamic measurements, data reduction, and preparation of other thermodynamic tables",
  and that CODATA "cannot assume responsibility for any consequences of the use of these data".
- Used: every row of the table (ΔfH° and S° at 298.15 K) except CdSO4·8/3H2O, whose fractional formula the
  parser cannot represent (`THERMO_OMITTED_ROWS`). The third column of the table, H°(298.15 K) − H°(0), is
  not used.
- Conventions, as the page states them: standard-state pressure 1 bar; a ΔfH° of 0 marks the reference
  state of an element. The table lists H+(aq) with ΔfH° = 0 and S° = 0, so **ionic values follow the
  hydrogen-ion convention**: they are relative to H+(aq), can be negative, and are meaningful only in
  charge-balanced combinations. The page does not restate the solute standard state; the usual convention
  for such tables (hypothetical ideal solution of unit molality) is assumed and listed as an assumption.
- Uncertainties: the page calls them "stated uncertainty limits" within which "there is a high probability
  that the true values fall" and gives no coverage factor. They are stored unchanged in `uncertainty`; read
  as standard uncertainties they err on the wide side.

### 2. NIST Chemistry WebBook (NIST Standard Reference Database 69) – 25 species from 24 pages

- Species: CH4, C2H6, C3H8, C2H4, C2H2, benzene (g), NO, NO2, N2O4, N2O, O3, SO3, H2O2, HNO3, H2SO4 (gases);
  methanol, ethanol, benzene (liquids); NaCl, KCl, CaCl2, NH4Cl, Ca(OH)2, NaOH, CuO (solids).
- Pages: `https://webbook.nist.gov/cgi/cbook.cgi?ID=<CAS id>&Units=SI&Mask=3`, plus the page of individual
  data points for liquid ethanol, the front page (database identification, DOI, "last update to data:
  2025") and the citation guide.
- Citation, following the WebBook's own guide: P. J. Linstrom and W. G. Mallard, Eds., *NIST Chemistry
  WebBook, NIST Standard Reference Database Number 69*, National Institute of Standards and Technology,
  Gaithersburg MD, 20899, <https://doi.org/10.18434/T4D303> (retrieved November 13, 2026). **Each value is
  cited first to the original reference the WebBook lists for it** (for most of these species: M. W. Chase,
  Jr., *NIST-JANAF Thermochemical Tables*, 4th ed., J. Phys. Chem. Ref. Data, Monograph 9, 1998), then to the
  WebBook, as a "chapter" where the page credits a compiler. `ThermoSpecies.provenance.citations` and the
  provenance of each `Quantity` carry these.
- Terms: the pages state "Data compilation copyright by the U.S. Secretary of Commerce on behalf of the
  U.S.A. All rights reserved." For that reason the repository does not hold the pages, only **excerpts**
  (`data/sources/webbook/*.excerpt.html`): the title, formula and CAS number, the enthalpy-of-formation and
  entropy rows, the references those rows cite, and the source's notices, each copied character for
  character. The manifest keeps the SHA-256 of each complete page.
- Selection rule, the same for every species and quantity: **the first row the WebBook lists** (reviews
  first, then individual determinations, newest first). Gas entropies are taken only from rows labelled
  "S°gas,1 bar", so that they share the 1 bar standard state of the CODATA table; where a page has no such
  row the entropy is left empty rather than taken from a row with another or an unstated standard state.
  The row's method, reference and comment are kept in the provenance notes.
- One value is an average computed by the WebBook itself: ΔfH° of liquid ethanol ("−276. ± 2." kJ/mol,
  "Average of 6 values"). It is cited to all six determinations, which were retrieved for that purpose.
- Uncertainties are given only where the WebBook prints one (20 of the 25 enthalpies have none); their
  meaning is that of the cited reference.
- Only phases that exist near 298 K were taken. The WebBook also tabulates, for example, the hypothetical
  liquid of NaCl at 298 K; those entries are not used.
- Looked for and not found: Fe(s) (the page has no entry for the solid), Fe2O3 and CaCO3 (no thermochemical
  rows on the pages retrieved). These pages are listed in the manifest as unused, with the reason.

### 3. IUPAC evaluation of kinetic data for atmospheric chemistry – 8 kinetic models

- R. Atkinson, D. L. Baulch, R. A. Cox, J. N. Crowley, R. F. Hampson, R. G. Hynes, M. E. Jenkin,
  M. J. Rossi and J. Troe, "Evaluated kinetic and photochemical data for atmospheric chemistry: Volume I –
  gas phase reactions of Ox, HOx, NOx and SOx species", *Atmos. Chem. Phys.* **4**, 1461–1738 (2004),
  <https://doi.org/10.5194/acp-4-1461-2004> – six models (data sheets I.A1.2, I.A2.20, I.A3.53, I.A3.54,
  I.A3.57, I.A3.58).
- The same authors, "… Volume II – gas phase reactions of organic species", *Atmos. Chem. Phys.* **6**,
  3625–4055 (2006), <https://doi.org/10.5194/acp-6-3625-2006> – two models (II.A6.136, II.A6.146).
- Terms: both article pages state "© Author(s). This work is licensed under the Creative Commons
  Attribution-NonCommercial-ShareAlike 2.5 License." To keep that licence from spreading to the rest of the
  repository, the PDFs are not stored. `data/sources/iupac/*.excerpts.txt` hold only the bibliographic
  details, the short passages that define the conventions, and the "Preferred Values" and "Reliability"
  blocks of the data sheets used; the manifest keeps the SHA-256 of each PDF. The excerpts are under the
  articles' licence.
- What is taken from each data sheet: the preferred Arrhenius expression k = A exp(B/T), its temperature
  range, the preferred k at 298 K, the reliability (Δlog k at 298 K and Δ(E/R)), and the reaction enthalpy
  where one is printed. The build stops unless the Arrhenius expression reproduces the printed k(298 K) to
  within 15 % and the units of k agree with the number of reactant molecules.
- Conventions, quoted in the excerpts: "All of the reactions in the table are elementary processes", so the
  rate law follows from the equation; for A + A → products the rate of change of [A] "is equal to 2k[A]²";
  the reliabilities "are expanded uncertainties corresponding approximately to a 95% confidence limit".
- The text was extracted from the PDFs with `pdftotext`. Superscripts are flattened ("1.4×10−12" is
  1.4 × 10⁻¹²) and the extractor emits no capital Greek letters, so "Δ" is missing in the excerpts; their
  headers explain how to read them.
- These are the values of the 2004 and 2006 publications. The Task Group publishes its current data sheets
  at <https://iupac.aeris-data.fr>, and some have been revised since.

### Sources that were considered and not used

- **NIST Chemical Kinetics Database** (kinetics.nist.gov), the first choice for kinetics: its `robots.txt`
  disallows every agent except two named search engines, so nothing was retrieved from it.
  `tools/fetch-source.mjs` refuses the host. The classic textbook reactions it would have supplied (H2 + I2,
  N2O5, cyclopropane isomerisation, …) are therefore not in the package.
- **The IUPAC Task Group website**: its legal notice restricts use to "individual and private reproduction
  and consultation", so the openly licensed journal publications were used instead.
- **The NASA/JPL data evaluation**: the host did not resolve from the build machine.

## Approximations and their limits

### Thermodynamics

- **Standard states.** Pure solids and liquids, ideal gases at 1 bar, solutes in the standard state of the
  source table. Results say nothing about real mixtures.
- **Hess's law at 298.15 K.** `deltaH` and `deltaS` are always the 298.15 K values, whatever temperature is
  requested.
- **Constant enthalpy and entropy.** `deltaG`, `lnK` and `equilibriumConstant` at a temperature T use
  ΔG°(T) ≈ ΔH°(298.15 K) − T ΔS°(298.15 K), i.e. they neglect the difference in heat capacity between
  products and reactants and any phase change between 298.15 K and T. The table holds no heat capacities,
  so the error of this estimate is not known to the package. Accordingly:
  - within 25 K of 298.15 K (`THERMO_NO_WARNING_SPAN_K`): no warning, the approximation is listed under
    `assumptions`;
  - between 25 K and 100 K away: a warning;
  - more than 100 K away (`THERMO_VALIDATED_SPAN_K`): a warning that begins "FAR FROM 298.15 K",
    `withinValidatedRange: false`, and `evidence: 'rule-based'` instead of `'computed'` for the result and
    for `deltaG`;
  - for aqueous species or liquid water outside 273.15–373.15 K: a warning that begins "OUTSIDE THE LIQUID
    RANGE OF WATER", with the same flag and label.
  These thresholds are choices of this package, not properties of the data.
- **Equilibrium constant.** K = exp(−ΔG°/RT) is the dimensionless thermodynamic constant in activities.
  When it does not fit in a double (|ln K| > 700) only `lnK` and `log10K` are returned.
- **Direction.** `spontaneity` is `near-equilibrium` when |ΔG°| is smaller than RT or than its own
  uncertainty. It describes all species in their standard states and says nothing about rate.
- **Uncertainty.** The limits printed by the sources, weighted by the net coefficients and combined in
  quadrature as if independent. Correlations between tabulated values are ignored. If a source prints no
  uncertainty for any species involved, none is reported and a warning names the species.
- **Mixed sources.** CODATA and NIST-JANAF values were evaluated separately; a warning is issued whenever a
  reaction combines the two tables.
- **Lookup by composition.** A species is identified by composition, charge and phase, so spelling does not
  matter but structure does not either. Entries whose composition has common isomers (ethanol, benzene)
  carry a note that is surfaced as a warning. A term without a phase label is resolved only if the
  substance is tabulated in a single phase (with a warning naming it); otherwise the status is
  `ambiguous-phase`.

### Kinetics

- **One elementary step, power-law rate law**: rate = k Π[X]^order, each species changing at its net
  stoichiometric coefficient times the rate (the convention of the source: for 2 A → …, d[A]/dt = −2k[A]²).
- **Units.** The shipped models use the units of the source: concentrations in molecule cm⁻³, k in s⁻¹,
  cm³ molecule⁻¹ s⁻¹ or cm⁶ molecule⁻² s⁻¹. `toMolarUnits` converts to mol/L.
- **Validated range.** Outside `validTemperatureRangeK` the rate constant is still computed, as an
  Arrhenius extrapolation: `withinValidatedRange` is false, the first warning begins "TEMPERATURE OUTSIDE
  THE VALIDATED RANGE", and the evidence label is `'rule-based'` instead of `'computed'`.
- **Uncertainty of k.** `rateConstant(...).log10Uncertainty` is Δlog k(T) = Δlog k(298 K) +
  0.4343·Δ(E/R)·|1/T − 1/298|, the estimate the evaluation gives. Two caveats: the article prints the
  bracket without the absolute value, which is added here so that the uncertainty grows on both sides of
  298 K; and the article states the formula for second-order rate coefficients, while the package applies
  it to the first- and third-order models as well, whose data sheets quote reliabilities in the same form.
  It is reported only inside the validated range.
- **Numerical integration.** Dormand–Prince 5(4) with adaptive steps. The `tolerance` (default 1e-8) bounds
  the error per step of each concentration relative to the largest change that species can undergo plus its
  current value. In the tests the curves agree with closed-form solutions to 1e-7 of the initial
  concentration at the default tolerance. The method is explicit; it is not meant for stiff systems, which a
  single reaction is not.
- **Completion.** Once the limiting reactant is used up to within 1 % of the tolerance, the remaining
  outputs hold the fully converted composition and `solver.reactionCompleteAfterSeconds` is set. This is a
  bound, not a guess: nothing can change by more than what is left of the limiting reactant. A state that
  the integrator carried marginally past complete conversion is replaced by the fully converted
  composition, so concentrations are never negative and the mass balance is exact.
- **Half-life.** The time for the limiting reactant to reach half its initial concentration: closed form
  when the rate depends on that species alone, otherwise a numerical quadrature of dt/dξ over the extent of
  reaction (`halfLife.method` says which). It is `null` when nothing reacts.

### Stoichiometry

- Balancing is conservation of atoms and charge only. H+, OH−, H2O and electrons must be written into the
  equation; the package does not add species.
- A charge magnitude must follow `^` (or use the `+2` form). `Fe3+`, `O2-`, `SO42-` and `[Fe(CN)6]4-` are
  refused as ambiguous, with the two possible readings in the message, instead of being guessed at.

## Evidence labels and statuses

| Where | Label or status | Meaning |
| --- | --- | --- |
| `ThermoSpecies.deltaHf298`, `.s298` | `reference` | A value printed by the cited source. |
| `ReactionThermo` (`ok`, `partial`) | `computed` | Hess's law on reference values; ΔG within 100 K of 298.15 K. |
| `ReactionThermo` far from 298.15 K, or aqueous outside 273–373 K | `rule-based` | Constant-ΔH, constant-ΔS estimate with unknown error. |
| `ReactionThermo` (`unbalanced`, `missing-data`, `ambiguous-phase`) | `unsupported` | Nothing computed; `warnings` say why. |
| `rateConstant`, `simulateKinetics` inside the validated range | `computed` | Reference Arrhenius parameters, evaluated or integrated. |
| The same outside the validated range | `rule-based` | Arrhenius extrapolation. |
| The same for a model whose `parameterEvidence` is not `reference` | that label | For example `user-input` for a model built by the user. |
| `simulateKinetics` (`unsupported`) | `unsupported` | No curve; `reasons` say why. |

`ReactionThermo.status`: `ok`, `partial` (enthalpy only, because an entropy is missing), `unbalanced`,
`missing-data`, `ambiguous-phase`. `KineticsResult.status`: `ok`, `incomplete` (the integrator stopped
early; the arrays hold the part computed), `unsupported`.

## Public API

Everything is exported from `src/index.ts`.

| Area | Exports |
| --- | --- |
| Formulas | `parseFormula`, `molarMass`, `hillFormula`, `normalizeFormulaText`, `ChemicalSyntaxError`, type `ParsedFormula` |
| Equations | `parseEquation`, `formatEquation`, `formatTerm`, `formatCoefficient`, `checkConservation`, `reverseEquation`, `scaleEquation`, `PHASE_LABELS`, types `Phase`, `SpeciesTerm`, `ReactionEquation`, `ConservationReport` |
| Balancing | `balanceEquation`, type `BalanceResult` |
| Thermodynamic data | `THERMO_SPECIES`, `THERMO_DATA_SOURCES`, `THERMO_OMITTED_ROWS`, `findThermoSpecies`, `lookupThermoSpecies`, `ENTHALPY_UNIT`, `ENTROPY_UNIT`, types `ThermoSpecies`, `ThermoDataSource`, `ThermoLookup` |
| Reaction thermodynamics | `reactionThermodynamics`, `THERMO_NO_WARNING_SPAN_K`, `THERMO_VALIDATED_SPAN_K`, `LIQUID_WATER_RANGE_K`, types `ReactionThermo`, `ReactionThermoTerm` |
| Kinetic data | `KINETIC_MODELS`, `KINETIC_DATA_SOURCES`, `rateConstant`, `toMolarUnits`, `findKineticModels`, `kineticEvidence`, `MOLECULES_PER_CM3_PER_MOL_PER_L`, types `KineticModel`, `RateConstantResult` |
| Simulation | `simulateKinetics`, `KINETICS_SOLVER_METHOD`, `powerLawDecay`, `powerLawHalfLife`, `secondOrderTwoReactants`, types `KineticsInput`, `KineticsResult` |
| Integrator | `integrateOde`, types `OdeOptions`, `OdeResult` |
| Catalogue | `SUPPORTED_REACTION_CLASSES`, `UNSUPPORTED_FEATURES`, `reactionSupport`, types `ReactionClassInfo`, `UnsupportedFeature`, `ReactionSupport` |
| Experiment pipeline | `runExperiment`, `serializeExperimentResult`, `parseExperimentResult`, `suggestReactions`, `REACTION_CATALOGUE`, `EXPERIMENT_PRESETS`, `LIMITATION_PHRASES`, `EXPLANATION_HEADINGS`, `EXPERIMENT_STEP_IDS`, `EXPERIMENT_STEP_TITLES`, `EXPERIMENT_ENGINE`, `EXPERIMENT_ENGINE_VERSION`, `EXPERIMENT_RESULT_SCHEMA`, `EXPERIMENT_RESULT_SCHEMA_VERSION`, `KINETIC_PRESSURE_MATCH_TOLERANCE`, `normaliseInput`, `canonicalJson`, `sha256Hex`, the lists `SPECIES_ROLES`, `EXPERIMENT_METHODS`, `EXPERIMENT_ENVIRONMENTS`, `EXPERIMENT_CONCENTRATION_UNITS`, `EXPERIMENT_STATUSES`, and the types `ExperimentInput`, `ExperimentSpecies`, `ExperimentConditions`, `ExperimentSolverSettings`, `ExperimentResult`, `ExperimentStep`, `ExperimentStepId`, `ExperimentStatus`, `ExplanationSection`, `EnergyDiagram`, `EnergyLevel`, `ExperimentDataSource`, `RunExperimentOptions`, `CataloguedReaction`, `ExperimentPreset` |

### Deviations from the original API sketch

All sketched capabilities are present under the sketched names. Differences, each an addition or a
tightening:

- `reactionThermodynamics` also accepts an equation string. Its `status` has two more values, `partial` and
  `ambiguous-phase`, and the result has the extra fields `missingEntropy`, `log10K`, `withinValidatedRange`,
  `terms` and `conservation`. `evidence` is `'computed'` when ok, except far from 298.15 K, where it is
  `'rule-based'`.
- `findThermoSpecies(formula)` without a phase returns `undefined` when the substance is tabulated in
  several phases, instead of choosing one; `lookupThermoSpecies` reports which phases exist.
- `ThermoSpecies` has the extra fields `stateDetail`, `source`, `parsed` and `identityNote`.
- `KineticModel` has the extra fields `concentrationUnit`, `parameterEvidence`, `speciesNames`, `conditions`,
  `reliability` and `asPublished`. The shipped models are in molecule cm⁻³, the unit of the source, not mol/L.
- `rateConstant` also returns `log10Uncertainty` and `warnings`.
- `KineticsInput` accepts `tolerance` and `maxSteps`. `KineticsResult.status` has a third value,
  `incomplete`, and the result has the extra fields `halfLife`, `withinValidatedRange`, `species`,
  `concentrationUnit`, `rateUnit` and `solver.reactionCompleteAfterSeconds`.
- `integrateOde` accepts one `atol` per component and a `shouldStop` callback, and also returns
  `stopReason`, `tEnd`, `finalState` and `functionEvaluations`.
- `BalanceResult` has the extra field `independentSolutions`; `ReactionClassInfo` has `limitations`.
- `parseFormula` refuses the ambiguous charge notation described above.

## Regenerating the data

`src/data/thermo.generated.ts` and `src/data/kinetics.generated.ts` are written by scripts from the files in
`data/sources/`. Nothing in them is typed by hand; the only hand-written inputs are the number-free choices
in `tools/lib/selection.mjs` (which pages, which phases, names, formulas).

```powershell
# rebuild the generated files from the committed snapshots (no network)
node packages/reactions/tools/build-thermo.mjs
node packages/reactions/tools/build-kinetics.mjs

# refresh a source: one page per call; see the header of the script for the access rules it enforces
node --use-system-ca packages/reactions/tools/fetch-source.mjs --id <id> --url <https url> --file <path> [--discard]
node packages/reactions/tools/excerpt-webbook.mjs        # WebBook pages in data/.scratch -> excerpts
node packages/reactions/tools/extract-pdf-excerpts.mjs   # article PDFs in data/.scratch -> excerpts (needs pdftotext)
```

`data/.scratch/` (git-ignored) holds full downloads only while the excerpt tools run; it is not needed to
build or test. `--use-system-ca` makes Node use the operating system's certificate store, which was needed on
the build machine; certificate checking is never disabled.

## Tests

```powershell
vitest run --project reactions
tsc --noEmit -p packages/reactions
```

| File | Covers |
| --- | --- |
| `test/formula.test.ts` | nested groups, hydrates, charges, Unicode, the electron, every error path, molar masses against the element table, Hill formulas |
| `test/equation.test.ts` | arrows, coefficients, phases, charge-versus-separator plus signs, round trips, conservation reports |
| `test/balance.test.ts` | combustions, redox in acid and base with charges, half-reactions, precipitations, already balanced, impossible and underdetermined equations, exact rational arithmetic |
| `test/thermo.test.ts` | table integrity and provenance, sign conventions, units, ΔG = ΔH − TΔS = −RT ln K, reversal, scaling, additivity, uncertainty propagation, agreement with the reaction enthalpies printed by the IUPAC evaluation, temperature warnings, every refusal path |
| `test/ode.test.ts` | the integrator on problems with known solutions, exactness for polynomials, fifth-order convergence, invariants, failure reporting |
| `test/kinetics.test.ts` | model provenance and consistency, rate constants, unit conversion, agreement with analytic first-, second-, third-, zero- and fractional-order solutions, mass balance, half-lives, out-of-range, unsupported and incomplete paths |
| `test/provenance.test.ts` | every shipped number re-read from the saved snapshots with independent code, manifest hashes, the generated files being exactly what the snapshots produce, no Node-only API in `src/` |
| `test/catalogue.test.ts` | every capability flag and limitation text of the catalogue checked against what the package actually does |
| `test/experiment.test.ts` | the experiment pipeline: every preset; published values for methane combustion, H2 + Cl2 and the NO + O3 rate constant and half-life; each method; every refusal (no products, impossible and open equations, missing data, missing rate law, missing concentrations, fourteen kinds of invalid input); the limitation texts appearing exactly when they apply; the rules for energy diagrams; sources cited only when used; progress, cancellation before each step and inside an integration, an exhausted step budget; determinism; the round trip through `serializeExperimentResult` and the rejection of foreign, damaged or altered text; the catalogue lookup |
| `test/experiment-hash.test.ts` | SHA-256 against the standard test vectors, canonical JSON, and the input hash |

One test is not millisecond-scale: the check in `test/provenance.test.ts` that the generated files are exactly
what the snapshots produce starts the two build tools as Node processes (`--check`). It takes 1 to 3 s on a quiet
machine and was measured at up to 15 s with four suites running at once, so it has its own time limit (180 s)
instead of the 5 s default. Every other test took at most about 0.2 s.

## Open points for the project

- **Licences.** Two excerpt files are under CC BY-NC-SA 2.5 and the WebBook excerpts quote a copyrighted
  compilation. The project owner confirmed permission to redistribute the WebBook excerpts for the
  public publication on 16 November 2026. Existing notices and attribution are retained; the IUPAC
  excerpts remain under [their original licence](https://creativecommons.org/licenses/by-nc-sa/2.5/).
  This does not relicense third-party material or grant blanket commercial reuse rights.
- **Textbook kinetics.** The classic teaching reactions are missing because their natural source could not be
  used (see above). If the project obtains permission, or a person downloads the pages by hand,
  `tools/build-kinetics.mjs` shows the pattern for adding them.
- **Heat capacities.** Adding Cp data (for example the Shomate coefficients of the WebBook) would lift the
  constant-enthalpy approximation; it needs its own sourcing pass.
