# @matterlab/forcefield

Geometry optimisation with the Universal Force Field (UFF) for MATTER LAB.

This package is a dependency-free TypeScript port of the UFF implementation in **RDKit 2026.09.2**
(atom typing, the chemistry perception the typing depends on, all energy terms with analytic
gradients, and the BFGS minimiser), wrapped in an optimiser that is meant to survive the geometries
people actually build by hand. It runs in a Web Worker: `src/` uses no Node-only API and has no
runtime dependency (the only import from outside the package is the `Provenance` type of
`@matterlab/core`).

The port is validated against RDKit itself: 194 molecules, 2501 atoms, every term parameter, energies
and gradients at two geometries per molecule, and the optimised structures. See [Validation](#validation).

```ts
import { optimizeUff, UnsupportedForceFieldError } from '@matterlab/forcefield';

try {
  const result = optimizeUff(molecule, {
    onStep: (s) => {
      if (s.step % 10 === 0) postMessage({ step: s.step, energy: s.energy, positions: s.positions.slice() });
      return !cancelRequested(); // return false to cancel
    },
  });
  // result.converged, result.positions (Float64Array, angstrom), result.finalEnergy (kcal/mol),
  // result.warnings, result.atomTypes, result.provenance ...
} catch (err) {
  if (err instanceof UnsupportedForceFieldError) {
    // err.problems: [{ atomIndex, reason }, ...] - UFF has no type for these atoms
  } else throw err;
}
```

## Contents

- [Public API](#public-api)
- [Input contract](#input-contract)
- [Method](#method)
- [Provenance, attribution and licence](#provenance-attribution-and-licence)
- [Validation](#validation)
- [Performance](#performance)
- [Where this package differs from RDKit](#where-this-package-differs-from-rdkit)
- [Limitations and unsupported cases](#limitations-and-unsupported-cases)
- [Reproducing the data and the measurements](#reproducing-the-data-and-the-measurements)
- [Layout](#layout)
- [References](#references)

## Public API

Exported from `src/index.ts`. The types are exactly the specified ones; `test/api.test.ts` holds
the specification verbatim and `tsc` fails if an export stops being identical to it.

| Export | Purpose |
|---|---|
| `createUffSystem(mol): UffSystem` | Types the molecule and builds the force field at the given geometry. Throws `UnsupportedForceFieldError`. |
| `uffEnergy(system, positions): UffEnergyTerms` | Energy by term (bond stretch, angle bend, torsion, inversion, van der Waals, total), kcal/mol. |
| `uffEnergyAndGradient(system, positions, gradient): number` | Writes dE/dx (kcal/mol/angstrom) into `gradient` (overwriting it) and returns the total energy. |
| `optimizeUff(mol, options?): OptimizeResult` | Geometry optimisation. Throws `UnsupportedForceFieldError`. |
| `UnsupportedForceFieldError` | `problems: readonly { atomIndex, reason }[]`, one entry per atom UFF cannot handle. |
| types | `FfAtom`, `FfBond`, `FfMolecule`, `UffEnergyTerms`, `UffSystem`, `OptimizeStep`, `OptimizeOptions`, `OptimizeResult` |

Additional exports (not in the specification): `perceiveUffMolecule(mol)` (RDKit's hybridisation,
conjugation, valence, radical and small-ring perception plus the atom types, as plain data),
`uffParameterLookup(mol)` (the equivalents of RDKit's `GetUFFBondStretchParams`,
`GetUFFAngleBendParams`, `GetUFFTorsionParams`, `GetUFFInversionParams`, `GetUFFVdWParams`),
`uffSystemWarnings(system)`, `RDKIT_VERSION`, the default settings of the optimiser
`DEFAULT_MAX_STEPS`, `DEFAULT_GRADIENT_TOLERANCE` and `DEFAULT_ENERGY_TOLERANCE` (the values in
the table below, for callers that state the convergence criteria in words), and the types
`ForceFieldProblem`, `UffParameterLookup`, `UffPerception`, `Hybridization`.

Units: angstrom, kcal/mol, kcal/mol/angstrom. Positions and gradients are `Float64Array`s of xyz
triples. Everything returned is plain, structured-cloneable data (numbers, strings, arrays, typed
arrays); a `UffSystem` survives `structuredClone` / `postMessage` and still evaluates.

### `optimizeUff` in detail

| Option | Default | Meaning |
|---|---|---|
| `maxSteps` | 2000 | Step limit. Steps of the pre-relaxation of an unusable start count. |
| `gradientTolerance` | 1e-4 | RMS of the Cartesian gradient components of the atoms that are free to move, kcal/mol/angstrom. |
| `energyTolerance` | 1e-6 | Energy change of the last step, kcal/mol. |
| `frozenAtoms` | none | Atom indices that must not move (their gradient is ignored, as RDKit's fixed points). |
| `recordTrajectoryEvery` | 0 | Record a `Float32Array` frame at step 0, every n-th step and the last step. 0 = no trajectory. |
| `onStep` | none | Called for step 0 (the starting geometry) and after every step with `{ step, energy, rmsGradient, maxGradient, positions }`. `positions` is a live view: copy it to keep it. Return `false` to cancel. |

Result fields worth knowing about:

- `converged` is true only if **both** tolerances are met **and** the final geometry is a minimum
  rather than a saddle point (see [Saddle points](#saddle-points)). When the step limit is hit,
  the run is cancelled, or no minimum could be established, it is false and `warnings` says why.
- `cancelled` is true if `onStep` returned `false`; the geometry reached so far is returned.
- `initialEnergy` is the energy of the geometry as given. If that is undefined (coincident atoms),
  it is the energy of the repaired start and a warning says so.
- `rmsGradient` / `maxGradient` refer to the atoms that are free to move.
- `rmsDisplacement` is the RMS atomic displacement from the geometry as given, without alignment.
- `warnings` lists everything that was done on the user's behalf or that RDKit itself would have
  logged: start repairs, pre-relaxation, saddle points stepped off, typer fallbacks, radical
  centres, non-convergence.
- `provenance.source` is `UFF as implemented in RDKit 2026.09.2, ported to TypeScript`, with the
  literature citations, the exact RDKit tag and commit, and the licence.

Errors: `UnsupportedForceFieldError` when the chemistry is outside UFF (nothing is ever typed by
guesswork; every offending atom is listed), `RangeError` when the input is malformed (bad atom
index, self-bond, duplicate bond, bond order other than 1, 1.5, 2, 3, non-integer charge,
non-finite position, atomic number outside 1..118, nonsensical options), `TypeError` when an object
that is not a `UffSystem` is passed to the energy functions.

`optimizeUff` is synchronous and should be called in a worker. To cancel from the main thread,
have `onStep` read a flag that the main thread can set (for example a `SharedArrayBuffer` byte read
with `Atomics.load`), or run in slices with a small `maxSteps` and continue from the returned
`positions`.

## Input contract

- **All hydrogens are explicit atoms.** Every atom is treated the way RDKit treats an atom without
  implicit hydrogens. An atom whose valence is not filled is therefore a radical centre (exactly as
  RDKit's `assignRadicals` decides) and produces a warning.
- **Formal charges are integers.**
- **Bond orders are 1, 1.5, 2 or 3, where 1.5 means "aromatic exactly as RDKit reports after
  sanitisation".** This package does not perceive aromaticity: an atom is aromatic if and only if
  it has a 1.5 bond. A Kekulé structure (alternating 1 and 2) of an aromatic ring is taken as
  written: its atoms are still typed as resonant (`C_R`), but its bonds get the lengths of double
  and single bonds (benzene: 1.340 and 1.479 angstrom instead of 1.399). That is exactly what
  RDKit computes when its aromaticity perception is switched off (tested), but not what RDKit does
  with the same molecule normally.
- Charge-separated forms are expected where RDKit's sanitisation produces them, e.g. a nitro group
  as `[N+](=O)[O-]`. A pentavalent neutral nitrogen is refused with a hint to that effect.

The reference generator checks this contract for every reference molecule: it rebuilds the molecule
in RDKit from exactly these data (atomic numbers, charges, bond orders, no implicit hydrogens) and
confirms that RDKit's perception and UFF energy are unchanged ("contract round trip": 194 of 194).

## Method

### Energy function

The Universal Force Field of Rappé, Casewit, Colwell, Goddard and Skiff [1], with the bonded and
non-bonded terms as RDKit implements them. Parameters of each term derive from per-atom-type
constants (bond radius, natural angle, van der Waals distance and well depth, effective charge,
torsional barriers, electronegativity); nothing is fitted per molecule.

| Term | Form (as in RDKit) |
|---|---|
| Bond stretch | `E = 1/2 k (r - r0)^2`, `r0 = ri + rj + rBO - rEN` with the Pauling bond-order correction `rBO = -0.1332 (ri + rj) ln(n)` and the O'Keeffe-Brese electronegativity correction [5]; `k = 2 G Zi Zj / r0^3`, `G = 332.06`. |
| Angle bend | Linear, trigonal-planar, square-planar/octahedral centres: `E = k/n^2 (1 - cos(n theta))` with n = 1, 3, 4 (and 2 for the axial pair of a trigonal bipyramid). Everything else: `E = k (C0 + C1 cos(theta) + C2 cos(2 theta))` with the coefficients fixed by the natural angle. RDKit's additions are reproduced: natural angles of 60/150 and 90/135 degrees for sp2 atoms in three- and four-membered rings; the trigonal-bipyramid special case, whose axial pair is chosen from the construction geometry; and an exponential penalty `exp(-20 (theta - theta0 + 0.25))` below about 30 degrees for the n-fold terms (borrowed by RDKit from Open Babel [8]). |
| Torsion | `E = V/2 (1 - cos(n phi0) cos(n phi))` about every bond between two sp2 or sp3 atoms that are not terminal and not triply bonded; `V`, `n`, `phi0` from the hybridisation pair (sp3-sp3, sp2-sp2 with equation 17 of [1], sp2-sp3 and its propene-like special case, the group-16 special cases); `V` is divided by the number of torsions about the bond. |
| Inversion | `E = K (C0 + C1 sin(Y) + C2 cos(2W))` for three-coordinate sp2 C, N, O (K = 50/3 kcal/mol for a carbon bound to an sp2 oxygen, 6/3 otherwise) and for three-coordinate P, As, Sb, Bi; three terms per centre. |
| Van der Waals | `E = D ((x/r)^12 - 2 (x/r)^6)`, geometric-mean combination rules, for every pair of atoms in the same fragment that is neither bonded (1-2) nor shares a neighbour (1-3), up to a distance of 10 x (RDKit's default `vdwThresh`). |

RDKit's defaults are used throughout: van der Waals threshold 10, and **no non-bonded interactions
between separate fragments** (`ignoreInterfragInteractions=True`). RDKit's UFF has **no
electrostatic term**, so neither has this package.

The analytic gradient of every term follows RDKit's gradient routine line by line, including the
places where RDKit's energy and gradient routines treat a degenerate geometry differently.

### Atom typing and perception

UFF atom types (`C_3`, `C_R`, `N_2`, `O_R`, `S_3+6`, `Ti3+4`, ...) are assigned by a port of
RDKit's `AtomTyper.cpp`. The typer depends on RDKit's perception, which is ported too:

- explicit valence and its validity (`calculateExplicitValence` in `Atom.cpp`, with RDKit's
  periodic-table valence lists and the "effective atomic number" treatment of charged atoms);
- radical counts (`MolOps::assignRadicals`);
- conjugation and hybridisation (`ConjugHybrid.cpp`: `setConjugation`, `setHybridization`,
  including the rule that an atom with four electron domains and at most three neighbours is sp2
  rather than sp3 when one of its bonds is conjugated, like the single-bonded oxygen of O=C-O);
- three- and four-membered ring membership, and connected fragments.

Where RDKit's typer logs a warning and carries on (hybridisation forced to sp3 or sp for elements
with a single UFF type; "Unrecognized charge state", after which RDKit falls back to a default
type), the result carries a warning naming the atom. Where RDKit ends up without parameters for an
atom ("Unrecognized atom type"), `UnsupportedForceFieldError` is thrown, with one entry per atom
giving the element, its perceived hybridisation, valence and charge, and the label that is not in
RDKit's table.

### Minimiser

`src/minimizer.ts` is a port of RDKit's `BFGSOpt::minimize` and `linearSearch` (after Numerical
Recipes [10]), including RDKit's scaling of the gradient, so that an optimisation follows the same
path as RDKit's and ends in the same basin. What differs is the stopping logic:

- convergence is decided on the true RMS gradient and the energy change, not on RDKit's loose
  relative tests (the structures RDKit returns for the reference set have RMS gradients of up to
  1.6e-2 kcal/mol/angstrom, median 1.3e-4, not counting iodine trifluoride, see below);
- where RDKit raises ("bad direction in linearSearch") or reports convergence because a line search
  found no lower energy, the inverse Hessian is reset and the search continues;
- a line search that RDKit would abandon as "step too small" keeps backtracking if the gradient is
  still above the tolerance;
- when energy differences drop below double-precision resolution a step is judged on the
  directional derivative instead (the approximate-Wolfe idea of Hager and Zhang [7]);
- non-finite trial energies are rejected; 200 steps without progress end the run as not converged.

Up to 1200 coordinates (400 atoms) the inverse Hessian is dense, as in RDKit (only its upper
triangle is used; the arithmetic is bit-for-bit that of the full matrix). Larger
systems use the limited-memory variant (L-BFGS, 30 correction pairs [6]).

### What `optimizeUff` adds around RDKit's algorithm

RDKit's `UFFOptimizeMolecule` assumes a reasonable 3D structure. A hand-built one need not be, so:

1. **Start repair.** Atoms of the same fragment closer than 0.01 angstrom are moved apart by a
   deterministic pseudo-random displacement (up to 0.1 angstrom per coordinate, more for larger
   piles); an exactly straight angle at an sp2 or sp3 atom, where torsion and inversion terms have
   no defined plane, is bent by up to 0.01 angstrom. Frozen atoms are never moved. The same input
   always gives the same result.
2. **Pre-relaxation.** If atoms coincided, or the start has a neighbour pair folded to within
   30 degrees at an sp/sp2/hypervalent centre, or non-bonded atoms within a quarter of their van
   der Waals distance, the geometry is first relaxed in a smooth stand-in potential (UFF's own bond
   terms and natural angles, single-minimum angle terms, soft repulsion, no torsions or
   inversions; `src/prerelax.ts`). The reason is a real trap in RDKit's functional form: the n-fold
   angle terms have a second minimum at zero angle, which RDKit closes with a discontinuous
   exponential wall; atoms that start on the wrong side stay there. The same escape is used (at
   most three times) if a run ends in such a trap. The steps count as steps and report the true
   UFF energy.
3. **UFF optimisation** with the minimiser above, the force field being rebuilt at the geometry it
   starts from (as RDKit does; this matters for five-coordinate centres).
4. <a id="saddle-points"></a>**Saddle-point check.** A gradient-following method cannot leave a
   symmetric stationary point (planar NH3, eclipsed ethane, a flat cyclohexane, a planar styrene).
   After convergence the lowest Hessian eigenvalue is computed by a Lanczos iteration with full
   reorthogonalisation [11, 12] on finite-difference Hessian-vector products. If it is below
   -0.01 kcal/mol/angstrom^2 (and beyond numerical noise), the geometry is displaced by up to 0.1
   angstrom along that mode and the optimisation continues (at most 12 times), with a warning.
   If the final point still has negative curvature, `converged` is false.

## Provenance, attribution and licence

This package contains code ported from, and data generated from, the **RDKit**
(<https://www.rdkit.org>, <https://github.com/rdkit/rdkit>), release **2026.09.2**, tag
`Release_2026_09_2`, commit `f86b7dc9b31e2531200bbd1f54589bcbd968bb05`.

RDKit is distributed under the BSD 3-Clause License:

> Copyright (c) 2006-2015, Rational Discovery LLC, Greg Landrum, and Julie Penzotti and others.
> All rights reserved.

The full licence text is in [`tools/rdkit-src/license.txt`](tools/rdkit-src/license.txt) and is
reproduced in the header of the generated tables. The ported source files are named at the top of
each module in `src/`.

- `tools/fetch_rdkit_sources.mjs` downloads the 46 RDKit source files the port was written from
  and RDKit's licence, at that tag, into `tools/rdkit-src/`, and records a SHA-256 of each in
  `MANIFEST.json` (retrieved 2026-11-13).
- `tools/gen_uff_params.mjs` generates `src/generated/uffParams.generated.ts` (the 127 UFF atom
  types of `Code/ForceField/UFF/Params.cpp`) and `src/generated/rdkitElements.generated.ts`
  (symbols, outer-shell electron counts and valence lists of `Code/GraphMol/atomic_data.cpp`).
  Numeric tokens are copied as spelled in the RDKit source. **No parameter was typed by hand.**
  `test/generated.test.ts` re-parses `Params.cpp` independently and compares all 127 x 11 values,
  and checks the element data against `@matterlab/core` and against what the installed RDKit
  reports (`tools/gen_rdkit_checks.py` writes `test/fixtures/rdkit_checks.json`).

## Validation

### Reference data

`tools/gen_uff_reference.py` (run with the project's Python 3.12 / RDKit 2026.09.2 / NumPy
environment) writes `test/fixtures/uff_reference.json`. Each molecule is built from SMILES, given
explicit hydrogens (`AddHs`) and embedded with ETKDGv3 [9] and the fixed random seed 1992. (The one
exception is the 422-atom alkane C140H282, which ETKDG could not embed; its start is an all-trans
chain built directly and perturbed by up to 0.05 angstrom.) Recorded per molecule:

- atomic numbers, formal charges, coordinates, bonds with `GetBondTypeAsDouble()`;
- RDKit's perception (hybridisation, valence, radicals, aromatic atoms, conjugated bonds,
  three-/four-ring membership, fragments) and everything the UFF typer wrote to RDKit's log;
- RDKit's UFF energy and gradient at the embedded geometry and at a randomly perturbed one
  (up to 0.2 angstrom per coordinate);
- the per-term parameters from `GetUFFBondStretchParams`, `GetUFFAngleBendParams`,
  `GetUFFTorsionParams`, `GetUFFInversionParams`, `GetUFFVdWParams`;
- the geometry and energy after `UFFOptimizeMolecule` reports convergence ("optimized"; one call
  of 1000 iterations for every molecule except C140, which needed two);
- the minimum of RDKit's own energy function next to that geometry, located to an RMS gradient of
  about 1e-6 by an independent NumPy BFGS that uses RDKit only as energy/gradient oracle
  ("polished"), and the lowest eigenvalue of RDKit's Hessian at both points.

The set: **194 molecules RDKit can type** (2 to 422 atoms, 2501 atoms in total, 27 elements: H, Li,
B, C, N, O, F, Na, Mg, Al, Si, P, S, Cl, K, Ti, Ge, As, Se, Br, Rb, Sn, Sb, Te, I, Cs, Hg; 42 of the
127 UFF atom types), **13 molecules RDKit cannot type**, and **15 special geometries** (angles on
both sides of the 30-degree penalty, straight angles, coincident 1-4 atoms, compressed and expanded
molecules). It covers alkanes, alkenes, alkynes, allene, benzene, toluene, pyridine, pyrrole,
furan, thiophene, naphthalene, indole, imidazole, alcohols, ethers, amines, amides, carboxylic
acids, esters, ketones, aldehydes, nitriles, nitro groups, halides (F, Cl, Br, I), thiols, sulfides,
sulfoxides, sulfones, phosphines, phosphates, silanes, boron compounds, small inorganics (H2O, NH3,
H2O2, CO2, SO2, SO3, HCN, H2S, PH3, SiH4, HCl, HF, H2, N2, O2, CO, O3), ions (ammonium, acetate,
hydroxide, hydronium, glycine zwitterion and others), radicals, multi-fragment systems, strained
rings (cyclopropane, cyclobutane, cubane, prismane, propellane, ...), hypervalent and main-group
compounds, a few metal compounds, drug-like molecules (aspirin, caffeine, ibuprofen, paracetamol,
nicotine, penicillin G, testosterone, cholesterol, atorvastatin, paclitaxel), and the eleven
molecules of RDKit's own typer unit test with the 40 labels that test asserts.

### Results

`vitest run --project forcefield`: **9 test files, 1524 tests, all passing**; `tsc --noEmit -p
packages/forcefield` clean. The numbers below are written by the tests themselves (see
[Reproducing](#reproducing-the-data-and-the-measurements)).

| Check | Scope | Required by the tests | Worst deviation measured |
|---|---|---|---|
| Generated parameter table = RDKit's `Params.cpp` | 127 atom types x 11 values | exact | exact |
| Perception (hybridisation, valence, radicals, aromaticity, conjugation, ring flags, fragments) | 207 molecules, 2583 atoms, 2463 bonds | identical | identical |
| Atom types | 2501 atoms | the type implied by RDKit's parameters | all agree; unique for 2495 atoms, the other 6 are `P_3+5` vs `P_3+q`, which share one parameter set |
| Atom types asserted by RDKit's own unit test | 40 labels, 11 molecules | identical | identical |
| Bond-stretch `kb`, `r0` | 2392 bonds | 1e-12 relative | 4.9e-16 |
| Angle-bend `ka`, `theta0` | 4149 angles | 1e-12 relative | 5.5e-16 |
| Torsion `V` (and absence of a term where RDKit has none) | 5123 torsions (+35 without term) | 1e-12 relative | 0 |
| Inversion `K` (and absence) | 990 inversions (+69 without term) | 1e-12 relative | 0 |
| Van der Waals `x_ij`, `D_ij` | 7720 pairs | 1e-12 relative | 0 |
| Energy vs RDKit | 388 geometries (embedded + perturbed) | 1e-9 relative | 4.2e-15 relative for the 193 molecules shorter than the van der Waals cutoff; 4.5e-10 relative (2.9e-6 kcal/mol) for C140H282 at its perturbed geometry, see [differences](#where-this-package-differs-from-rdkit) |
| Analytic gradient vs RDKit | 15006 components | 1e-8 of the largest component | 3.6e-14 (6.9e-11 for C140H282, same cause) |
| Analytic vs central-difference gradient | 6227 components | 1e-7 of the largest component | 3.5e-9 |
| Energy and gradient at the 15 special geometries | 15 (14 with a finite RDKit gradient) | 1e-9 / 1e-8 relative | 7.9e-16 / 2.7e-16 |
| Unsupported molecules | 13 | refused, naming exactly the atoms and labels RDKit rejects | all 13 |
| Typer warnings and fallbacks | 194 molecules | one warning per line RDKit logs, none otherwise | identical |

The task's target for energies was 1e-3 kcal/mol absolute or 1e-6 relative; the largest absolute
deviation anywhere is 2.9e-6 kcal/mol.

**Optimisation**, started from the same embedded geometry as RDKit, default settings:

| Check | Result |
|---|---|
| Converged (RMS gradient <= 1e-4, a minimum) | 194 of 194, 9339 steps in total, at most 997 (C140H282) |
| Final energy vs RDKit's optimised energy | within 1e-6 kcal/mol for 182 molecules. Of the other 12, eleven are lower (the optimisation is carried further) and one is higher: C140H282, by 9.2e-6 kcal/mol (the L-BFGS path). No other molecule is higher by more than 1.7e-10 |
| Final energy vs the polished minimum of RDKit's energy | within 1e-6 kcal/mol for 190 molecules; at most 3.2e-3 above (allene: RDKit has no torsion term about a bond to an sp atom, so its CH2 groups rotate almost freely; RDKit's own result is equally far above) |
| Bond lengths and angles vs RDKit's optimised structure, the 192 molecules for which RDKit reached a minimum (149 of them rigid) | worst 0.0023 angstrom and 0.37 degrees (cyclopentane, whose pseudorotation is nearly flat and where RDKit stops 1.2e-4 kcal/mol above the minimum); all others within 5e-5 angstrom and 0.016 degrees. Required: 0.01 angstrom and 1 degree |
| The same vs the polished minimum, all 194 | worst 1.3e-5 angstrom and 0.0023 degrees |

The two molecules for which RDKit's result is **not** a minimum are excluded from the geometry
comparison and tested separately:

- **Styrene.** `UFFOptimizeMolecule` reports convergence on a saddle point: the Hessian of RDKit's
  own energy at RDKit's own result has an eigenvalue of -0.81 kcal/mol/angstrom^2. This package
  steps off it and converges 0.074 kcal/mol lower (15.8300 vs 15.9044), at the polished minimum
  (within 1e-6 kcal/mol), and says so in a warning.
- **Iodine trifluoride.** UFF's iodine type has a natural angle of 180 degrees, which three
  neighbours cannot satisfy; the general angle term, whose coefficients contain 1/sin^2(theta0),
  then becomes astronomically stiff and the energy is about 1.1e9 kcal/mol. RDKit reports
  convergence at an RMS gradient of 3.6e5 kcal/mol/angstrom because its test is relative to that
  energy. This package converges 158 kcal/mol lower and warns that UFF is not a meaningful model
  for such a centre. Energies and gradients at fixed geometries still agree with RDKit to better
  than 1e-15 relative.

Per chemical class (a molecule can be in several classes). "Energy" and "Gradient" are the worst
relative deviations from RDKit over both geometries; "E - E(RDKit)" is how far the optimised
energy lies above RDKit's (0 = never above); the last two columns compare the optimised geometry
with RDKit's. (a): excluding styrene / iodine trifluoride, see above.

| Class | Molecules | Energy, rel. | Gradient, rel. | Converged | E - E(RDKit), max (kcal/mol) | Bonds, max (angstrom) | Angles, max (degrees) |
|---|---:|---:|---:|---:|---:|---:|---:|
| alcohol | 4 | 9.1e-16 | 4.5e-16 | 4/4 | 0 | 7.8e-7 | 8.0e-5 |
| aldehyde | 3 | 1.4e-15 | 3.1e-16 | 3/3 | 1.7e-10 | 6.6e-8 | 1.2e-5 |
| alkane | 9 | 4.5e-10 | 6.9e-11 | 9/9 | 9.2e-6 | 2.3e-3 | 3.7e-1 |
| alkene | 11 | 9.4e-16 | 4.4e-16 | 11/11 | 3.1e-15 | 5.1e-6 | 1.3e-3 |
| alkyne | 3 | 3.6e-15 | 3.6e-14 | 3/3 | 6.9e-14 | 1.1e-15 | 4.9e-8 |
| allene | 2 | 3.6e-16 | 3.1e-16 | 2/2 | 1.7e-14 | 1.5e-6 | 1.0e-4 |
| amide | 5 | 4.0e-16 | 4.0e-16 | 5/5 | 0 | 6.4e-7 | 6.3e-5 |
| amine | 6 | 4.9e-16 | 3.9e-16 | 6/6 | 5.6e-15 | 4.0e-7 | 6.3e-5 |
| aromatic | 22 | 1.8e-15 | 4.4e-16 | 22/22 | 1.7e-10 | 2.6e-6 (a) | 6.3e-4 (a) |
| boron | 6 | 2.1e-16 | 3.5e-16 | 6/6 | 3.4e-15 | 1.4e-6 | 7.8e-3 |
| carboxylic acid | 2 | 2.1e-16 | 1.7e-16 | 2/2 | 0 | 4.9e-7 | 6.2e-5 |
| charged | 10 | 8.3e-16 | 3.2e-16 | 10/10 | 1.5e-14 | 1.4e-6 | 1.4e-4 |
| conjugated | 3 | 5.6e-16 | 4.0e-16 | 3/3 | 0 | 1.2e-7 (a) | 1.8e-5 (a) |
| drug-like | 10 | 4.2e-15 | 8.4e-16 | 10/10 | 0 | 4.7e-6 | 2.0e-3 |
| ester | 1 | 5.6e-16 | 1.7e-16 | 1/1 | 0 | 2.2e-16 | 4.3e-14 |
| ether | 6 | 6.7e-16 | 5.0e-16 | 6/6 | 2.1e-14 | 7.3e-6 | 1.8e-3 |
| halide | 10 | 4.1e-16 | 3.8e-16 | 10/10 | 3.8e-11 | 7.1e-7 | 7.2e-5 |
| heteroaromatic | 6 | 1.2e-15 | 4.4e-16 | 6/6 | 0 | 2.6e-6 | 6.3e-4 |
| hypervalent | 5 | 1.7e-16 | 3.4e-16 | 5/5 | 0 | 3.8e-6 (a) | 7.5e-4 (a) |
| imine | 2 | 5.3e-16 | 2.6e-16 | 2/2 | 0 | 6.5e-7 | 1.9e-4 |
| inorganic | 23 | 3.0e-16 | 2.4e-16 | 23/23 | 5.6e-15 | 6.6e-7 | 5.2e-4 |
| ion | 16 | 6.4e-16 | 3.9e-16 | 16/16 | 3.0e-14 | 6.6e-7 | 1.2e-4 |
| ketone | 4 | 1.2e-15 | 3.6e-16 | 4/4 | 5.6e-15 | 2.5e-6 | 6.7e-4 |
| large (C140H282) | 1 | 4.5e-10 | 6.9e-11 | 1/1 | 9.2e-6 | 3.7e-6 | 2.2e-3 |
| main group | 8 | 1.0e-15 | 3.5e-16 | 8/8 | 0 | 1.1e-6 | 2.0e-3 |
| metal | 3 | 2.9e-16 | 1.2e-16 | 3/3 | 2.1e-15 | 2.5e-6 | 3.7e-4 |
| multi-fragment | 4 | 4.4e-16 | 2.2e-16 | 4/4 | 3.8e-12 | 3.1e-7 | 1.2e-4 |
| nitrile | 2 | 0 | 9.1e-17 | 2/2 | 0 | 9.9e-7 | 1.2e-4 |
| nitro | 3 | 8.3e-16 | 2.3e-16 | 3/3 | 1.5e-14 | 6.1e-7 | 1.4e-4 |
| phosphate | 2 | 3.6e-16 | 2.1e-16 | 2/2 | 0 | 3.9e-7 | 7.1e-5 |
| phosphine | 3 | 5.8e-16 | 2.3e-16 | 3/3 | 0 | 4.2e-7 | 1.7e-4 |
| radical | 7 | 3.6e-16 | 2.2e-16 | 7/7 | 4.2e-15 | 8.6e-7 | 6.0e-5 |
| RDKit unit-test molecules | 11 | 4.2e-16 | 3.4e-16 | 11/11 | 5.4e-14 | 1.6e-6 | 4.1e-4 |
| ring (unstrained) | 5 | 1.2e-15 | 5.2e-16 | 5/5 | 0 | 2.3e-3 | 3.7e-1 |
| silane | 3 | 3.0e-16 | 4.0e-16 | 3/3 | 0 | 8.7e-7 | 5.2e-4 |
| strained ring | 21 | 1.9e-15 | 3.4e-15 | 21/21 | 3.1e-15 | 4.8e-5 | 1.6e-2 |
| sulfide | 3 | 2.1e-16 | 3.0e-16 | 3/3 | 0 | 8.4e-7 | 1.2e-4 |
| sulfone | 2 | 4.4e-16 | 2.3e-16 | 2/2 | 4.2e-15 | 5.6e-7 | 2.1e-5 |
| sulfoxide | 1 | 4.4e-16 | 1.8e-16 | 1/1 | 0 | 4.1e-7 | 9.1e-5 |
| thiocarbonyl | 2 | 3.4e-16 | 2.5e-16 | 2/2 | 0 | 6.8e-7 | 4.6e-5 |
| thiol | 2 | 4.3e-16 | 1.4e-16 | 2/2 | 0 | 7.2e-7 | 7.6e-5 |
| zwitterion | 1 | 4.4e-16 | 2.8e-16 | 1/1 | 0 | 1.7e-7 | 6.3e-5 |

**No chemical class in the reference set fails to match RDKit.** The only deviations above
rounding level are the three explained above: C140H282 away from its construction geometry (a
deliberate difference in how the van der Waals cutoff is applied), and styrene and iodine
trifluoride, where RDKit's own optimisation does not end at a minimum.

### Robustness

`test/robustness.test.ts`, with RDKit's numbers from the fixture as reference:

- **All atoms at the origin.** Methane, water, ammonia, ethane, ethene, CO2, formaldehyde,
  benzene, pyridine and methanol reach RDKit's minimum (energy within 1e-4 kcal/mol, bonds within
  0.001 angstrom, angles within 0.1 degrees). Ethanol, acetic acid, cyclohexane, aspirin, caffeine,
  paracetamol and testosterone reach a conformer with correct bonded geometry (bonds within 0.05
  angstrom and angles within 8 degrees of RDKit's structure) no more than 1 to 10 kcal/mol above
  the minimum RDKit reaches from a proper embedding.
- **Flat and straight starts.** Planar methane becomes the regular tetrahedron, linear water bends
  to the UFF angle, planar ammonia becomes pyramidal, eclipsed ethane becomes staggered, a flat D6h
  cyclohexane puckers to a minimum at least as low as RDKit's; benzene, ethanol, aspirin and
  caffeine with every atom on one line, or squashed into a plane, end in proper structures. A
  mirror-symmetric C40H82 (122 atoms) with eclipsed methyl groups ends with them staggered, at the
  same energy as from a staggered start.
- **Stretched and misplaced atoms.** Molecules blown up three-fold, a single atom dragged 15
  angstrom away, and H2 at 6 angstrom all relax to proper structures.
- Frozen atoms stay exactly where they are; cancellation, step callbacks, trajectories, the step
  limit (`converged: false` with a warning), tighter and looser tolerances, determinism, the
  L-BFGS path, and structured cloning of results are tested as well.

## Performance

Targets: energy + gradient of a 100-atom molecule in under 1 ms once the system is built; a full
optimisation of a typical 50-atom organic molecule in under 1 s. Both are asserted by
`test/performance.test.ts` (median of repeated measurements; for the optimisation also the first,
not yet JIT-compiled run).

Measured single-threaded in Node 24.14.1 on a laptop (Intel Core Ultra 7 165H) **that was shared
with other jobs: its CPU load was between about 30 and 100 % during the measurements**. The ranges
are over the runs made during development (about ten). The process CPU time for the same work was
similar to the wall-clock time. For calibration: in the same sessions a plain dot-product
loop over a `Float64Array` took between 1.6 ns (load about 40 %) and 5 ns (load 100 %) per element.
Timings on an idle machine were not measured.

| Measurement | Result | Target |
|---|---|---|
| Energy + gradient, paclitaxel (113 atoms; 119 bonds, 215 angles, 333 torsions, 81 inversions, 5996 van der Waals pairs) | 0.17 to 0.33 ms per call (median of batches) | < 1 ms |
| Energy only, same molecule | 0.10 to 0.20 ms | - |
| Building the system for it (typing + term tables) | 1.1 to 2.1 ms | - |
| Full optimisation, testosterone (49 atoms, 171 steps), warm | 103 to 156 ms | < 1 s |
| The same, first call in a fresh process (includes JIT compilation) | 179 to 468 ms | < 1 s |
| Testosterone from all atoms at the origin (620 steps incl. pre-relaxation) | 137 to 321 ms | - |

Other molecules, default settings, same conditions (not targets):

| Molecule | Atoms | Energy + gradient | Steps | Full optimisation |
|---|---:|---:|---:|---:|
| aspirin | 21 | 10 to 24 us | 102 | 9 to 18 ms |
| caffeine | 24 | 16 to 31 us | 91 | 11 to 27 ms |
| ibuprofen | 33 | 25 to 49 us | 121 | 26 to 42 ms |
| penicillin G | 41 | 37 to 71 us | 216 | 58 to 113 ms |
| testosterone | 49 | 49 to 92 us | 171 | 69 to 134 ms |
| cholesterol | 74 | 85 to 194 us | 252 | 185 to 364 ms |
| atorvastatin | 76 | 90 to 169 us | 335 | 216 to 536 ms |
| paclitaxel | 113 | 175 to 293 us | 431 | 0.67 to 1.14 s |
| C66H134 (all-trans chain, perturbed; not in the reference set) | 200 | - | 476 | 1.7 to 3.1 s |
| C140H282 | 422 | 1.2 to 2.2 ms | 997 | 2.9 to 5.0 s |

Where the time goes (paclitaxel): roughly a third each for the energy and gradient evaluations of
the line search (about 2.5 trials per step), the dense BFGS update, and the saddle-point check (two
gradient evaluations per Lanczos vector). The van der Waals sum is a plain O(N^2) loop over atom
pairs; there is no neighbour list. Between roughly 150 and 400 atoms the dense inverse-Hessian
update, which is quadratic in the number of coordinates and kept for fidelity to RDKit's path,
costs more than the energy evaluations (the 200-atom chain above); beyond 400 atoms the
limited-memory update takes over (the 422-atom chain).

## Where this package differs from RDKit

Deliberate, and each one tested:

1. **Van der Waals pair list.** RDKit decides at construction which pairs are within 10 x_ij and
   never revisits the list. Here every eligible pair is kept and the same cutoff is applied at
   each evaluation. Identical at the construction geometry; at other geometries it differs only for
   molecules longer than the cutoff (29 to 39 angstrom for hydrogen and carbon): 2.9e-6 kcal/mol
   for C140H282 with every coordinate moved by up to 0.2 angstrom.
2. **Torsions beyond the first 1000 torsion bonds.** RDKit finds torsion bonds with
   `SubstructMatch`, whose default limit is 1000 matches (`Builder.cpp` line 513,
   `SubstructMatch.h` `maxMatches = 1000`), so a molecule with more than 1000 such bonds silently
   loses the torsion terms of the rest. This package keeps all of them. Measured on distorted
   n-alkanes (`tools/check_rdkit_torsion_limit.py`, `test/api.test.ts`): up to C1001H2004 (1000
   torsion bonds) the energies agree to 1e-12 relative; beyond, RDKit is lower by exactly the
   torsional energy of the bonds after the first 1000 (0.134 kcal/mol per bond at that geometry;
   53.6 kcal/mol for C1400H2802). Applying the same truncation to this package's term list
   reproduces RDKit's energies to 1e-12 relative.
3. **Inversion gradient at degenerate centres.** Where three atoms of an sp2 centre lie on one
   line RDKit divides by zero and returns NaN; here the undefined term contributes no gradient
   (its energy is the same as RDKit's). And where an inversion term has a zero-length bond, RDKit's
   batched gradient routine returns (`Inversions.cpp` line 128) and thereby drops the gradient of
   all inversion terms after it; here only the affected term is skipped.
4. **Convergence and saddle points**, as described under [Method](#method): the optimisation is
   carried further than RDKit's and does not stop on a saddle point. Final energies are equal to
   or lower than RDKit's, except for C140H282, which ends 9.2e-6 kcal/mol higher (table above).
5. **Start repair and pre-relaxation** exist only here. For a start RDKit can handle they are not
   triggered, and the path is RDKit's.
6. **Errors instead of log lines.** For an atom it cannot type RDKit logs
   `UFFTYPER: Unrecognized atom type`, and `UFFHasAllMoleculeParams` is false; `UFFOptimizeMolecule`
   nevertheless runs with a force field that lacks every term involving that atom and returns 0
   (recorded for SF6, selenophene and ZnCl2 in `test/fixtures/rdkit_checks.json`: SF6 "converges"
   at an energy of 0). Here the molecule is refused.

Two properties of RDKit that matter when comparing against it:

- `ForceField.CalcGrad(positions)` reuses the interatomic distances cached by the last
  `CalcEnergy` call (`ForceField::calcGrad(double*, double*)` does not reset the distance matrix),
  so a gradient requested at new coordinates without evaluating the energy there first is wrong.
  The reference generator always evaluates the energy first.
- An undefined energy (bonded atoms exactly on top of each other) is NaN in both.

## Limitations and unsupported cases

**The model.** UFF is a generic force field: geometries are approximate, and energies are strain
energies that are not comparable between different molecules. There are no electrostatics and no
hydrogen-bond term (RDKit's UFF has neither), so intermolecular complexes and ionic interactions
are not modelled; by RDKit's default, separate fragments do not interact at all and may end up on
top of each other. The result is a local minimum near the start, not a conformer search.

**Stereochemistry.** The input carries no stereo information. The optimiser keeps the
configuration encoded in a reasonable 3D start, but a start without one (atoms on a point, on a
line, in a plane) yields an arbitrary stereoisomer and conformer; R/S and E/Z are not controlled.
RDKit's use of chiral tags when perceiving the hybridisation of some hypervalent centres is not
reproducible for the same reason.

**Atoms UFF (as implemented in RDKit) cannot type** raise `UnsupportedForceFieldError`. Any atom
whose RDKit label is not one of the 127 entries of RDKit's table is refused; cases in the reference
set: noble gases (He, Ne, Ar; Xe in XeF4), sulfur in SF6 (`S_6+6`) and SF4 (`S_5+4`), aromatic
selenium (selenophene, `Se2+2`), zinc in ZnCl2 and dimethylzinc (`Zn1+2`), lead in tetramethyllead
(`Pb3+3`), tungsten in WF6 (`W_6`), zirconium in ZrCl4 (`Zr3`). RDKit's typer can never produce the
table entries `H_b` (bridging hydrogen), `O_3_z` (zeolite oxygen) or `P_3+q`, so neither can this
package.

**Also refused:** a valence RDKit's valence model does not permit (RDKit would fail to sanitise
the molecule), for example pentavalent carbon or a neutral pentavalent nitro nitrogen; and an atom
with exactly one aromatic (1.5) bond.

**Cannot be expressed in the input:** dative, quadruple and other bond types; so most coordination
compounds are out of reach, and RDKit's clean-up of metal bonds, nitro groups and the like is not
performed here (it is expected to have happened upstream).

**Centres UFF describes badly are accepted with a warning,** as in RDKit: elements with a single
UFF type whose hybridisation is forced (Mg, Al, Si, P, Sn, Sb, Te, Tl, Pb, Bi, Po; and Hg as
linear), valences without a matching UFF oxidation state (hexafluorophosphate, hexafluorosilicate),
radical centres, and atoms whose natural angle is 180 degrees but which have three or more
neighbours handled by the general angle term (iodine in IF3), for which the energy is meaningless.

**Validated scope.** The reference set exercises 42 of the 127 UFF atom types. The other types
(most transition metals, lanthanides, actinides, heavier main-group elements) come from the same
generated table and the same ported typing rules, but no reference molecule tests them.

**Numerics and scale.**

- The saddle-point check is exhaustive up to 80 free atoms. Above that it is a 240-vector Lanczos
  estimate. It finds the unstable methyl rotation of symmetric alkanes with 122 and 182 atoms
  (`test/robustness.test.ts`), but it is not a proof that a geometry is a minimum.
- No neighbour list: cost per evaluation grows with the square of the number of atoms (1.2 to
  2.2 ms at 422 atoms on the test machine). The dense inverse Hessian is used up to 400 atoms
  (11.5 MB) and makes optimisations of a few hundred atoms take seconds; L-BFGS is used above.
- `optimizeUff` is synchronous; cancellation is only possible through `onStep`.
- Energies of grossly distorted geometries can be astronomically large (the n-fold angle terms and
  RDKit's exponential penalty); they are reproduced as RDKit computes them, not capped.

**Not done.** Nothing in the specification is known to be missing. The performance figures were
taken on a shared, busy machine and were not re-measured on an idle one.

## Reproducing the data and the measurements

From the repository root, in PowerShell, after `.\env.ps1`:

```powershell
# 1. RDKit sources at the pinned tag (writes tools/rdkit-src/ and MANIFEST.json)
node packages/forcefield/tools/fetch_rdkit_sources.mjs

# 2. Generated tables (src/generated/*.generated.ts)
node packages/forcefield/tools/gen_uff_params.mjs

# 3. RDKit reference fixture (about 10 to 15 minutes: Hessians and tight minima for 194 molecules)
.\.venv\Scripts\python.exe packages\forcefield\tools\gen_uff_reference.py

# 4. RDKit energies of long alkanes for the torsion-limit test (about 20 s)
.\.venv\Scripts\python.exe packages\forcefield\tools\check_rdkit_torsion_limit.py

# 5. Small RDKit facts the tests pin (periodic-table data, a Kekule benzene without aromaticity
#    perception, what RDKit does with molecules it cannot type); a few seconds
.\.venv\Scripts\python.exe packages\forcefield\tools\gen_rdkit_checks.py

# 6. Type-check and test
tsc --noEmit -p packages/forcefield
vitest run --project forcefield

# 7. The same, also writing every measured deviation and timing to
#    packages/forcefield/test-results/validation-*.json (and printing them with --silent=false)
$env:UFF_WRITE_REPORT = '1'; vitest run --project forcefield --silent=false
```

## Layout

```
src/
  index.ts          public API
  types.ts          public types
  errors.ts         UnsupportedForceFieldError
  perception.ts     graph, valence, radicals, conjugation, hybridisation, small rings, fragments
  atomTyper.ts      UFF atom labels (RDKit AtomTyper.cpp)
  params.ts         atomic parameters and the formulas that turn them into term parameters
  builder.ts        term tables (RDKit Builder.cpp)
  energy.ts         energy and analytic gradient of all five terms
  system.ts         createUffSystem, uffEnergy, uffEnergyAndGradient, perception/parameter lookups
  minimizer.ts      BFGS / L-BFGS (RDKit BFGSOpt.h with a stricter stopping logic)
  modes.ts          lowest Hessian eigenvalue (Lanczos) for the saddle-point check
  prerelax.ts       trap-free stand-in potential for unusable starting geometries
  optimize.ts       optimizeUff
  provenance.ts     provenance record and citations
  generated/        tables generated from RDKit's sources (do not edit)
tools/
  fetch_rdkit_sources.mjs       downloads the RDKit sources at the pinned tag
  gen_uff_params.mjs            generates src/generated/ from them
  gen_uff_reference.py          RDKit reference fixture (test/fixtures/uff_reference.json)
  check_rdkit_torsion_limit.py  RDKit energies of long alkanes (rdkit_torsion_limit.json)
  gen_rdkit_checks.py           small RDKit facts pinned by the tests (rdkit_checks.json)
  rdkit-src/                    the RDKit files the port was written from, MANIFEST.json, license.txt
test/
  fixtures/         the three JSON fixtures written by the Python tools
  helpers/          fixture loader, geometry helpers, deviation reporting
  generated, perception, typing, parameters, energy, optimize, robustness, performance, api (.test.ts)
```

## References

1. A. K. Rappé, C. J. Casewit, K. S. Colwell, W. A. Goddard III, W. M. Skiff, "UFF, a full periodic
   table force field for molecular mechanics and molecular dynamics simulations",
   *J. Am. Chem. Soc.* **1992**, *114*, 10024-10035. doi:10.1021/ja00051a040
2. C. J. Casewit, K. S. Colwell, A. K. Rappé, "Application of a universal force field to organic
   molecules", *J. Am. Chem. Soc.* **1992**, *114*, 10035-10046. doi:10.1021/ja00051a041
3. C. J. Casewit, K. S. Colwell, A. K. Rappé, "Application of a universal force field to main group
   compounds", *J. Am. Chem. Soc.* **1992**, *114*, 10046-10053. doi:10.1021/ja00051a042
4. A. K. Rappé, K. S. Colwell, C. J. Casewit, "Application of a universal force field to metal
   complexes", *Inorg. Chem.* **1993**, *32*, 3438-3450. doi:10.1021/ic00068a012
5. M. O'Keeffe, N. E. Brese, "Atom sizes and bond lengths in molecules and crystals",
   *J. Am. Chem. Soc.* **1991**, *113*, 3226-3229. doi:10.1021/ja00009a002
6. D. C. Liu, J. Nocedal, "On the limited memory BFGS method for large scale optimization",
   *Math. Program.* **1989**, *45*, 503-528. doi:10.1007/BF01589116
7. W. W. Hager, H. Zhang, "A new conjugate gradient method with guaranteed descent and an efficient
   line search", *SIAM J. Optim.* **2005**, *16*, 170-192. doi:10.1137/030601880
8. N. M. O'Boyle, M. Banck, C. A. James, C. Morley, T. Vandermeersch, G. R. Hutchison, "Open Babel:
   An open chemical toolbox", *J. Cheminform.* **2011**, *3*, 33. doi:10.1186/1758-2946-3-33
9. S. Wang, J. Witek, G. A. Landrum, S. Riniker, "Improving conformer generation for small rings and
   macrocycles based on distance geometry and experimental torsional-angle preferences",
   *J. Chem. Inf. Model.* **2020**, *60*, 2044-2058. doi:10.1021/acs.jcim.0c00025 (ETKDGv3, used
   only to embed the reference molecules)
10. W. H. Press, S. A. Teukolsky, W. T. Vetterling, B. P. Flannery, *Numerical Recipes in C*, 2nd
    ed., Cambridge University Press, 1992, sections 9.7 and 10.7.
11. C. Lanczos, "An iteration method for the solution of the eigenvalue problem of linear
    differential and integral operators", *J. Res. Natl. Bur. Stand.* **1950**, *45*, 255-282.
    doi:10.6028/jres.045.026
12. B. N. Parlett, *The Symmetric Eigenvalue Problem*, SIAM, 1998. doi:10.1137/1.9781611971163
13. RDKit: Open-source cheminformatics, release 2026.09.2. <https://www.rdkit.org>,
    doi:10.5281/zenodo.591637
