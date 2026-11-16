# @matterlab/quantum

An ab initio electronic-structure engine that runs in the browser: restricted Hartree-Fock (RHF)
with the STO-3G basis for closed-shell molecules of H to Ar, evaluation of the resulting molecular
orbitals, electron density and electrostatic potential, and isosurface extraction. It is plain
TypeScript without third-party dependencies, synchronous and single-threaded, and meant to run in a
Web Worker.

Everything it returns is the output of a calculation that actually ran. Systems it cannot treat are
rejected with reasons (`checkSupport`, `UnsupportedSystemError`); calculations that do not converge
say so (`converged: false` plus a warning); nothing is estimated or filled in.

```ts
import { checkSupport, createGrid, evaluateDensityGrid, evaluateEspAtPoints, evaluateOrbitalGrid, marchingCubes, runRhf } from '@matterlab/quantum';

const water = {
  atoms: [
    { z: 8, position: [0, 0, 0.1173] }, // angstrom
    { z: 1, position: [0, 0.7572, -0.4692] },
    { z: 1, position: [0, -0.7572, -0.4692] },
  ],
  charge: 0,
} as const;

const support = checkSupport(water); // { supported, reasons, nBasis, nElectrons, estimatedSeconds }
if (support.supported) {
  const result = runRhf(water, { onPhase: (phase, fraction) => {}, onIteration: (it) => {}, isCancelled: () => false });
  // result.energy.total (hartree), result.orbitalEnergies, result.mullikenCharges, result.dipole.debye, result.warnings ...

  const grid = createGrid(water.atoms); //                               0.2 A spacing, 3 A padding
  const density = evaluateDensityGrid(result, water, grid); //           electrons / bohr^3
  const surface = marchingCubes(density, grid, 0.002); //                 positions in angstrom
  const potential = evaluateEspAtPoints(result, water, surface.positions); // hartree / e, one per vertex

  const homo = evaluateOrbitalGrid(result, water, result.homoIndex, grid); // bohr^(-3/2)
  const lobes = [marchingCubes(homo, grid, 0.05), marchingCubes(homo, grid, -0.05)];
}
```

## Public API

| Export | Purpose |
| --- | --- |
| `checkSupport(input, options?)` | Decides whether a system can be computed; lists every reason when it cannot; estimates the run time. |
| `runRhf(input, options?)` | RHF/STO-3G single point. Throws `UnsupportedSystemError` (with `.reasons`) when `checkSupport` says no. |
| `createGrid(atoms, options?)` | Regular grid around a molecule (default spacing 0.2 Å, padding 3 Å, at most 2 000 000 points; the spacing grows to fit). |
| `evaluateDensityGrid`, `evaluateOrbitalGrid` | Electron density / one molecular orbital on a grid. |
| `evaluateDensityAtPoints`, `evaluateEspAtPoints` | Electron density / electrostatic potential at arbitrary points. |
| `marchingCubes(values, grid, isoValue)` | Isosurface of any scalar field on a regular grid as an indexed, welded triangle mesh. |
| Types | `QmAtom`, `QmInput`, `SupportOptions`, `SupportReport`, `ScfOptions`, `ScfIteration`, `ScfResult`, `BasisFunctionInfo`, `GridSpec`, `IsoMesh` |
| Additional | `virialRatio(result)`, `evaluateOrbitalAtPoints`, `meshStatistics(mesh)` (area, enclosed volume, closedness), `ENGINE_NAME`, `ENGINE_VERSION`, `DEFAULT_MAX_BASIS_FUNCTIONS`, `HARD_MAX_BASIS_FUNCTIONS`, `MIN_NUCLEAR_SEPARATION`, `FIELD_AMPLITUDE_CUTOFF`, grid defaults, and the SCF defaults `DEFAULT_MAX_ITERATIONS` (100), `DEFAULT_ENERGY_TOLERANCE` (1e-9 E<sub>h</sub>), `DEFAULT_DENSITY_TOLERANCE` (1e-7) |

The types and signatures are exactly those of the package specification; `test/api.test.ts` restates
them and fails the type check if an export drifts. `ScfResult` consists of typed arrays and plain
data only, so it can be posted from a worker (structured clone) and used on the other side.

### Units and conventions

| Quantity | Unit |
| --- | --- |
| Input positions, grid origin and spacing, points, mesh positions | ångström |
| Charge, Mulliken charges | elementary charge e |
| Energies, orbital energies | hartree (E<sub>h</sub>) |
| Dipole moment | e·a<sub>0</sub> (`dipole.au`) and debye (`dipole.debye`); origin at the centre of nuclear charge, `originDependent: true` for ions |
| Electron density | electrons per bohr³ (× 6.7483 for electrons per Å³) |
| Orbital amplitude | bohr<sup>−3/2</sup>; the sign of an orbital is arbitrary (largest coefficient made positive), degenerate orbitals may be any orthonormal combination |
| Electrostatic potential | hartree per e (× 27.2114 for volts); positive where a positive test charge is repelled; +∞ at a nucleus |
| Matrices | row-major `Float64Array`, basis functions ordered atom by atom as 1s, 2s, 2px, 2py, 2pz, 3s, 3px, 3py, 3pz; `orbitalCoefficients[mu * nBasis + i]` is the coefficient of function mu in orbital i |
| Grid values | `Float32Array`, index `ix + dims[0] * (iy + dims[1] * iz)` |

Conversions use the constants of `@matterlab/core` (CODATA 2018: 1 a<sub>0</sub> = 0.529177210903 Å,
1 e·a<sub>0</sub> = 2.541746473 D).

### Running in a worker

`runRhf` and the field evaluators are synchronous. Progress arrives through `onPhase` (integrals,
scf, properties, each with a fraction from 0 to 1) and `onIteration`. Because nothing else runs in
the worker while a calculation is in progress, a "cancel" message cannot be received in time;
`isCancelled` therefore has to read something that changes underneath it, e.g. a flag in a
`SharedArrayBuffer` (`Atomics.load`) or a deadline, or the worker is simply terminated. A cancelled
run returns `cancelled: true, converged: false` and a warning; values that had not been computed are
NaN.

## Method

**Basis set.** STO-3G (Hehre, Stewart and Pople 1969; Hehre, Ditchfield, Stewart and Pople 1970):
each Slater-type atomic orbital is a fixed contraction of three Gaussians; 1 function for H and He,
5 for Li-Ne, 9 for Na-Ar, s and Cartesian p functions only. The exponents and coefficients are
those of the Basis Set Exchange (Pritchard et al. 2019), downloaded as JSON and committed unchanged
as `data/sto-3g.bse.json` (library version, basis-set revision, URL, date and SHA-256 are in
`data/manifest.json`). `tools/build-basis.mjs` re-encodes the snapshot as
`src/basis/sto3g.generated.ts`; `test/basis.test.ts` checks that the two are identical. Contracted
functions are renormalised to unit norm.

**Integrals.** McMurchie-Davidson scheme (McMurchie and Davidson 1978; notation of Helgaker,
Jørgensen and Olsen 2000): the product of two basis functions is expanded in Hermite Gaussians, and
Coulomb-type integrals reduce to Hermite Coulomb integrals R<sub>tuv</sub>, which are derivatives of
the Boys function (Boys 1950). For every pair of shells the Hermite expansion coefficients of all
primitive products are precomputed once, including contraction coefficients and the Gaussian
product factor, as a sparse list (`src/integrals/shellPairs.ts`). For s and p functions the
R<sub>tuv</sub> up to order 4 are evaluated from closed forms (`src/integrals/hermite.ts`).

