import { atomLabel, composition, formatCharge, formatFormula, fragments, vdist } from '@matterlab/core';
import type { AtomId, Citation, Scene } from '@matterlab/core';
import { DEFAULT_ENERGY_TOLERANCE as UFF_ENERGY_TOLERANCE, DEFAULT_GRADIENT_TOLERANCE as UFF_GRADIENT_TOLERANCE } from '@matterlab/forcefield';
import { DEFAULT_DENSITY_TOLERANCE as SCF_DENSITY_TOLERANCE, DEFAULT_ENERGY_TOLERANCE as SCF_ENERGY_TOLERANCE, virialRatio } from '@matterlab/quantum';
import { orbitalLabel } from '../compute/orbitals';
import type { FieldInfo, FieldSettings, QuantumRecord, SliceInfo, SliceSettings } from '../compute/quantum';
import type { OptimizationRecord } from '../compute/store';
import type { ExplainLevel } from '../state/store';
import type { ExplainSection, Explanation } from './explain';

/**
 * Explanations of the calculations done on a structure: what was asked, how it was answered, what
 * came out, and how far the answer can be trusted. Every number in them is taken from the record
 * of the calculation itself.
 */

/**
 * The worked examples quoted under "Confidence and uncertainty". The computed halves are what
 * MATTER LAB's own engines give (tests hold them to that); the measured halves are from the NIST
 * CCCBDB, release 22: water r_e(O-H) = 0.958 angstrom and H-O-H = 104.48 degrees (Hoy and Bunker
 * 1979), dipole moment of the vibrational ground state 1.855 D (Shostak, Ebenstein and Muenter 1991).
 */
export const CALIBRATION = {
  /** UFF minimum of water. */
  uffWater: { bond: 0.99, angle: 104.5 },
  measuredWater: { bond: 0.958, angle: 104.5, dipole: 1.85 },
  /** RHF/STO-3G dipole moment (debye) of the water molecule of the example library. */
  rhfWaterDipole: 1.71,
} as const;

const REF_CCCBDB: Citation = {
  authors: 'R. D. Johnson III (ed.)',
  title: 'NIST Computational Chemistry Comparison and Benchmark Database, Standard Reference Database 101, Release 22 (measured geometry and dipole moment of water)',
  source: 'National Institute of Standards and Technology',
  year: 2022,
  doi: '10.18434/T47C7Z',
  url: 'https://cccbdb.nist.gov/',
};

/** CODATA 2018. */
const HARTREE_TO_EV = 27.211386245988;

const minus = (text: string): string => text.replace(/-/g, '−');
const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** A value that rounds to zero is written as zero, never as "−0.000". */
const fixed = (value: number, digits: number): string => minus(value.toFixed(digits).replace(/^-(0(\.0+)?)$/, '$1'));
const kcal = (value: number): string => fixed(value, Math.abs(value) >= 1000 ? 1 : 3);
const hartree = (value: number, digits = 6): string => minus(value.toFixed(digits));
const signed = (value: number, digits: number): string => (value > 0 ? '+' : '') + minus(value.toFixed(digits));
const duration = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

/** 1e-4 as "10⁻⁴"; other values as plain numbers. */
function power(value: number): string {
  const exponent = Math.round(Math.log10(value));
  if (Math.abs(value - 10 ** exponent) > 1e-12 * value) return String(value);
  const digits = String(Math.abs(exponent)).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]!);
  return `10${exponent < 0 ? '⁻' : ''}${digits}`;
}

function smallNumber(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1e-3) return minus(String(Number(value.toPrecision(2))));
  return minus(value.toExponential(1).replace(/e([+-])(\d+)/, (_, sign: string, digits: string) => `×10${sign === '-' ? '⁻' : ''}${digits.replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]!)}`));
}

function describeSystem(scene: Scene): { formula: string; parts: number; atoms: number; bonds: number } {
  return { formula: formatFormula(composition(scene)), parts: fragments(scene).length, atoms: scene.atoms.size, bonds: scene.bonds.size };
}

