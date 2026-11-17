# Scientific limitations

This page says what each result in MATTER LAB is, how far it can be trusted, and what the
application does not do. The package READMEs give the detail and the measured numbers:
[core](../packages/core), [forcefield](../packages/forcefield/README.md),
[quantum](../packages/quantum/README.md), [reactions](../packages/reactions/README.md),
[science service](../services/science/README.md).

## How results are labelled

| Label | Meaning | Examples |
| --- | --- | --- |
| Reference data | Taken from a cited source | atomic weights, nuclide masses and half-lives, formation enthalpies, rate parameters |
| Computed | The result of a stated method on this structure | UFF geometry, Hartree-Fock energy and fields, RDKit identifiers |
| Rule-based | A simple rule with known limits | typical bond lengths from covalent radii, valence checks, nuclear radius r0 A^(1/3) |
| Illustrative | A picture that is not data | sphere sizes and colours, the reaction chamber, the nucleus view |
| User input | Entered by the user, not verified | drawn positions, bond orders, evidence entered in the Vault |
| Unsupported | The engine cannot treat the system, with the reason | a radical in Hartree-Fock, an element UFF has no type for |

A calculation that fails or does not converge is reported as such. Results belong to the exact
structure they were computed for and disappear when it is edited.

## Atoms and nuclei

- Element, isotope and charge are bookkeeping on the proton, neutron and electron counts. Any
  combination can be entered; combinations outside the evaluated nuclear data are marked as
  hypothetical and only their mass number is known.
- Nuclide data (masses, abundances, half-lives, decay modes) are the IAEA Live Chart ground-state
  values (ENSDF, AME2020, NUBASE2020). Excited states and isomers are not included.
- Ground-state electron configurations of neutral atoms are tabulated reference data (predicted, and
  marked so, for the heaviest elements). For ions they are estimated by the textbook rules and
  labelled rule-based.