- Boys function F<sub>m</sub>(T): seven-term Taylor expansion about a pre-tabulated grid (spacing
  0.05) for T < 36, asymptotic formula with upward recursion beyond.
- Overlap, kinetic-energy and dipole integrals: products of one-dimensional overlaps from the
  Obara-Saika recurrence (Obara and Saika 1986).
- Nuclear attraction and the electrostatic potential: (2π/p) Σ E<sub>tuv</sub> R<sub>tuv</sub>.
- Two-electron integrals: all function quartets of two shell pairs share one set of
  R<sub>tuv</sub> per primitive quartet (an sp shell is treated as one shell with four functions).
  The eight-fold permutational symmetry is used (each unordered pair of shell pairs is visited
  once), shell quartets are skipped by the Schwarz inequality (Häser and Ahlrichs 1989) when
  Q<sub>ab</sub>Q<sub>cd</sub> < 1e-12, primitive quartets when their bound is below 1e-15, and the
  unique integrals are stored in one packed `Float64Array` of length n⁴/8 (index
  ij(ij+1)/2 + kl with ij = i(i+1)/2 + j).

**SCF.** Roothaan's equations (Roothaan 1951) with symmetric orthogonalisation S<sup>−1/2</sup>
(Löwdin 1950) from a cyclic Jacobi eigen-decomposition (Jacobi 1846), a core-Hamiltonian starting
guess, and Pulay's DIIS (Pulay 1980, 1982) on the orthogonalised commutator FPS − SPF with up to
eight vectors. The SCF is converged when the energy changes by less than `energyTolerance` (1e-9
E<sub>h</sub>) **and** the RMS change of the density matrix is below `densityTolerance` (1e-7). The
reported energy, its components and the orbital energies (expectation values of the final Fock
operator, which agree with its eigenvalues to second order in the residual) all belong to the
returned density.

**Stability.** The core-Hamiltonian guess can lead the SCF to a saddle point of the energy instead
of a minimum. N<sub>2</sub> is the classic case: an antibonding π orbital stays occupied and the
SCF converges 0.73 E<sub>h</sub> above the ground state (PySCF does exactly the same from this
guess, see the validation below). Every converged solution is therefore tested for internal
(closed-shell → closed-shell) stability (Seeger and Pople 1977), that is, for an eigenvalue of the
orbital-rotation Hessian H below −1e-5 E<sub>h</sub>. H is only applied to vectors, each product
costing one Fock build.

- Up to 32 orbital rotations (occupied × virtual orbitals: every diatomic and most triatomic
  molecules in this basis) H is built and diagonalised in full. The answer is exact.
- Beyond that the search is iterative, and it does not rely on an eigenvalue iteration having
  converged, because such an iteration can settle on an eigenvalue that is not the lowest (this
  happened, see the validation). Preconditioned conjugate gradients (Hestenes and Stiefel 1952) are
  run on (H + 1e-5) y = b for a pseudo-random probe b, and the Ritz values of H in the space of
  the search directions are monitored. A Ritz value below the threshold proves an instability; its
  eigenvector is then converged with Davidson corrections (Davidson 1975). If instead the linear
  system converges to a relative residual of 1e-5 while all Ritz values stay above the threshold,
  an instability can only have been missed if its overlap with the probe is below 1e-5 (the
  residual of a Krylov method cannot fall below that overlap unless a Ritz value turns negative),
  which for a random probe and d rotations has a probability of about 0.8 · 1e-5 · √d, less than
  0.05 % for the largest supported systems. This is a randomised certificate, not a proof.
- A mode with zero eigenvalue, which appears when a solution breaks a continuous symmetry, is
  converged and set aside so that it does not stall the conjugate gradients.

If an instability is found, the occupied orbitals are rotated along the unstable direction to the
lowest energy on that path and the SCF continues from there, up to four times. If a saddle point
cannot be left, or the search does not finish within 60 products, the result carries a warning.
This is an addition to the specified algorithm; it does not change results for solutions that are
already minima.

**Properties.** Mulliken net charges q<sub>A</sub> = Z<sub>A</sub> − Σ<sub>μ∈A</sub> (PS)<sub>μμ</sub>
(Mulliken 1955); dipole moment μ = Σ Z<sub>A</sub>(R<sub>A</sub> − O) − tr(P r) with O the centre of
nuclear charge.

**Fields.** ρ(r) = Σ P<sub>μν</sub> φ<sub>μ</sub>φ<sub>ν</sub> and ψ<sub>i</sub>(r) = Σ C<sub>μi</sub>
φ<sub>μ</sub>. On a regular grid each Gaussian factorises into three one-dimensional tables, so no
exponential is evaluated in the inner loop; a primitive is skipped wherever its contribution to a
basis function is below 1e-10 bohr<sup>−3/2</sup>. The electrostatic potential
V(r) = Σ Z<sub>A</sub>/|r − R<sub>A</sub>| − ∫ρ(r′)/|r − r′| dr′ is evaluated analytically: the
density is first contracted into Hermite Gaussians (once), each of which contributes
(2π/p) R<sub>tuv</sub> at every point.

**Isosurfaces.** Marching cubes (Lorensen and Cline 1987) without a hand-typed case table: for a
pattern of inside/outside corners the segments in which the surface crosses each cube face are
joined into closed loops and each loop is triangulated; the triangulations are generated once per
pattern and cached. A face with two diagonally opposite inside corners is ambiguous; it is
resolved from the four corner values by the asymptotic decider (Nielson and Hamann 1991), which
both cubes sharing the face evaluate identically, so the mesh has no cracks. Triangle sides are
never placed inside a cube face (where the neighbour could duplicate them); where that is
impossible the loop is triangulated around one extra vertex inside the cube. Vertices lie on grid
edges and are shared (welded). Normals are the normalised field gradient (central differences,
interpolated along the edge) pointing away from the enclosed region, which is the region above the
isovalue for `isoValue >= 0` and below it for `isoValue < 0`; triangles are counter-clockwise seen
from outside. The function knows nothing about quantum chemistry and is reused for other surfaces.

## Validation

All numbers in this section are produced by the test suite (`QUANTUM_REPORT=1` writes them to
`reports/*.json`) and inserted here by `tools/update-readme.mjs`; none is typed by hand. Deviations
are absolute values in atomic units unless stated otherwise.

### References that were actually used

1. **Crawford group, Programming Projects, Project #3** (reference integrals and SCF output for
   H<sub>2</sub>O and CH<sub>4</sub> in STO-3G), `test/fixtures/crawford/`, fetched from
   `github.com/CrawfordGroup/ProgrammingProjects` at <!-- BEGIN:crawford-meta -->commit `297fda143186f08a3a9481b0fb762f87bbbba524`, retrieved 2026-11-13; PSI3 basis library commit `d6289507905a293b61fcc6257f73812abc5ad0c5`<!-- END:crawford-meta -->
   (`tools/fetch-crawford.mjs`). The upstream repository publishes no licence; the files are
   unmodified copies used only as validation references.
2. **PySCF** run in a `python:3.12-slim` Docker container by `tools/gen_reference.py`,
   `tools/gen_challenging.py` and `tools/gen_large.py`, fixtures
   `test/fixtures/pyscf_reference.json`, `pyscf_challenging.json` and `pyscf_large.json`: <!-- BEGIN:pyscf-meta -->PySCF 2.15.0 (NumPy 2.5.4, Python 3.12.16), fixture generated 2026-11-13T16:48:35Z; 48 systems (40 in a general orientation, 8 of them also axis-aligned), 5 element-wise integral sets, 6 field sets.<!-- END:pyscf-meta -->
   PySCF was given the same Basis Set Exchange snapshot (SP shells split into s and p) and the same
   coordinates in bohr as the engine, so both programs solve the identical problem with independent
   integral (libcint) and SCF codes. The geometries are idealised structures built from round bond
   lengths and angles; they are inputs shared by both programs, not reference data.