const ISOLATION = (parts: number): string =>
  parts === 1
    ? 'It is treated as one isolated molecule: no neighbours, no solvent, no pressure, and no temperature (the atoms are at rest).'
    : `The workspace holds ${parts} separate pieces, and everything is treated as isolated: no solvent, no pressure, and no temperature (the atoms are at rest).`;

// ---------- force-field geometry optimisation ----------

/** Explains a finished geometry optimisation. `selectedAtom` adds what happened to that atom. */
export function explainOptimisation(record: OptimizationRecord, level: ExplainLevel, selectedAtom: AtomId | null = null): Explanation {
  const advanced = level === 'advanced';
  const system = describeSystem(record.sceneAfter);
  const partial = record.movable < record.atomIds.length;
  const change = record.finalEnergy - record.initialEnergy;
  const terms = record.energyTerms;
  const types = [...new Set(record.atomTypes.values())].sort();
  const name = (id: AtomId): string => {
    const atom = record.sceneAfter.atoms.get(id);
    return atom ? `${atomLabel(atom)} (atom ${id})` : `atom ${id}`;
  };
  const sections: ExplainSection[] = [];

  sections.push({
    heading: 'Objective',
    paragraphs: [
      `To find a relaxed shape for **${system.formula}**: the arrangement of its atoms, close to the one that was drawn, from which no small movement lowers the model’s energy any further. Bond lengths and angles of a hand-built structure are only starting points; this replaces them with the model’s own.`,
      ...(advanced
        ? [`Formally: a local minimum of the force-field energy E(R) with respect to the positions R of the ${plural(record.movable, 'atom')} that were free to move, reached from the drawn geometry.`]
        : []),
    ],
  });

  sections.push({
    heading: 'Starting point and conditions',
    paragraphs: [
      `${plural(system.atoms, 'atom')} and ${plural(system.bonds, 'bond')}, as they were drawn, with a model energy of ${kcal(record.initialEnergy)} kcal/mol.${partial ? ` Only the ${plural(record.movable, 'selected atom')} could move; the other ${record.atomIds.length - record.movable} were held where they were.` : ''}`,
      `The bonding is taken as given: which atoms are bonded, and with what bond order, does not change during the calculation. ${ISOLATION(system.parts)}`,
    ],
    evidence: 'user-input',
  });

  sections.push({
    heading: 'Method',
    paragraphs: advanced
      ? [
          `The **Universal Force Field (UFF)** in the implementation of RDKit, ported to TypeScript and checked against RDKit on 194 molecules. Each atom is given a type from its element, hybridisation and aromaticity as RDKit perceives them (here: ${types.join(', ')}); the parameters of every term follow from the types by the rules of the UFF papers.`,
          'The minimiser is a BFGS quasi-Newton search with a line search, on analytic gradients. When it stops, the lowest curvature of the energy surface is found by a Lanczos iteration; if it is negative the geometry is a saddle point, not a minimum, and the search is moved off it along that direction and continued.',
        ]
      : [
          'The **Universal Force Field (UFF)**, a classical model in which the atoms are balls joined by springs. Every bond has a preferred length and every angle a preferred size; rotation about a bond has preferred positions; and atoms that are not bonded attract each other weakly at a distance and repel strongly when they come too close.',
          'The computer moves the atoms downhill in energy, step by step, until the forces on them vanish. Electrons do not appear in this model at all.',
        ],
    evidence: 'computed',
  });

  sections.push({
    heading: 'Model',
    paragraphs: [
      `The energy is the sum of five kinds of strain. At the final geometry they are: bond stretching ${kcal(terms.bondStretch)}, angle bending ${kcal(terms.angleBend)}, torsion ${kcal(terms.torsion)}, inversion ${kcal(terms.inversion)} and van der Waals contacts ${kcal(terms.vanDerWaals)} kcal/mol, together **${kcal(terms.total)} kcal/mol**.`,
      ...(advanced
        ? [
            'Bond stretching is harmonic in the bond length r; angle bending (E_θ) and inversion (E_ω) are short cosine series in the angle; the torsion term has the periodicity n and phase φ₀ of the two central atoms; the van der Waals term is a Lennard-Jones 12-6 potential with well depth D and distance x, summed over pairs of atoms in the same molecule that are neither bonded nor share a neighbour.',
          ]
        : []),
    ],
    ...(advanced ? { equation: 'E = Σ ½k(r − r₀)² + Σ E_θ + Σ ½V[1 − cos(nφ₀)·cos(nφ)] + Σ E_ω + Σ D[(x/r)¹² − 2(x/r)⁶]' } : {}),
    evidence: 'computed',
  });

  sections.push({
    heading: 'Assumptions',
    paragraphs: [
      'Bonds cannot form or break, so the calculation says nothing about whether the molecule would react or fall apart.',
      'There are **no electrostatic forces** in this implementation (as in RDKit’s): hydrogen bonds and the attraction between charged or polar groups are missing.',
      ...(system.parts > 1 ? ['Atoms in separate molecules do not interact at all, so the pieces in the workspace relax independently and do not arrange themselves relative to one another.'] : []),
      ...(advanced
        ? ['The parameters are generic. They are derived by rule for every element of the periodic table from a few atomic quantities, not fitted to this molecule or to its class of compounds.']
        : []),
    ],
  });

  const moved = record.largestMove && record.largestMove.distance > 0.0005 ? ` The atom that moved most is ${name(record.largestMove.atomId)}, by ${record.largestMove.distance.toFixed(3)} Å.` : '';
  const bond = record.bondChanges.find((b) => Math.abs(b.after - b.before) > 0.0005);
  const resultParagraphs = [
    record.converged
      ? `**Converged to a minimum** after ${plural(record.steps, 'step')} (${duration(record.elapsedMs)}).`
      : `**Not converged** after ${plural(record.steps, 'step')} (${duration(record.elapsedMs)}): the geometry improved but is not a confirmed minimum.`,
    `The energy went from ${kcal(record.initialEnergy)} to **${kcal(record.finalEnergy)} kcal/mol**, a change of ${kcal(change)} kcal/mol.`,
    `The atoms moved by ${record.rmsDisplacement.toFixed(3)} Å on average (root mean square, without any alignment).${moved}`,
    ...(bond ? [`The bond length that changed most is ${name(bond.a)}–${name(bond.b)}: ${bond.before.toFixed(3)} → ${bond.after.toFixed(3)} Å.`] : []),
  ];
  if (selectedAtom !== null) {
    const before = record.sceneBefore.atoms.get(selectedAtom);
    const after = record.sceneAfter.atoms.get(selectedAtom);
    if (before && after) {
      const type = record.atomTypes.get(selectedAtom);
      resultParagraphs.push(`**Selected atom:** ${name(selectedAtom)} moved by ${vdist(before.position, after.position).toFixed(3)} Å${type ? ` and was treated as the UFF type ${type}` : ''}.`);
    }
  }
  sections.push({ heading: 'Result', paragraphs: resultParagraphs, evidence: 'computed' });

  sections.push({
    heading: 'Convergence',
    paragraphs: [
      `The search ends when the forces have vanished and the energy has stopped changing: a root-mean-square gradient below ${power(UFF_GRADIENT_TOLERANCE)} kcal/mol/Å and an energy change per step below ${power(UFF_ENERGY_TOLERANCE)} kcal/mol. The final gradient is ${smallNumber(record.rmsGradient)} kcal/mol/Å.`,
      record.converged
        ? 'Converged also means that the final geometry was tested and found to be a true minimum: the energy rises in every direction.'
        : 'Either the limit on the number of steps was reached or the final geometry is not a minimum. Running the optimisation again continues from where it stopped.',
      ...record.warnings,
      'The Compute tab shows the energy at every step and can replay the path. That path is the route of a numerical search, not the motion of a molecule in time.',
    ],
    evidence: 'computed',
  });

  sections.push({
    heading: 'Confidence and uncertainty',
    paragraphs: [
      `UFF is a general-purpose model of modest accuracy. For ordinary organic molecules it usually gives bond lengths to within a few hundredths of an ångström and angles to within a few degrees. A worked example: it gives water an O–H length of ${CALIBRATION.uffWater.bond.toFixed(3)} Å and an H–O–H angle of ${CALIBRATION.uffWater.angle.toFixed(1)}°, where the measured values are ${CALIBRATION.measuredWater.bond.toFixed(3)} Å and ${CALIBRATION.measuredWater.angle.toFixed(1)}°.`,
      'No error bar is computed for this molecule: a force field has no means of estimating its own error.',
      'The energy has no absolute meaning. It measures strain within this bonding pattern and can be compared between shapes of the same molecule, not between different molecules.',
    ],
  });

  sections.push({
    heading: 'Why the real molecule may differ',
    paragraphs: [
      'This is the minimum nearest to the drawing, which need not be the lowest. A flexible molecule has many such shapes, and at room temperature it moves between several of them.',
      'Where electrostatics or the spread of electrons over several atoms matter (hydrogen bonds, charged groups, conjugated or strained rings, metal centres), UFF can be clearly wrong.',
      'A real molecule vibrates and is shaped by its surroundings, whether solvent, crystal or neighbouring molecules; none of that is in the model.',
      'A minimum of this model is not evidence that the compound is stable or can be made.',
    ],
  });

  return { title: 'Geometry optimisation (UFF)', sections, references: [...(record.provenance.citations ?? []), REF_CCCBDB] };
}