- **The nucleus view is a picture.** It takes from data the number of protons and neutrons, the size
  of a nucleon (the proton's charge radius) and roughly the size of the nucleus. The positions of the
  spheres, and which sphere is a proton, are arbitrary. Nothing nuclear is simulated: no decay, no
  reactions, no shell structure.
- Electrons are never drawn as orbiting particles. Orbitals and densities are shown only when
  computed.

## Structures and validation

- The rule-based check uses a valence model (the same as RDKit's), overlap and bond-length rules.
  Passing it means the drawing is well-formed. It does not mean the compound is stable or can be made.
- RDKit (compiled to WebAssembly) gives a second, independent verdict and the identifiers (SMILES,
  InChI, InChIKey). Stereochemistry in the identifiers is read from the 3D coordinates.
- Typical bond lengths are sums of covalent radii scaled for bond order: good to a few hundredths of
  an ångström for common organic bonds, less elsewhere.
- Hydrogens are placed at idealised positions. They are starting points, not predictions.

## Geometry optimisation (Universal Force Field)

- UFF is a generic classical model. Geometries are approximate (bond lengths typically within a few
  hundredths of an ångström, angles within a few degrees for ordinary organic molecules; for water
  it gives O-H 0.990 Å against a measured 0.958 Å).
- **No electrostatics and no hydrogen-bond term.** Charged groups, hydrogen bonds and complexes
  between molecules are not described. Separate molecules do not interact at all.
- The result is the local minimum nearest the start, not the most stable conformer. No conformer
  search is done in the browser.
- The energy is a strain measure for one bonding pattern. It cannot be compared between different
  molecules and says nothing about whether a compound can exist.
- Elements and valences without a UFF type are refused with the reason (for example noble gases,
  sulfur in SF6). Only 42 of the 127 UFF atom types are exercised by the validation set.
- Bonds never form or break.

## Electronic structure (restricted Hartree-Fock, STO-3G)

- Closed-shell molecules of hydrogen to argon, up to 96 basis functions (about C13H28). Radicals,
  heavier elements and larger molecules are refused with the reason.
- **No electron correlation and a minimal basis.** Orbital shapes and ordering, the form of the
  density and the sign of the electrostatic potential are qualitatively right. Energies, energy
  differences, dipole moments and charges are rough: reaction and conformer energies can be wrong by
  tens of kJ/mol, and for water the dipole comes out at 1.71 D against a measured 1.85 D.
- Even-electron systems with an open-shell ground state (O2, stretched bonds) are computed as
  closed-shell singlets, which is a poor model for them.
- The local RHF solver computes single points at the drawn geometry. The separate connected
  GFN2-xTB service can optimize geometry and report Cartesian forces; it is a semiempirical model,
  not an extension of the local RHF wavefunction. Frequencies and excited-state dynamics are absent.
- Mulliken charges are a bookkeeping convention that depends strongly on the basis set.
- The implementation itself is verified: energies agree with PySCF to 1e-8 hartree on 48 systems.
  That checks the arithmetic, not how close the model is to experiment.
- Surfaces are triangle meshes on a grid of 0.14 Å: areas and volumes are low by a fraction of a
  percent to a few percent and are shown to three significant figures. The "molecular surface" is a
  union of van der Waals spheres (optionally grown by a 1.4 Å probe), not a quantum-mechanical
  surface.
- Volume display includes ray-marched real scalar grids, dot clouds and cutting planes. Optical
  opacity is an illustrative transfer function, not measured absorption or a count of electrons.
  The grid and bounded ray sampling limit spatial resolution; sharp nuclear peaks are not resolved.
- Pinned comparison views retain two computed snapshots. Energy differences are offered only for
  matching elemental composition, charge and electron count, and are not experimental stability claims.

## Instrument laboratory and titration

- Apparatus coordinates are meters, never the angstrom coordinates of the molecular editor.
  Volumes are liters, analytical inventory is moles, concentrations mol/L and temperature kelvin.
- The only inventory writer is the event runtime. Transfers conserve volume and each analytical
  component; preparation, reset and import have explicit recorded meanings. Displayed droplets
  never add or remove liquid.
- Acid/base results solve mass balance and electroneutrality with water autoionization. The
  supported temperature is 298.15 K, with ideal activities; higher ionic strength has stated limits.
  Strong monoprotic acid/base and one weak acetate or ammonia family are supported. Polyprotic
  chemistry, mixed weak families, unmodeled calorimetry/conductivity and arbitrary products are refused.
- Indicator colors use solver-provided fractions and source metadata, but the color anchors are
  illustrative. Endpoint is a learner-selected operational observation, distinct from equivalence.
- Glassware is original calibrated procedural geometry, not certified real apparatus. Upright
  calibration neglects wetting films, thermal expansion and outlet dead volume. Droplets and
  stirring motion are illustrative, not fluid dynamics.
- A saved learning notebook is client evidence, not authenticated experimental proof. Server
  replays use the same pinned runtime and solver and persist their own immutable results.

## Reactions

- **The application never predicts whether or how substances react.** The user states reactants and
  products; the engine checks conservation, balances, and evaluates what its data cover.
- Thermodynamics: 175 species at 298.15 K (CODATA key values, NIST Chemistry WebBook). Gibbs
  energies and equilibrium constants at other temperatures assume constant enthalpy and entropy.
  There are no heat capacities, phase transitions, activities, concentrations at equilibrium or
  electrode potentials. A reaction with a species outside the table is reported as not evaluable;
  nothing is estimated.
- Kinetics: eight gas-phase reactions with IUPAC-evaluated Arrhenius parameters, each within its
  stated temperature range. No mechanisms, no solution kinetics, no catalysis, no combustion
  kinetics, no pressure dependence.
- Catalyst, solvent, pressure and environment can be entered and are recorded with the experiment.
  A catalyst and a solvent change no computed number, and thermodynamic values are standard-state
  (1 bar) values whatever pressure is entered; the result says so each time. Pressure and
  environment only decide whether a sourced rate law applies at all.
- **The reaction chamber is illustrative.** Molecules are shown before and after in the proportions
  of the balanced equation and, where a rate law exists, change with the computed conversion. Their
  positions are not a simulation, no trajectories are computed, and the view is labelled accordingly.
- Energy diagrams show the computed reaction enthalpy and Gibbs energy. A barrier is drawn only
  where a sourced rate law with a positive Arrhenius activation energy was used; it is that
  empirical activation energy, not a computed transition state.
- Molecule models in the chamber are PubChem3D conformers (computed, MMFF94s) or, where PubChem has
  none, UFF geometries built from PubChem's bonding. Extended solids are not drawn as molecules.

## Finding compounds

- A PubChem lookup by name returns what PubChem lists under that name. An empty answer says nothing
  about whether a compound exists.
- A model built from SMILES is one UFF minimum reached from a flat drawing. Its stereochemistry is
  checked against the SMILES centre by centre; a model that cannot be given the stated configuration
  is withheld. This fails for some polycyclic compounds (morphine, for one) and for sulfoxides.
  Stereocentres the SMILES leaves open come out arbitrarily, and that is stated.
- Similarity is the Tanimoto coefficient of Morgan fingerprints. For very small molecules the scores
  are low even between close relatives.

## Discovery Vault

- A candidate is a structure put forward for investigation. **A search that finds no match says
  only which catalogues were searched and when.** Two are searched: the 63 structures built into the
  application and, if the user asks, PubChem. Other databases and the literature are not.
- "Computationally plausible" means a calculation for the structure converged. It does not mean the
  compound can be made.
- Experimental observations and independent validations are recorded as the user states them, with
  a reference; the application cannot verify them.
- An imported report is checked for form, its identifiers are derived again from its structure, and
  its status is cut back to what the searches and evidence in the file carry. The file is not
  otherwise authenticated.

## Rendering

- Atom spheres, colours (Jmol convention) and sticks are a model. Real atoms have no surface.
- Depth cues (ambient occlusion, fog, bloom) are for legibility and carry no data.

## Outside the scope by design

No nuclear reactions or decay simulation, no synthesis planning, no toxicity, efficacy or safety
prediction, no weapons-relevant workflows. Pharmaceutical molecules can be drawn and analysed like
any other structure; no result is a statement about a drug.