3. **mpmath** (same container, `tools/gen_boys_reference.py`): 50-digit values of the Boys function,
   `test/fixtures/boys_reference.json`.

### Integrals

Against the Crawford files, element by element (S, T, V, the dipole integrals and every listed
two-electron integral; integrals the files omit are zero by symmetry and are verified to be zero):

<!-- BEGIN:crawford -->

| Molecule | Basis parameters used by the engine | max \|ΔS\| | max \|ΔT\| | max \|ΔV\| | max \|Δμ-integrals\| | max \|ΔERI\| | E<sub>ref</sub> / E<sub>h</sub> | E / E<sub>h</sub> | \|ΔE\| | \|Δμ\| | \|Δq\| |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H2O | PSI3 library STO-3G (as the reference) | 9.2e-14 | 4.3e-14 | 5.2e-13 | 3.1e-13 | 1.0e-13 | -74.942079928192 | -74.942079928192 | 2.3e-13 | 1.7e-12 | 6.7e-13 |
| CH4 | STO-3G from the reference input file | 1.4e-13 | 8.9e-14 | 1.2e-12 | 2.7e-13 | 2.0e-13 | -39.726850324347 | -39.726850324348 | 1.3e-12 | 9.8e-15 | 4.6e-13 |
| H2O | bundled BSE snapshot | 1.7e-8 | 4.1e-6 | 4.3e-6 | 2.6e-8 | 3.5e-7 | -74.942079928192 | -74.942079954043 | 2.6e-8 | 4.8e-8 | 6.6e-8 |
| CH4 | bundled BSE snapshot | 2.4e-8 | 1.8e-6 | 1.9e-6 | 2.3e-8 | 1.5e-7 | -39.726850324347 | -39.726850313891 | 1.0e-8 | 1.3e-15 | 1.2e-7 |

<!-- END:crawford -->

The references were produced by PSI3 with 7-8 digit STO-3G parameters (its own library for
H<sub>2</sub>O, the values written into `input.dat` for CH<sub>4</sub>). With exactly those
parameters (first two rows) the engine reproduces every integral to about 1e-12 and the SCF
energies to within 2e-12 E<sub>h</sub> of the 12 printed decimals. With the bundled 10-digit Basis
Set Exchange values (last two rows) the largest integrals differ in the 6th decimal, which is the
rounding of the reference's basis-set parameters and not an error of either code: the 1e-8 integral
target is met for identical parameters, and the SCF energies agree to 3e-8 E<sub>h</sub> regardless.

Against PySCF (libcint), element by element, for molecules in a general orientation that include
third-period atoms:

<!-- BEGIN:integrals -->

| Molecule | N<sub>bf</sub> | max \|ΔS\| | max \|ΔT\| | max \|ΔV\| | max \|Δ⟨r⟩\| | unique ERIs compared | max \|ΔERI\| |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LiH | 6 | 2.2e-16 | 4.4e-16 | 1.4e-14 | 4.4e-16 | 231 | 3.5e-15 |
| H2S | 11 | 5.6e-16 | 7.1e-15 | 6.0e-14 | 1.3e-15 | 2211 | 3.6e-15 |
| HCl | 10 | 6.7e-16 | 3.6e-15 | 1.0e-13 | 8.9e-16 | 1540 | 6.6e-15 |
| SiH4 | 13 | 3.3e-16 | 1.4e-14 | 6.4e-14 | 8.9e-16 | 4186 | 6.1e-15 |
| NaCl | 18 | 6.7e-16 | 3.6e-14 | 5.9e-14 | 2.7e-15 | 14706 | 9.4e-15 |

<!-- END:integrals -->

Screening, on a system of three well separated fragments (HF, HF, Ar): <!-- BEGIN:screening -->864 of 1035 shell quartets and 52569 of 66420 primitive quartets skipped; largest change of any integral 2.3e-14 E<sub>h</sub><!-- END:screening -->.

Boys function: <!-- BEGIN:boys -->454 arguments T in [0, 1e+8], m = 0..8, against mpmath 1.4.1: largest relative error 1.3e-15 (at m=1, T=29.737338978518025), largest absolute error 2.2e-16<!-- END:boys -->.

### SCF energies and properties against PySCF

Default settings of `runRhf`; the 21 molecules of the specification, each in a general orientation
(rotated and shifted off the origin):

<!-- BEGIN:pyscf-required -->

| System | N<sub>bf</sub> | E<sub>ref</sub> (PySCF) / E<sub>h</sub> | E (this engine) / E<sub>h</sub> | \|ΔE\| | max \|Δε\| | max \|Δq\| | max \|Δμ\| | SCF iterations | −V/T |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H2 | 2 | -1.1167593075 | -1.1167593075 | 1.7e-14 | 6.7e-14 | 1.3e-15 | 8.9e-16 | 2 | 1.9296 |
| HeH+ | 2 | -2.8417792396 | -2.8417792396 | 8.9e-16 | 1.4e-11 | 1.1e-11 | 1.4e-11 | 5 | 2.1980 |
| LiH | 6 | -7.8620238740 | -7.8620238740 | 8.9e-15 | 4.5e-10 | 1.5e-9 | 3.6e-9 | 7 | 1.9882 |
| H2O | 7 | -74.9629282708 | -74.9629282708 | 3.0e-13 | 1.2e-10 | 1.6e-11 | 5.9e-11 | 8 | 2.0050 |
| NH3 | 8 | -55.4540461803 | -55.4540461803 | 2.4e-13 | 4.8e-11 | 1.3e-10 | 5.9e-11 | 8 | 2.0061 |
| CH4 | 9 | -39.7268101123 | -39.7268101123 | 4.3e-14 | 1.7e-12 | 1.4e-12 | 6.0e-15 | 7 | 2.0069 |
| HF | 6 | -98.5707800579 | -98.5707800579 | 4.3e-14 | 2.0e-11 | 2.5e-11 | 4.8e-11 | 6 | 2.0081 |
| N2 | 10 | -107.4959750814 | -107.4959750814 | 7.2e-13 | 1.6e-11 | 2.7e-13 | 4.7e-13 | 15 | 2.0123 |
| CO | 10 | -111.2245586982 | -111.2245586982 | 9.0e-13 | 9.5e-11 | 4.0e-12 | 5.7e-11 | 13 | 2.0072 |
| CO2 | 15 | -185.0646957270 | -185.0646957270 | 1.3e-12 | 3.7e-9 | 3.8e-9 | 5.5e-13 | 9 | 2.0098 |
| HCN | 11 | -91.6751475555 | -91.6751475555 | 1.1e-13 | 4.0e-9 | 8.2e-9 | 9.0e-9 | 14 | 2.0082 |
| C2H4 | 14 | -77.0720902066 | -77.0720902066 | 4.7e-13 | 8.7e-11 | 3.2e-11 | 4.8e-14 | 9 | 2.0068 |
| C2H2 | 12 | -75.8529053646 | -75.8529053646 | 3.0e-13 | 9.2e-10 | 1.3e-9 | 7.6e-13 | 8 | 2.0048 |
| H2S | 11 | -394.3115475088 | -394.3115475088 | 4.0e-13 | 7.1e-11 | 6.8e-11 | 3.6e-10 | 8 | 2.0119 |
| HCl | 10 | -455.1348351584 | -455.1348351584 | 1.5e-12 | 4.1e-10 | 4.4e-10 | 3.9e-10 | 7 | 2.0180 |
| SiH4 | 13 | -287.9101815046 | -287.9101815046 | 1.1e-13 | 3.7e-10 | 8.7e-10 | 2.2e-14 | 7 | 2.0147 |
| PH3 | 12 | -338.6336159039 | -338.6336159039 | 1.3e-12 | 5.5e-10 | 2.3e-10 | 1.8e-10 | 8 | 2.0130 |
| NH4+ | 9 | -55.8666098182 | -55.8666098182 | 2.6e-13 | 4.6e-11 | 1.7e-11 | 9.3e-15 | 7 | 2.0221 |
| OH- | 6 | -74.0563281893 | -74.0563281893 | 2.8e-14 | 4.1e-11 | 9.1e-12 | 1.4e-10 | 7 | 1.9740 |
| H2CO | 12 | -112.3537981770 | -112.3537981770 | 2.8e-14 | 1.8e-8 | 2.5e-8 | 5.7e-8 | 13 | 2.0088 |
| C6H6 | 36 | -227.8906005490 | -227.8906005490 | 1.3e-12 | 1.2e-9 | 7.4e-10 | 9.3e-14 | 9 | 2.0086 |