// ---------- Hartree-Fock ----------

export interface QuantumView {
  readonly field: FieldSettings;
  /** What is on stage of the field, once it has been computed. */
  readonly fieldInfo: FieldInfo | null;
  readonly slice: SliceSettings;
  readonly sliceInfo: SliceInfo | null;
  readonly selectedAtom: AtomId | null;
}

function orbitalText(record: QuantumRecord, index: number): string {
  const energy = record.result.orbitalEnergies[index]!;
  return `**${orbitalLabel(record.result, index)}** (orbital ${index + 1} of ${record.result.nBasis}, energy ${signed(energy, 4)} Eh or ${signed(energy * HARTREE_TO_EV, 2)} eV)`;
}

/** What the field on stage shows, in words, with its own numbers. */
function fieldParagraphs(record: QuantumRecord, view: QuantumView, advanced: boolean): string[] {
  const paragraphs: string[] = [];
  const { field, fieldInfo } = view;
  // The potential is always drawn as a surface; and what was computed must be what is now asked for.
  const style = field.kind === 'potential' ? 'surface' : field.style;
  const shown = fieldInfo && fieldInfo.kind === field.kind && fieldInfo.style === style && (field.kind !== 'orbital' || fieldInfo.orbital === field.orbital) ? fieldInfo : null;
  const iso = (value: number): string => String(Number(value.toPrecision(2)));

  if (field.kind === 'orbital') {
    const what = orbitalText(record, field.orbital);
    const occupied = field.orbital <= record.result.homoIndex ? 'It holds two electrons.' : 'It is empty in this state: it shows where an added electron would go.';
    if (field.style === 'surface') {
      paragraphs.push(
        `**On stage:** ${what}. ${occupied} The two surfaces are where the orbital has the values +${iso(field.orbitalIso)} and −${iso(field.orbitalIso)} a₀^(−3/2); violet is the positive phase, amber the negative.`,
        'The sign of a wavefunction cannot be measured, and swapping the two colours would describe the same orbital. What matters is where the sign changes: on that surface, a node, the electron is never found.',
      );
    } else {
      paragraphs.push(
        `**On stage:** ${what}, as a cloud of dots. ${occupied} The dots are placed at random with a probability proportional to the square of the orbital, and coloured by its sign; they picture where an electron in this orbital is likely to be found, not electrons themselves.`,
      );
    }
    if (advanced) paragraphs.push('An orbital is a one-electron function of this model, not an observable. Its energy estimates the energy needed to remove an electron from it (Koopmans’ theorem), with errors of an electronvolt or more at this level.');
  } else if (field.kind === 'density') {
    paragraphs.push(
      field.style === 'surface'
        ? `**On stage:** the electron density of all ${record.result.nElectrons} electrons. The surface joins the points where the density is ${iso(field.densityIso)} e/a₀³; inside it the density is higher.`
        : `**On stage:** the electron density of all ${record.result.nElectrons} electrons, as a cloud of dots placed at random with a probability proportional to the density. The dots picture the distribution; they are not electrons.`,
      'Unlike an orbital, the electron density is an observable: X-ray diffraction measures it.',
    );
    if (shown && shown.captured !== null) paragraphs.push(`Summed over the sampled volume the density amounts to ${shown.captured.toFixed(2)} electrons out of ${record.result.nElectrons}; the rest lies in the thin tail outside it.`);
  } else if (field.kind === 'potential') {
    paragraphs.push(
      `**On stage:** the electrostatic potential on the surface where the electron density is ${iso(field.potentialIso)} e/a₀³. It is the energy a small positive test charge would have at each point: **red** where it is attracted (electron-rich regions), **blue** where it is repelled, white at zero.`,
    );
    if (shown && shown.potentialMin !== null && shown.potentialMax !== null) {
      paragraphs.push(`On this surface the potential runs from ${signed(shown.potentialMin, 3)} to ${signed(shown.potentialMax, 3)} Eh/e.`);
    }
    if (advanced) paragraphs.push('The potential is that of the nuclei and of the Hartree–Fock density of the isolated molecule. A real approaching molecule would polarise it, which this map does not show.');
  }

  if (view.slice.enabled) {
    const name = view.slice.field === 'density' ? 'electron density' : view.slice.field === 'potential' ? 'electrostatic potential' : 'orbital';
    const range = view.sliceInfo && view.sliceInfo.field === view.slice.field ? ` On the plane it runs from ${smallNumber(view.sliceInfo.min)} to ${smallNumber(view.sliceInfo.max)}.` : '';
    paragraphs.push(`**Cutting plane:** a flat section through the ${name}, coloured by its value at each point, with contour lines joining equal values.${range}`);
  }
  return paragraphs;
}

