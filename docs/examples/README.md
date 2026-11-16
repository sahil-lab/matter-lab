# Examples

Everything listed here ships with the application or lies beside this file. None of it is written
by hand: the molecules are computed geometries, and the experiment files are the output of the
experiment engine, checked by a test that runs each one again.

## Example experiments

The Reaction Laboratory has twelve example experiments (the selector "Example experiments" at the
top of the set-up panel). Choosing one fills in the species and conditions; "Run experiment" then
calculates it.

| Example | What it shows | Outcome |
| --- | --- | --- |
| Combustion of methane | Reaction enthalpy, entropy, Gibbs energy and equilibrium constant from the reference table; no kinetics, because flames are not modelled | completed |
| Ammonia synthesis equilibrium at 298.15 K | A gas-phase equilibrium constant at the temperature of the data, with propagated uncertainty | completed |
| Ammonia synthesis at 700 K and 200 bar over an iron catalyst | Far from 298.15 K the Gibbs energy becomes a rule-based estimate; the pressure does not enter; the catalyst is recorded but not modelled | completed, with a warning |
| Neutralisation | Aqueous ions in the hydrogen-ion convention of the reference table | completed |
| Precipitation of silver chloride | A precipitation from aqueous ions; the equilibrium constant is the reciprocal of a solubility product | completed |
| Displacement of copper by zinc | An ionic redox equation balanced for atoms and charge | completed |
| Dissolution of sodium chloride | Values from two reference tables combined, which the result points out | completed |
| Nitric oxide and ozone: thermodynamics and kinetics | A sourced second-order rate law integrated in time, with a half-life, a timeline and an energy diagram | completed |
| Oxidation of nitric oxide by oxygen | A termolecular rate law whose rate constant falls with rising temperature, so no energy barrier is drawn | completed |
| Thermal decomposition of MPAN | A first-order rate law that is valid at 1 bar only | completed |
| Oxidation of iron: a species without reference data | The equation is balanced, the missing species are named, nothing is estimated | partial |
| Methane and oxygen with no products entered | Products are never guessed; nothing is calculated | not supported |

Five of them are saved here as experiment records, in [experiments/](experiments):

| File | Result in the file |
| --- | --- |
| [methane-combustion.experiment.json](experiments/methane-combustion.experiment.json) | CH₄(g) + 2 O₂(g) → CO₂(g) + 2 H₂O(l): ΔH° = −890.3 kJ/mol, ΔG° = −817.9 kJ/mol at 298.15 K |
| [ammonia-synthesis-700k.experiment.json](experiments/ammonia-synthesis-700k.experiment.json) | N₂(g) + 3 H₂(g) → 2 NH₃(g): ΔH° = −91.88 ± 0.70 kJ/mol at 298.15 K; ΔG° ≈ +46.8 kJ/mol and log₁₀ K ≈ −3.49 at 700 K, labelled rule-based because enthalpy and entropy are taken as independent of temperature |
| [no-o3-kinetics.experiment.json](experiments/no-o3-kinetics.experiment.json) | NO(g) + O₃(g) → NO₂(g) + O₂(g): k(298 K) = 1.73 × 10⁻¹⁴ cm³ molecule⁻¹ s⁻¹ (IUPAC evaluation), half-life 47.0 s for the concentrations entered, 201 points of the time course |
| [silver-chloride-precipitation.experiment.json](experiments/silver-chloride-precipitation.experiment.json) | Ag⁺(aq) + Cl⁻(aq) → AgCl(s): ΔH° = −65.72 ± 0.14 kJ/mol, ΔG° = −55.64 ± 0.20 kJ/mol, log₁₀ K = 9.75 |
| [iron-oxidation-missing-data.experiment.json](experiments/iron-oxidation-missing-data.experiment.json) | 4 Fe(s) + 3 O₂(g) → 2 Fe₂O₃(s) is balanced; Fe(s) and Fe₂O₃(s) are not in the reference table, so no thermodynamic value is given. Status: partial |

A record holds the inputs, the SHA-256 hash of the inputs, the seven steps of the pipeline with their
outcome, the balanced equation, every result with its unit, evidence level and source, the
explanation at both depths, the warnings, the limitations, and the engine version and data sources
needed to reproduce it.

**To open one:** Reactions workspace, "Record" tab, "Open file". The record opens with its inputs
filled in. "Reproduce" runs it again and reports whether every number came out the same.

**How they are kept honest:** `packages/reactions/test/examples.test.ts` runs each of the five
presets and requires the file to be exactly what the engine produces. After an intended change to
the engine the files are written again with

```powershell
$env:MATTERLAB_WRITE_EXAMPLES = '1'; vitest run --project reactions packages/reactions/test/examples.test.ts
```

## Example molecules

Sixteen molecules are built in (Library, "Examples"): water, methane, benzene, ammonia, carbon
dioxide, ethene, ethyne and others up to caffeine, aspirin, glucose and adamantane. Their
coordinates are computed model geometries (RDKit: ETKDG embedding relaxed with MMFF94), close to but
not the same as measured structures; the application says so where it offers them. They are generated
by `tools/data/build_examples.py`.

The Reaction Laboratory adds single-molecule models of the species of its reactions, taken from
PubChem: 3D conformers where PubChem has one (computed, MMFF94s), otherwise PubChem's bonding with a
shape computed here by the Universal Force Field. Together with the examples they form the built-in
library of 63 structures that the "Find" tab of the Library searches by substructure and by
similarity, and that the Discovery Vault searches for an identical structure.

## Things to try

1. **Build and check.** Open the application, press `A` for the build tool and `P` for the periodic
   table, choose an element, click to place atoms and drag from an atom to grow a bond. The
   inspector shows the formula, the rule-based checks and RDKit's identifiers as you go.
2. **An isotope and its nucleus.** Select a carbon atom, set its neutrons to 8 in the inspector
   (carbon-14, with its half-life), and choose "Look inside the nucleus".
3. **A model from SMILES.** File menu, Library, "Find", enter `C[C@H](N)C(=O)O` (L-alanine). The
   model is built and its handedness is checked against the string before it is offered.
4. **Optimise and compare.** With caffeine on stage, drag an atom out of place, press `O` (Optimise
   geometry), then use "Compare with original" and "Replay path" on the Compute tab. The Explain tab
   describes the calculation with its own numbers.
5. **Orbitals of water.** Open water from the Library ("Examples"), choose "Run Hartree–Fock" on the
   Compute tab, and step through the orbitals; switch the field to the density, then to the
   potential, and add a cutting plane.
6. **A reaction with a time course.** Reactions workspace, example "Nitric oxide and ozone:
   thermodynamics and kinetics", "Run experiment", then play the timeline and open the Graphs tab.
7. **A candidate.** Draw a structure that is not in the library, open the Vault workspace, choose
   "Add as candidate", then "Search the catalogues", and read what the status does and does not say.