<!-- END:pyscf-required -->

Further systems (closed-shell atoms, ions, more third-period molecules):

<!-- BEGIN:pyscf-additional -->

| System | N<sub>bf</sub> | E<sub>ref</sub> (PySCF) / E<sub>h</sub> | E (this engine) / E<sub>h</sub> | \|ΔE\| | max \|Δε\| | max \|Δq\| | max \|Δμ\| | SCF iterations | −V/T |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| He | 1 | -2.8077839566 | -2.8077839566 | 4.4e-16 | 2.2e-16 | 0 | 0 | 2 | 1.9944 |
| Be | 5 | -14.3518804007 | -14.3518804007 | 7.1e-15 | 2.7e-15 | 0 | 1.1e-15 | 2 | 1.9668 |
| Ne | 5 | -126.6045250887 | -126.6045250887 | 8.5e-14 | 1.4e-14 | 0 | 0 | 2 | 2.0083 |
| Mg | 9 | -197.0073545365 | -197.0073545365 | 5.7e-14 | 5.3e-10 | 8.9e-15 | 1.8e-15 | 5 | 2.0125 |
| Ar | 9 | -521.2228808035 | -521.2228808035 | 2.3e-13 | 4.3e-14 | 3.6e-15 | 3.8e-16 | 2 | 2.0170 |
| BeH2 | 7 | -15.5600983547 | -15.5600983547 | 1.4e-14 | 6.9e-12 | 9.3e-12 | 6.8e-15 | 6 | 1.9879 |
| BH3 | 8 | -26.0689957385 | -26.0689957385 | 1.8e-14 | 9.7e-11 | 7.0e-12 | 6.4e-15 | 7 | 1.9922 |
| LiF | 10 | -105.3624598232 | -105.3624598232 | 8.5e-14 | 1.3e-8 | 1.2e-8 | 3.3e-8 | 11 | 2.0087 |
| F2 | 10 | -195.9674344305 | -195.9674344305 | 1.3e-12 | 6.9e-11 | 3.9e-14 | 7.1e-15 | 6 | 2.0130 |
| NaH | 10 | -160.3022175114 | -160.3022175114 | 1.7e-13 | 4.1e-9 | 1.2e-8 | 5.0e-8 | 9 | 2.0212 |
| NaCl | 18 | -614.5241697865 | -614.5241697865 | 2.2e-12 | 3.9e-8 | 6.7e-8 | 1.5e-7 | 8 | 2.0178 |
| MgH2 | 11 | -198.2014281810 | -198.2014281810 | 5.7e-14 | 3.7e-11 | 2.9e-11 | 5.1e-15 | 9 | 2.0163 |
| AlH3 | 12 | -240.7144656347 | -240.7144656347 | 1.1e-13 | 8.8e-10 | 5.6e-10 | 2.1e-15 | 8 | 2.0143 |
| Cl2 | 18 | -909.1116263984 | -909.1116263984 | 2.0e-12 | 1.3e-10 | 1.4e-13 | 3.8e-14 | 6 | 2.0184 |
| CS | 14 | -430.4713011332 | -430.4713011332 | 1.9e-12 | 6.3e-11 | 1.0e-12 | 1.1e-10 | 13 | 2.0102 |
| SO2 | 19 | -540.6020525639 | -540.6020525639 | 2.7e-12 | 1.5e-9 | 3.3e-9 | 6.0e-9 | 11 | 2.0095 |
| H3O+ | 8 | -75.3299739032 | -75.3299739032 | 2.8e-13 | 2.7e-10 | 1.5e-11 | 3.4e-12 | 8 | 2.0204 |
| CN- | 10 | -90.9367988422 | -90.9367988422 | 6.5e-13 | 5.7e-9 | 8.9e-9 | 1.6e-8 | 12 | 1.9859 |
| C2H6 | 16 | -78.3057994117 | -78.3057994117 | 8.5e-14 | 1.4e-10 | 2.6e-10 | 1.2e-14 | 9 | 2.0086 |

<!-- END:pyscf-additional -->

Summary over all runs, including the axis-aligned duplicates, and the same comparison with both
programs converged tightly (1e-12 E<sub>h</sub>, 1e-10 RMS density):

<!-- BEGIN:pyscf-summary -->

| Quantity | Target | Largest deviation, default settings (48 runs) | Largest deviation, tight convergence |
| --- | --- | --- | --- |
| Total energy / E<sub>h</sub> | 1e-6 | 3.0e-12 | 6.0e-12 |
| Orbital energies / E<sub>h</sub> | 1e-5 | 3.9e-8 | 5.4e-10 |
| Mulliken charges / e | 1e-4 | 6.7e-8 | 4.4e-10 |
| Dipole components / e a<sub>0</sub> | 1e-4 | 1.5e-7 | 8.5e-10 |
| Kinetic energy / E<sub>h</sub> | - | 5.1e-7 | 1.1e-9 |
| Nuclear repulsion / E<sub>h</sub> | - | 2.8e-13 | 2.8e-13 |

<!-- END:pyscf-summary -->

Every target tolerance is met by more than two orders of magnitude.

One molecule close to the default size limit, the all-trans alkane C<sub>13</sub>H<sub>28</sub> with
93 basis functions (`tools/gen_large.py`, `test/large.test.ts`), where integral screening is fully
at work: <!-- BEGIN:large-screening -->685529 of 1103355 shell quartets (62 %) were skipped by the Schwarz test and 15410787 of 89371755 primitive quartets (17 %) were evaluated; 15 SCF iterations, and 7 Hessian-vector products for the stability certificate (2120 orbital rotations)<!-- END:large-screening -->.

<!-- BEGIN:large -->

| Quantity | PySCF | this engine | deviation |
| --- | --- | --- | --- |
| Total energy / E<sub>h</sub> | -502.6765917289 | -502.6765917288 | 1.6e-11 |
| Orbital energies / E<sub>h</sub> (largest deviation) |  |  | 7.4e-8 |
| Mulliken charges / e (largest deviation) |  |  | 2.1e-7 |
| Dipole components / e a<sub>0</sub> (largest deviation) |  |  | 1.4e-7 |

<!-- END:large -->

### Systems with more than one SCF solution