/** Explains a finished Hartree-Fock calculation and whatever is drawn from it. */
export function explainQuantum(record: QuantumRecord, level: ExplainLevel, view: QuantumView): Explanation {
  const advanced = level === 'advanced';
  const { result } = record;
  const system = describeSystem(record.scene);
  const charge = record.input.charge;
  const lumo = result.lumoIndex;
  const homoEnergy = result.orbitalEnergies[result.homoIndex]!;
  const last = result.iterations[result.iterations.length - 1];
  const sections: ExplainSection[] = [];

  sections.push({
    heading: 'Objective',
    paragraphs: [
      `To find how the electrons of **${system.formula}** arrange themselves around its nuclei, held where they are drawn: the molecular orbitals, the electron density, the electrostatic potential and the total energy.`,
      ...(advanced
        ? ['Formally: the Slater determinant of doubly occupied orbitals with the lowest energy that can be built from the basis functions, for fixed nuclei (the restricted Hartree–Fock solution within the Born–Oppenheimer approximation).']
        : []),
    ],
  });

  sections.push({
    heading: 'Starting point and conditions',
    paragraphs: [
      `${system.atoms.toLocaleString('en-US')} ${system.atoms === 1 ? 'nucleus' : 'nuclei'} at the positions drawn, a net charge of ${charge === 0 ? 'zero' : formatCharge(charge)}, and therefore **${plural(result.nElectrons, 'electron')}**, all paired in ${plural(result.nOccupied, 'orbital')}.`,
      `The geometry is used as it is; this calculation does not improve it. ${ISOLATION(system.parts)}`,
    ],
    evidence: 'user-input',
  });

  sections.push({
    heading: 'Method',
    paragraphs: advanced
      ? [
          `**Restricted Hartree–Fock** in the Roothaan–Hall form with the **STO-3G** basis set: ${plural(result.nBasis, 'basis function')}, each a fixed combination of three Gaussians, one for every atomic orbital of the occupied shells.`,
          'The integrals over Gaussians are computed by the McMurchie–Davidson scheme with Schwarz screening. The equations are solved self-consistently from the core-Hamiltonian guess, with symmetric orthogonalisation and Pulay’s DIIS extrapolation. The converged solution is tested for stability; if it is a saddle point of the energy, the calculation leaves it and continues.',
          'The engine was written for MATTER LAB and runs in a background thread of the browser. It reproduces the total energies of the PySCF program to 10⁻⁸ Eh on 48 test systems.',
        ]
      : [
          '**Hartree–Fock theory** with the **STO-3G basis set**. Each pair of electrons is given an orbital of its own, and each electron is treated as moving in the average field of all the others.',
          `The orbitals are built from a small, fixed set of functions centred on the atoms (${result.nBasis} here), and the equations are solved by repetition: guess the orbitals, work out the field they produce, find the best orbitals in that field, and repeat until nothing changes. That is why it is called a self-consistent field.`,
        ],
    evidence: 'computed',
  });

  sections.push({
    heading: 'Model',
    paragraphs: [
      `The total energy is the sum of four parts: the kinetic energy of the electrons ${hartree(result.energy.kinetic, 4)}, their attraction to the nuclei ${hartree(result.energy.nuclearAttraction, 4)}, their repulsion of one another ${hartree(result.energy.twoElectron, 4)}, and the repulsion between the nuclei ${hartree(result.energy.nuclearRepulsion, 4)} Eh.`,
      ...(advanced
        ? [
            `F is the Fock matrix, S the overlap of the basis functions, C the orbital coefficients and ε the orbital energies; P is the density matrix, h the one-electron part, and J and K the Coulomb and exchange parts built from P. The virial ratio −V/T is ${virialRatio(result).toFixed(4)}; it would be exactly 2 for an exact wavefunction at its equilibrium geometry.`,
          ]
        : []),
    ],
    ...(advanced ? { equation: 'F C = S C ε,   F = h + J − ½K,   E = ½ Σ P_μν (h_μν + F_μν) + V_nn' } : {}),
    evidence: 'computed',
  });

  sections.push({
    heading: 'Assumptions',
    paragraphs: [
      'The nuclei are fixed points, and every electron feels only the **average** of the others. The way electrons avoid one another from moment to moment (electron correlation) is left out.',
      'All electrons are paired. Radicals, and bonds stretched close to breaking, cannot be described this way.',
      advanced
        ? 'STO-3G is a minimal basis: one function per occupied atomic orbital, with no polarisation or diffuse functions. Lone pairs, anions and weak interactions are described poorly, and relativistic effects are ignored, which is harmless for hydrogen to argon.'
        : 'The set of building-block functions is the smallest sensible one. It is enough for the overall picture and too rigid for accurate numbers.',
    ],
  });

  const gap = lumo === null ? null : result.orbitalEnergies[lumo]! - homoEnergy;
  const resultParagraphs = [
    result.converged
      ? `**Converged** in ${plural(result.iterations.length, 'iteration')} (${duration(record.elapsedMs)}).`
      : `**Not converged** after ${plural(result.iterations.length, 'iteration')} (${duration(record.elapsedMs)}). Nothing derived from this result should be relied on.`,
    `Total energy **${hartree(result.energy.total)} Eh**. It is counted from all electrons and nuclei at rest and infinitely far apart, so only differences between calculations done the same way mean anything.`,
    `The highest occupied orbital lies at ${signed(homoEnergy, 4)} Eh (${signed(homoEnergy * HARTREE_TO_EV, 2)} eV)${
      lumo === null || gap === null ? '; every orbital of this basis is occupied.' : `, the lowest empty one at ${signed(result.orbitalEnergies[lumo]!, 4)} Eh, a gap of ${(gap * HARTREE_TO_EV).toFixed(2)} eV.`
    }`,
    `Dipole moment **${result.dipole.magnitudeDebye.toFixed(3)} D**${result.dipole.originDependent ? ' (for an ion this depends on the origin; the centre of nuclear charge is used)' : ''}.`,
  ];
  if (view.selectedAtom !== null) {
    const index = record.atomIds.indexOf(view.selectedAtom);
    const atom = record.scene.atoms.get(view.selectedAtom);
    if (index >= 0 && atom) {
      resultParagraphs.push(
        `**Selected atom:** ${atomLabel(atom)} (atom ${view.selectedAtom}) has a Mulliken charge of ${signed(result.mullikenCharges[index]!, 3)} e. Mulliken charges divide the electrons between atoms by the basis functions they sit in; they are bookkeeping, depend strongly on the basis set and cannot be measured.`,
      );
    }
  }
  sections.push({ heading: 'Result', paragraphs: resultParagraphs, evidence: 'computed' });

  const fieldText = fieldParagraphs(record, view, advanced);
  if (fieldText.length > 0) sections.push({ heading: 'What is drawn', paragraphs: fieldText, evidence: 'computed' });

  sections.push({
    heading: 'Convergence',
    paragraphs: [
      `Converged means that in the last iteration the energy changed by less than ${power(SCF_ENERGY_TOLERANCE)} Eh and the density matrix by less than ${power(SCF_DENSITY_TOLERANCE)} (root mean square).${
        last ? ` The last iteration changed them by ${smallNumber(Math.abs(last.deltaEnergy))} Eh and ${smallNumber(last.rmsDensityChange)}.` : ''
      }`,
      ...result.warnings,
      'The Compute tab plots both changes against the iteration number.',
    ],
    evidence: 'computed',
  });

  sections.push({
    heading: 'Confidence and uncertainty',
    paragraphs: [
      'There are two different questions. **Is the arithmetic right?** Yes, to about 10⁻⁸ Eh: the engine agrees with an independent program on every test system. **Is the model right?** Only roughly.',
      `Hartree–Fock with a minimal basis gives the qualitative picture: the shapes and order of the orbitals, where the electron density is high, which end of a molecule is negative. Numbers are rough guides. A worked example: for the water molecule of the example library it gives a dipole moment of ${CALIBRATION.rhfWaterDipole.toFixed(2)} D, where the measured value is ${CALIBRATION.measuredWater.dipole.toFixed(2)} D.`,
      'No error bar is computed for this molecule. The method cannot estimate its own error; that takes a comparison with better calculations or with experiment.',
    ],
  });

  sections.push({
    heading: 'Why the real molecule may differ',
    paragraphs: [
      'Electron correlation is missing and the basis is minimal, so energy differences (reaction energies, barriers, conformer energies) can be wrong by tens of kJ/mol.',
      'The geometry is the one drawn. If it was built by hand, or optimised with the force field, it is not the geometry this method itself would prefer.',
      'A real molecule vibrates and is usually surrounded by others. Solvent and neighbours shift charge distributions and energies, and none of that is included.',
    ],
  });

  return { title: 'Electronic structure (RHF/STO-3G)', sections, references: [...(result.provenance.citations ?? []), REF_CCCBDB] };
}