For N<sub>2</sub> the engine passes through the same saddle point as PySCF and then leaves it: <!-- BEGIN:stability-n2 -->saddle point at -106.7665938833 E<sub>h</sub> (PySCF from the same guess: -106.7665938833), final -107.4959750814 E<sub>h</sub> (PySCF: -107.4959750814), 15 SCF iterations and 42 Hessian-vector products in total<!-- END:stability-n2 -->. For all reference systems the final solution is confirmed to be a minimum, in agreement with
PySCF's own stability analysis: <!-- BEGIN:stability-all -->the lowest eigenvalue of the orbital-rotation Hessian lies between 0.088 and 1.237 E<sub>h</sub> for the 44 runs with virtual orbitals. The engine spent 1 to 42 Hessian-vector products (Fock builds) per run on the analysis, on top of 2 to 15 SCF iterations<!-- END:stability-all -->.

Harder cases (stretched bonds, biradicaloids). The reference ran PySCF from two starting guesses,
each with and without a level shift, following internal instabilities; its plain DIIS does not
always converge. The engine converges in every case and never ends above PySCF's lowest stable
solution:

<!-- BEGIN:challenging -->

| System | E (this engine) / E<sub>h</sub> | PySCF lowest stable / E<sub>h</sub> | ΔE | saddle points left | SCF iterations | lowest Hessian eigenvalue / E<sub>h</sub> | PySCF runs that converged (of 4) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N2 (1.098 A) | -107.4959750814 | -107.4959750814 | -9.4e-13 | 1 | 15 | 0.2727 | 4 |
| N2 stretched (1.6 A) | -107.2256692629 | -107.2256692629 | 1.4e-14 | 2 | 24 | 0 (zero mode) | 2 |
| N2 stretched (2.5 A) | -106.9342554834 | -106.9342554834 | -2.7e-13 | 2 | 26 | 0 (zero mode) | 1 |
| H2 stretched (2.5 A) | -0.7029436002 | -0.7029436002 | -1.1e-15 | 0 | 2 | 0.6179 | 4 |
| O2 closed-shell singlet | -147.5511274031 | -147.5511274031 | 3.1e-13 | 1 | 15 | 0 (zero mode) | 4 |
| O3 | -221.2887276533 | -221.2887276533 | -2.3e-13 | 0 | 13 | 0.0647 | 4 |
| C2 | -74.4223204970 | none converged (lowest reached -74.42232050) | - | 1 | 20 | 0 (zero mode) | 0 |
| BN | -77.8430505567 | -77.8430505567 | 5.7e-14 | 0 | 13 | 0.0187 | 4 |
| CH2 singlet | -38.3719589094 | -38.3719589094 | -7.1e-14 | 1 | 14 | 0.1156 | 4 |
| P2 | -673.7559803114 | -673.7559803114 | -1.7e-12 | 1 | 16 | 0.0660 | 4 |
| H4 square (1.2 A) | -1.7823613218 | -1.7823613218 | 4.9e-14 | 1 | 12 | 0.1520 | 3 |
| H6 ring (1.5 A) | -2.8187573494 | -2.8187573494 | 2.8e-14 | 0 | 2 | 0.1980 | 4 |
| H2O stretched (2.0 A) | -74.4008428356 | -74.4008428356 | -2.8e-14 | 0 | 39 | 0.0179 | 2 |
| LiH stretched (4.0 A) | -7.6249756798 | -7.6249756798 | -5.3e-15 | 0 | 11 | 0.1348 | 4 |
| NO+ | -127.1860746955 | -127.1860746955 | 1.1e-13 | 0 | 13 | 0.2821 | 4 |
| F2 stretched (2.2 A) | -195.6716263866 | -195.6716263866 | -5.7e-14 | 2 | 11 | 0.0379 | 2 |
| C2H4 twisted 90 deg | -76.8561493600 | -76.8561493600 | -2.6e-13 | 0 | 14 | 0.1084 | 2 |

<!-- END:challenging -->

A stable closed-shell solution is a local minimum; it is not guaranteed to be the global one, and
for several of these systems (O<sub>2</sub>, stretched bonds) a closed-shell wavefunction is a poor
model in the first place.

**How the stability analysis itself was checked** (`test/stability.test.ts`). Its verdict decides
whether the SCF stops or leaves a saddle point, so the eigenvalue search behind it was compared with
full diagonalisations of the orbital-rotation Hessian, at every final solution and at every saddle
point passed on the way:

<!-- BEGIN:stability-validation -->

| Compared with a full diagonalisation | Result |
| --- | --- |
| Hessians diagonalised (final solutions / saddle points passed on the way) | 75 (61 / 14), 1 to 315 orbital rotations |
| lowest eigenvalue at the final solutions / E<sub>h</sub> | -6.1e-10 to 1.2367 |
| lowest eigenvalue at the saddle points / E<sub>h</sub> | -0.3540 to -0.0025 |
| verdict of the engine (stable or not) correct | 75 of 75; 59 of them decided by full diagonalisation inside the engine |
| verdict of the iterative search, forced on every size, correct | 75 of 75 |
| largest amount by which the iterative search fell below the true lowest eigenvalue | 6.6e-16 |
| largest error of the unstable eigenvalue it converged | 8.5e-9 |
| its Hessian-vector products at stable solutions (median / largest) | 7 / 28 |
| its Hessian-vector products at saddle points (median / largest) | 9 / 16 |
| solutions at which it set a zero mode aside | N2 stretched (1.6 A) (24 products), O2 closed-shell singlet (22 products), C2 (28 products) |
| 300 random symmetric matrices with blocks that do not couple (156 with, 144 without a negative eigenvalue) | 0 wrong verdicts, 0 unfinished searches; 7.8 products on average, at most 24 |

<!-- END:stability-validation -->

A zero eigenvalue is not an instability. It appears where the closed-shell solution of a linear
molecule occupies one of two degenerate π directions and can therefore be turned about the axis at
no cost in energy. The test checks that zero modes occur exactly there. They do, in <!-- BEGIN:stability-zero-modes -->N2 stretched (1.6 A), N2 stretched (2.5 A), O2 closed-shell singlet, C2: the two p populations perpendicular to the axis differ by 0.08 to 2.00 electrons there, and by at most 4.7e-6 in the other 7 linear molecules of the set at the default convergence thresholds (at most 3.2e-12 once the SCF is converged to 1e-11 E<sub>h</sub> in the energy and 1e-9 in the density)<!-- END:stability-zero-modes -->. The figure for the default
thresholds is a convergence residual, not symmetry breaking: the SCF stops when the energy changes
by less than 1e-9 E<sub>h</sub> and the density by less than 1e-7 (RMS) per iteration, and a soft
mode can then still carry a density error of a few 1e-6. P<sub>2</sub>, whose iterations pass a
symmetry-broken saddle point, is the case that shows it; its energy agrees with PySCF to 2e-12
E<sub>h</sub> all the same. Density-matrix elements, Mulliken charges and fields should therefore be
read as converged to about 1e-5 at the default thresholds; tighten `energyTolerance` and
`densityTolerance` where more is needed.

### Internal consistency (`test/scf.test.ts`)

C<sup>T</sup>SC = I to 1e-11; P = 2C<sub>occ</sub>C<sub>occ</sub><sup>T</sup> to 1e-12; tr(PS) equals
the electron count and the Mulliken charges sum to the molecular charge to 1e-10; the energy
components add up; rotating and translating a molecule changes the total energy by less than 1e-10
E<sub>h</sub> (observed below 4e-13) and rotates the dipole vector; the two-electron Fock builder
equals a brute-force n⁴ contraction to 1e-11; the Hessian-vector product of the stability analysis
equals the explicitly built Hessian to 1e-10; the virial ratio −V/T is reported (last column of the
tables above; it deviates from 2 because STO-3G exponents are fixed, most for H<sub>2</sub> and
HeH<sup>+</sup>).

### Fields

Density, molecular orbitals (compared up to sign, non-degenerate ones only) and electrostatic
potential at 30 points per molecule (24 near the molecule, 6 up to 160 Å away) against PySCF, in
double precision:

<!-- BEGIN:fields -->

| Molecule | points | max \|Δρ\| / e a<sub>0</sub><sup>-3</sup> | max \|Δψ\| / a<sub>0</sub><sup>-3/2</sup> (orbitals compared) | max \|ΔV\| / E<sub>h</sub> e<sup>-1</sup> |
| --- | --- | --- | --- | --- |
| LiH | 30 | 4.0e-12 | 4.6e-11 (4) | 5.1e-11 |
| H2O | 30 | 2.2e-12 | 1.3e-11 (7) | 1.4e-11 |
| C2H4 | 30 | 4.0e-14 | 1.5e-12 (12) | 5.6e-13 |
| HCl | 30 | 1.5e-12 | 1.6e-11 (6) | 2.1e-11 |
| NH4+ | 30 | 4.7e-14 | 4.0e-14 (3) | 1.9e-12 |
| OH- | 30 | 4.3e-13 | 9.6e-12 (4) | 1.5e-11 |

<!-- END:fields -->

Skipping negligible primitives: <!-- BEGIN:field-screening -->largest change 6.4e-11 e/a<sub>0</sub><sup>3</sup> in double precision at the grid points of a water grid (largest density there 9.28); 1.2e-10 between the single-precision grids<!-- END:field-screening -->.

**Numerical integration of the density grid.** Summing ρ over a regular grid recovers the electron
count essentially exactly for H<sub>2</sub>. With a second-period atom the 1s core density is a
spike about 0.05 Å wide, which a regular grid resolves only when its spacing is that small; at the
default 0.2 Å spacing the sum is 5 % low for water. This is a property of the quadrature, not of the
density (its point values agree with PySCF to 1e-11 and its analytic integral tr(PS) is exact), but
it means electron counts must not be taken from coarse grids:

<!-- BEGIN:electron-count -->

| Molecule | grid spacing / Å | grid points | integrated electrons | exact | error |
| --- | --- | --- | --- | --- | --- |
| H2 | 0.2 | 83248 | 1.999998 | 2 | -1.9e-6 |
| H2 | 0.1 | 628488 | 2.000000 | 2 | -1.4e-9 |
| CH4 | 0.1 | 941094 | 10.041679 | 10 | 4.2e-2 |
| H2O | 0.2 | 94815 | 9.494158 | 10 | -5.1e-1 |
| H2O | 0.1 | 718080 | 9.792077 | 10 | -2.1e-1 |
| H2O | 0.05 | 5583312 | 9.995275 | 10 | -4.7e-3 |

<!-- END:electron-count -->

The same holds for orbitals: for water <!-- BEGIN:orbital-integrals -->at 0.25 Å the norms of HOMO, LUMO and HOMO-1 integrate to 1.0050, 1.0091, 0.9873; at 0.1 Å to 1.00000000, 0.9986, 0.9990 (overlaps 5.7e-6 and 4.5e-6)<!-- END:orbital-integrals -->.

**Electrostatic potential far away.** For neutral water the potential tends to zero as the dipole
potential μ·n/r²; the remaining difference is the quadrupole term and decays one power of r faster
((1 − ratio)·r is constant to 2 %):

<!-- BEGIN:far-field -->

| distance / Å | V / E<sub>h</sub> e<sup>-1</sup> | dipole term μ·n/r² / E<sub>h</sub> e<sup>-1</sup> | ratio |
| --- | --- | --- | --- |
| 5 | 1.5e-3 | 1.9e-3 | 0.7836 |
| 10 | 4.2e-4 | 4.8e-4 | 0.8941 |
| 20 | 1.1e-4 | 1.2e-4 | 0.9473 |
| 50 | 1.9e-5 | 1.9e-5 | 0.9789 |
| 100 | 4.7e-6 | 4.8e-6 | 0.9895 |
| 200 | 1.2e-6 | 1.2e-6 | 0.9947 |

<!-- END:far-field -->

For ions V·r tends to the charge (the deviation is the dipole about the centre of nuclear charge
divided by r):

<!-- BEGIN:far-field-ions -->

| Ion | V·r at 10 Å | V·r at 30 Å | V·r at 100 Å | V·r at 300 Å |
| --- | --- | --- | --- | --- |
| NH4+ | 0.99974 | 0.99999 | 1.00000 | 1.00000 |
| OH- | -1.00220 | -1.00073 | -1.00022 | -1.00007 |
| HeH+ | 0.98039 | 0.99344 | 0.99803 | 0.99934 |

<!-- END:far-field-ions -->

Pipeline check, the 0.002 e/a<sub>0</sub>³ density isosurface of benzene coloured by potential: <!-- BEGIN:benzene-surface -->5168 triangles at 0.25 Å (enclosed volume 87.4 Å³, area 108.1 Å², density at the vertices within 3.1e-4 of the isovalue) and 20588 triangles at 0.125 Å (86.7 Å³, 107.4 Å², 9.0e-5); potential on the surface from -0.0166 to 0.0216 E<sub>h</sub>/e<!-- END:benzene-surface -->.

### Marching cubes

Analytic sphere of radius R (exact area 4πR², volume 4πR³/3); every mesh is closed (each edge
shared by exactly two triangles with opposite directions) with Euler characteristic 2:

<!-- BEGIN:marching-cubes -->

| Field | vertices | triangles | area error | volume error | min normal·radial | min face-normal·radial |
| --- | --- | --- | --- | --- | --- | --- |
| sphere, spacing R/10 | 1830 | 3656 | -0.32 % | -0.61 % | 0.999998 | 0.9985 |
| sphere, spacing R/20 | 7470 | 14936 | -0.08 % | -0.15 % | 1.000000 | 0.9996 |
| sphere, anisotropic spacing | - | - | -0.35 % | -0.67 % | 0.999991 | 0.9975 |

<!-- END:marching-cubes -->

Also verified: a torus (Euler characteristic 0, area and volume within 2 %), two separate spheres,
both lobes of a p-like field with ±isovalue, a negative isovalue, a field whose surface passes
exactly through grid points, NaN values, a surface that leaves the grid (it ends there with boundary
edges and no non-manifold edge), and uniform noise, which exercises every ambiguous configuration: <!-- BEGIN:marching-cubes-noise -->isovalue 0: 190694 triangles, 0 boundary edges, 0 non-manifold edges, 0 inconsistently oriented edges; isovalue 0.3: 155018 triangles, 0 boundary edges, 0 non-manifold edges, 0 inconsistently oriented edges; isovalue -0.3: 163270 triangles, 0 boundary edges, 0 non-manifold edges, 0 inconsistently oriented edges<!-- END:marching-cubes-noise -->. The case generator is checked exhaustively: <!-- BEGIN:marching-cubes-cases -->656 combinations of corner pattern and ambiguous-face resolution, at most 12 triangles per cube, 116 of them triangulated around an extra centre vertex<!-- END:marching-cubes-cases -->.

## Performance

Measured with `tools/bench.ts`, which runs the engine as native ES modules in plain Node, the way a
bundled browser build runs it: <!-- BEGIN:performance-meta -->Intel(R) Core(TM) Ultra 7 165H (22 logical processors), Node v24.14.1, single (main thread); 6 complete benchmark runs, each in a fresh process, on 2026-11-13. While they ran, the machine as a whole (all processors, all processes) was 69 % to 77 % busy; the single-threaded benchmark itself accounts for 4.5 % of that<!-- END:performance-meta -->. The machine was shared with other workloads during every measurement, so the numbers scatter
from run to run and are upper bounds for a quiet machine. The first two tables are the run with
the smallest total time; the spread over all runs follows. "Best" is the fastest of several
repetitions within a run; "first call" includes JIT warm-up in a fresh process and is what the
first calculation in a new worker costs.

<!-- BEGIN:performance -->

| System | N<sub>bf</sub> | first call / ms | best / ms | integrals / ms | SCF / ms | SCF iterations | estimatedSeconds × 1000 | measured / estimated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H2O | 7 | 34.8 | 1.26 | 0.76 | 0.46 | 8 | 1.81 | 0.70 |
| CH4 | 9 | 17.2 | 4.11 | 1.96 | 2.07 | 7 | 3.04 | 1.35 |
| C2H4 | 14 | 23.5 | 16.4 | 12.1 | 4.04 | 9 | 9.51 | 1.72 |
| SO2 | 19 | 67.2 | 20.4 | 12.4 | 7.88 | 11 | 20.6 | 0.99 |
| C6H6 | 36 | 356 | 244 | 172 | 71.4 | 9 | 241 | 1.01 |
| C4H10 | 30 | 362 | 237 | 160 | 77.1 | 11 | 146 | 1.63 |
| C6H14 | 44 | 964 | 766 | 533 | 232 | 12 | 609 | 1.26 |
| C8H18 | 58 | 2355 | 1408 | 957 | 451 | 14 | 1745 | 0.81 |
| C10H22 | 72 | 2598 | 2555 | 1360 | 1195 | 16 | 4008 | 0.64 |
| C13H28 | 93 | 6881 | 6242 | 3222 | 3019 | 15 | 10813 | 0.58 |

<!-- END:performance -->

The alkanes are all-trans chains; C<sub>13</sub>H<sub>28</sub> is close to the default limit of 96
basis functions. Targets: water under 50 ms, methane under 100 ms, benzene under 15 s (ideally 5 s).

<!-- BEGIN:performance-fields -->

| Operation (benzene, 36 basis functions) | time |
| --- | --- |
| electron density on 64³ = 262144 points (spacing 0.171 Å) | 285 ms (first call 371 ms) |
| one molecular orbital on the same grid | 66.0 ms |
| marching cubes on that grid (isovalue 0.02: 3728 vertices, 7452 triangles) | 13.6 ms |
| electrostatic potential at the 3728 surface vertices | 437 ms (117 µs per point) |
| electron density on the default grid of createGrid (45 × 50 × 55 = 123750 points, 0.2 Å) | 185 ms |

<!-- END:performance-fields -->

Target: density on 64³ points for benzene under 2 s.

Spread between the runs (every run is kept in `reports/bench-runs/`):

<!-- BEGIN:performance-spread -->

| Quantity | run reported above | smallest | median | largest |
| --- | --- | --- | --- | --- |
| H2O, best / ms | 1.26 | 0.99 | 1.70 | 2.25 |
| CH4, best / ms | 4.11 | 3.22 | 4.07 | 5.13 |
| C2H4, best / ms | 16.4 | 8.77 | 13.9 | 17.5 |
| SO2, best / ms | 20.4 | 14.6 | 22.2 | 27.4 |
| C6H6, best / ms | 244 | 227 | 254 | 455 |
| C4H10, best / ms | 237 | 160 | 220 | 292 |
| C6H14, best / ms | 766 | 473 | 721 | 915 |
| C8H18, best / ms | 1408 | 1309 | 1513 | 2228 |
| C10H22, best / ms | 2555 | 2206 | 2620 | 3325 |
| C13H28, best / ms | 6242 | 5242 | 6362 | 7512 |
| H2O, first call / ms | 34.8 | 29.7 | 45.3 | 56.0 |
| CH4, first call / ms | 17.2 | 13.2 | 19.6 | 35.4 |
| C6H6, first call / ms | 356 | 248 | 364 | 479 |
| benzene, density on 64³ points, best / ms | 285 | 194 | 261 | 319 |
| benzene, one orbital on 64³ points, best / ms | 66.0 | 40.9 | 54.8 | 66.0 |
| benzene, marching cubes on 64³ points, best / ms | 13.6 | 7.41 | 10.0 | 13.6 |
| benzene, potential, µs per point | 117 | 72.3 | 93.7 | 131 |
| whole-machine CPU utilisation during the run / % | 69.2 | 69.2 | 72.8 | 76.5 |

<!-- END:performance-spread -->

A warm engine meets every target with a wide margin in every run. The very first water calculation
in a fresh process, which includes JIT compilation of the whole engine, is close to the 50 ms
target on this loaded machine and exceeded it in some runs (row "H2O, first call").

Under Vitest (`test/performance.test.ts`, which asserts the targets on the best of several runs)
the same code is somewhat slower because of the test runner's module system: <!-- BEGIN:performance-vitest -->water 2.54 ms (first call 67.2 ms), methane 5.37 ms, benzene 486 ms, benzene density on 64³ points 295 ms<!-- END:performance-vitest -->.

**`estimatedSeconds`.** `checkSupport` predicts the run time from a cost model: the number of
primitive quartets in each of the six classes of two-electron integrals times a cost per quartet,
plus a typical number of Fock builds over the n⁴/8 stored integrals and the O(n³) linear algebra of
the iterations. The constants are rounded values typical of earlier runs of the same benchmark on
this machine and were then left alone; the table compares them with what the runs above measured:

<!-- BEGIN:performance-kernel -->

| Building block | run reported above | range over 6 runs | value in the cost model |
| --- | --- | --- | --- |
| two-electron integrals (ss|ss), ns per primitive quartet | 24.9 | 24.3 - 30.2 | 20 |
| two-electron integrals (s-sp|ss), ns per primitive quartet | 78.0 | 78.0 - 125 | 80 |
| two-electron integrals (s-sp|s-sp), ns per primitive quartet | 207 | 171 - 301 | 180 |
| two-electron integrals (sp-sp|ss), ns per primitive quartet | 135 | 129 - 226 | 135 |
| two-electron integrals (sp-sp|s-sp), ns per primitive quartet | 249 | 249 - 543 | 300 |
| two-electron integrals (sp-sp|sp-sp), ns per primitive quartet | 1334 | 1334 - 2310 | 1200 |
| Fock build, ns per stored integral (n = 36) | 7.34 | 7.34 - 18.3 | 8 (28 builds) |
| Fock build, ns per stored integral (n = 72) | 9.62 | 9.30 - 15.7 | 8 (28 builds) |
| Fock build, ns per stored integral (n = 96) | 14.2 | 7.85 - 15.2 | 8 (28 builds) |
| Jacobi diagonalisation, ns per n³ (n = 36) | 26.5 | 26.5 - 64.4 | part of 60 per n³ and iteration (12 iterations) |
| Jacobi diagonalisation, ns per n³ (n = 72) | 24.7 | 24.7 - 50.0 | part of 60 per n³ and iteration (12 iterations) |
| Jacobi diagonalisation, ns per n³ (n = 96) | 47.9 | 29.0 - 53.2 | part of 60 per n³ and iteration (12 iterations) |

<!-- END:performance-kernel -->

Integral screening is ignored, so the estimate is an upper bound for extended molecules (compare
the last column of the first table); under load, on slower hardware or in other browsers expect a
factor of two or more. It is a rough guide, not a guarantee.

## Limitations and unsupported cases

Rejected by `checkSupport` / `runRhf` with a reason (see `test/support.test.ts`):

- no atoms; atomic numbers that are not positive integers; elements beyond argon (Z > 18);
- an odd number of electrons: open-shell systems (radicals, most atoms) are not implemented;
- a negative number of electrons, or none; a non-integer charge; non-finite coordinates;
- more electron pairs than the minimal basis has functions (e.g. He<sup>2−</sup>);
- more basis functions than the limit (default 96, `maxBasisFunctions`), and in any case more than
  128, where the integral table would exceed 273 MB;
- nuclei closer than 0.1 Å.

Limitations of what is computed:

- **Closed-shell RHF only.** No UHF/ROHF. Even-electron systems with an open-shell ground state
  (O<sub>2</sub>, biradicals, strongly stretched bonds) are computed as closed-shell singlets, which
  is a poor model for them. Only internal (closed-shell) stability is checked: instabilities
  towards spin-unrestricted solutions are not, and PySCF reports them in this basis for, among
  others, benzene, ethylene, acetylene, HCN, formaldehyde, F<sub>2</sub>, SO<sub>2</sub> and Be.
- **Minimal basis.** STO-3G gives qualitatively reasonable orbitals, densities and potentials but
  not quantitative energies, dipoles or charges; there are no polarisation or diffuse functions
  (anions and third-period elements are described poorly). No electron correlation, no relativistic
  effects, no solvent; fixed nuclei, gas phase.
- **Single points only.** No gradients, geometry optimisation or vibrational frequencies.
- **Size and speed.** Conventional SCF with all integrals in memory (87 MB at 96 basis functions),
  single-threaded and synchronous. The stability analysis adds Fock builds to every calculation
  (see the numbers under "Systems with more than one SCF solution").
- **A stable solution is a local minimum**, not necessarily the lowest closed-shell solution.
- **Mulliken charges** depend strongly on the basis set; the **dipole of an ion** depends on the
  origin (centre of nuclear charge here).
- **Fields** are returned in single precision; primitives contributing less than 1e-10 to a basis
  function are skipped; the potential is infinite at nuclei and costs (number of points) ×
  (number of primitive products). Electron counts from regular grids are unreliable unless the
  spacing is about 0.05 Å (see above).
- **Marching cubes** does not cap surfaces that run into the grid boundary; where a surface passes
  exactly through a grid point several distinct vertices coincide there; ambiguities inside a cube
  (as opposed to on its faces) are not analysed; normals come from finite differences of the grid
  values.
- **`estimatedSeconds`** is rough (see above).
- **Validation scope.** The references are other programs running the same method in the same
  basis. That verifies the implementation, not how close RHF/STO-3G is to experiment.

Not done: open-shell methods, larger basis sets and d functions, analytic gradients, integral-direct
SCF for larger systems, multi-threading or WebAssembly/WebGPU acceleration, capping of clipped
surfaces. Timings could not be taken on an idle machine.

## Reproducing

```powershell
# from the repository root, in a shell prepared with .\env.ps1
tsc --noEmit -p packages/quantum
vitest run --project quantum
$env:QUANTUM_REPORT = '1'; vitest run --project quantum                       # also writes reports/*.json

node --import ./packages/quantum/tools/ts-loader.mjs packages/quantum/tools/bench.ts --write
node packages/quantum/tools/update-readme.mjs                                # refresh the tables above

node packages/quantum/tools/fetch-basis.mjs                                  # re-download the BSE snapshot (--use-system-ca behind a TLS proxy)
node packages/quantum/tools/build-basis.mjs                                  # regenerate src/basis/sto3g.generated.ts
node packages/quantum/tools/fetch-crawford.mjs                               # re-download the Crawford and PSI3 fixtures
docker run --rm -e OMP_NUM_THREADS=2 -v "${PWD}\packages\quantum:/work" python:3.12-slim bash -c "pip install -q pyscf mpmath && cd /work/tools && python gen_boys_reference.py && python gen_reference.py && python gen_challenging.py && python gen_large.py"
```

Layout: `src/` engine (`basis/`, `math/`, `integrals/`, `scf/`, `fields/`, `mesh/`), `test/` tests
and `test/fixtures/` references, `data/` basis-set snapshot, `tools/` generators and benchmark,
`reports/` the measurements quoted in this file.

## Literature

Bibliographic data of every entry with a DOI were checked against its Crossref record
(2026-11-13); the two STO-3G papers are the references the Basis Set Exchange lists for this basis.

- S. F. Boys, Proc. R. Soc. Lond. A 200, 542-554 (1950). doi:10.1098/rspa.1950.0036
- E. R. Davidson, J. Comput. Phys. 17, 87-94 (1975). doi:10.1016/0021-9991(75)90065-0
- M. Häser, R. Ahlrichs, J. Comput. Chem. 10, 104-111 (1989). doi:10.1002/jcc.540100111
- W. J. Hehre, R. F. Stewart, J. A. Pople, J. Chem. Phys. 51, 2657-2664 (1969). doi:10.1063/1.1672392
- W. J. Hehre, R. Ditchfield, R. F. Stewart, J. A. Pople, J. Chem. Phys. 52, 2769-2773 (1970). doi:10.1063/1.1673374
- T. Helgaker, P. Jørgensen, J. Olsen, Molecular Electronic-Structure Theory, Wiley (2000). doi:10.1002/9781119019572
- C. G. J. Jacobi, J. reine angew. Math. 30, 51-94 (1846). doi:10.1515/crll.1846.30.51
- W. E. Lorensen, H. E. Cline, ACM SIGGRAPH Comput. Graph. 21(4), 163-169 (1987). doi:10.1145/37402.37422
- P.-O. Löwdin, J. Chem. Phys. 18, 365-375 (1950). doi:10.1063/1.1747632
- L. E. McMurchie, E. R. Davidson, J. Comput. Phys. 26, 218-231 (1978). doi:10.1016/0021-9991(78)90092-X
- R. S. Mulliken, J. Chem. Phys. 23, 1833-1840 (1955). doi:10.1063/1.1740588
- G. M. Nielson, B. Hamann, Proc. IEEE Visualization '91, 83-91 (1991). doi:10.1109/VISUAL.1991.175782
- S. Obara, A. Saika, J. Chem. Phys. 84, 3963-3974 (1986). doi:10.1063/1.450106
- B. P. Pritchard, D. Altarawy, B. Didier, T. D. Gibson, T. L. Windus, J. Chem. Inf. Model. 59, 4814-4820 (2019). doi:10.1021/acs.jcim.9b00725
- P. Pulay, Chem. Phys. Lett. 73, 393-398 (1980). doi:10.1016/0009-2614(80)80396-4
- P. Pulay, J. Comput. Chem. 3, 556-560 (1982). doi:10.1002/jcc.540030413
- C. C. J. Roothaan, Rev. Mod. Phys. 23, 69-89 (1951). doi:10.1103/RevModPhys.23.69
- R. Seeger, J. A. Pople, J. Chem. Phys. 66, 3045-3050 (1977). doi:10.1063/1.434318
- Q. Sun et al., "Recent developments in the PySCF program package", J. Chem. Phys. 153 (2020). doi:10.1063/5.0006074
- T. D. Crawford et al., Programming Projects, https://github.com/CrawfordGroup/ProgrammingProjects
