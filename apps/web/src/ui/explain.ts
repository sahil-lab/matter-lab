import {
  ELEMENT_CATEGORY_LABELS,
  ISOTOPE_DATA_SOURCE,
  NEUTRON_MASS_U,
  NUCLEAR_RADIUS_R0_FM,
  analyseValences,
  atomLabel,
  composition,
  describeAtom,
  describeStability,
  electronConfiguration,
  formatCharge,
  formatFormula,
  fragments,
  getElement,
  idealBondLength,
  isBondInRing,
  isotopeMass,
  molecularMass,
  neighborsOf,
  validateScene,
  vdist,
} from '@matterlab/core';
import type { AtomId, BondId, Citation, EvidenceLevel, Scene } from '@matterlab/core';
import { RENDER_MODE_LABELS } from '../render/style';
import type { ExplainLevel, RenderMode } from '../state/store';

/** One block of an explanation. Text may use **double asterisks** for emphasis. */
export interface ExplainSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly equation?: string;
  readonly evidence?: EvidenceLevel;
}

export interface Explanation {
  readonly title: string;
  readonly sections: readonly ExplainSection[];
  readonly references: readonly Citation[];
}

const REF_PUBCHEM: Citation = {
  title: 'PubChem Periodic Table',
  source: 'National Center for Biotechnology Information',
  url: 'https://pubchem.ncbi.nlm.nih.gov/periodic-table/',
};
const REF_CORDERO: Citation = {
  authors: 'B. Cordero et al.',
  title: 'Covalent radii revisited',
  source: 'Dalton Transactions, 2832-2838',
  year: 2008,
  doi: '10.1039/b801115j',
};
const REF_RDKIT: Citation = { title: 'RDKit: Open-source cheminformatics', source: 'valence model and periodic-table data', url: 'https://www.rdkit.org' };
const REF_ISOTOPES: Citation[] = [...(ISOTOPE_DATA_SOURCE.citations ?? [])];

/** Energy equivalent of one unified atomic mass unit in MeV (CODATA 2018). */
const U_TO_MEV = 931.49410242;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pictureNote(mode: RenderMode): string {
  const what =
    mode === 'ball-stick'
      ? 'Each sphere is drawn at 26% of the element’s van der Waals radius so the bonds stay visible.'
      : mode === 'space-fill'
        ? 'Each sphere is drawn at the element’s full van der Waals radius, roughly how closely other molecules can approach.'
        : `In the ${RENDER_MODE_LABELS[mode].label.toLowerCase()} view atoms are reduced to joints so the bonding pattern is easy to follow.`;
  return `${what} Colours follow the Jmol convention (carbon grey, oxygen red, nitrogen blue). Real atoms have no hard surface or colour: the picture is a model.`;
}

export function explainAtom(scene: Scene, atomId: AtomId, level: ExplainLevel, mode: RenderMode): Explanation | null {
  const atom = scene.atoms.get(atomId);
  if (!atom) return null;
  const element = getElement(atom.protons);
  const neighbours = neighborsOf(scene, atomId);
  const info = describeAtom(atom, { bonded: neighbours.length > 0 });
  const config = electronConfiguration(atom.protons, atom.electrons);
  const valence = analyseValences(scene).atoms.get(atomId);
  const advanced = level === 'advanced';
  const sections: ExplainSection[] = [];

  sections.push({
    heading: 'Identity',
    paragraphs: [
      `This is **${info.label}**, ${info.kind === 'neutral atom' ? 'a neutral atom' : `a ${info.kind}`} of **${element.name}**. An element is defined by its proton count alone: every nucleus with **${plural(atom.protons, 'proton')}** is ${element.name}, whatever else changes.`,
      advanced
        ? `${element.name} sits in period ${element.period}${element.group ? `, group ${element.group}` : ''} of the ${element.block}-block and is classed as a ${ELEMENT_CATEGORY_LABELS[element.category].toLowerCase()}.`
        : 'Add or remove a proton and it becomes a different element. That is a nuclear change, which ordinary chemistry never does.',
    ],
    evidence: 'reference',
  });

  if (atom.neutrons === null) {
    sections.push({
      heading: 'Isotope',
      paragraphs: [
        info.representative && info.representative.abundance
          ? `No isotope is specified, so this atom stands for natural ${element.name}: a mixture of isotopes whose average mass is the standard atomic weight, **${element.atomicWeight} u**. The most abundant isotope is ${element.name}-${info.representative.a}.`
          : `No isotope is specified. ${element.name} has no stable isotope, so the mass shown (${element.atomicWeight} u) is that of a long-lived isotope.`,
      ],
      evidence: 'reference',
    });
  } else {
    const a = atom.protons + atom.neutrons;
    const paragraphs = [
      `With **${plural(atom.neutrons, 'neutron')}** the mass number is ${atom.protons} + ${atom.neutrons} = **${a}**, making this ${element.name}-${a}. Neutrons change the mass and nuclear stability, not the chemistry.`,
    ];
    if (info.isotope) {
      const abundance = info.isotope.abundance ? ` It makes up ${(info.isotope.abundance * 100).toPrecision(3)}% of natural ${element.name}.` : '';
      paragraphs.push(`${describeStability(info.isotope)}.${abundance}`);
      const mass = isotopeMass(atom.protons, atom.neutrons);
      const hydrogen = isotopeMass(1, 0);
      if (advanced && mass !== null && hydrogen !== null && a > 1) {
        const defect = atom.protons * hydrogen + atom.neutrons * NEUTRON_MASS_U - mass;
        const binding = defect * U_TO_MEV;
        paragraphs.push(
          `Its atomic mass is ${mass.toFixed(6)} u${info.isotope.massFromSystematics ? ' (estimated from systematics)' : ''}, which is ${defect.toFixed(6)} u less than its separate protons, neutrons and electrons. That mass defect corresponds to a nuclear binding energy of **${binding.toFixed(1)} MeV**, or ${(binding / a).toFixed(2)} MeV per nucleon.`,
        );
      }
    } else {
      paragraphs.push('This combination of protons and neutrons is not in the evaluated nuclear data, so MATTER LAB treats it as hypothetical and only estimates its mass.');
    }
    sections.push({
      heading: 'Isotope',
      paragraphs,
      equation: advanced && info.isotope ? 'E_b = [Z·m(¹H) + N·m_n − m_atom]·c²' : undefined,
      evidence: info.isotope ? 'reference' : 'rule-based',
    });
  }

  sections.push({
    heading: 'Charge and electrons',
    paragraphs: [
      info.charge === 0
        ? `Its **${plural(atom.electrons, 'electron')}** exactly balance the ${atom.protons} protons, so the atom is neutral.`
        : `It has **${plural(atom.electrons, 'electron')}** against ${atom.protons} protons, so the net charge is ${atom.protons} − ${atom.electrons} = **${formatCharge(info.charge)}**.`,
      `Electron configuration: **${config.text}**${config.unpaired > 0 ? `, with ${plural(config.unpaired, 'unpaired electron')} by Hund’s rule` : ', with every electron paired'}. ${config.basis}`,
      ...(advanced
        ? ['A configuration lists which orbitals are occupied. It does not mean electrons circle the nucleus on tracks: each orbital is a standing-wave pattern that gives the probability of finding an electron at each point.']
        : []),
    ],
    evidence: config.evidence,
  });

  if (neighbours.length > 0 && valence) {
    const status =
      valence.status === 'ok'
        ? 'which is a complete valence for it'
        : valence.status === 'open'
          ? `${valence.open} short of its usual valence, so as drawn it carries ${plural(valence.open, 'unpaired electron')}`
          : valence.status === 'exceeded'
            ? 'which is more than this element supports'
            : 'and the valence model sets no fixed limit for this element';
    sections.push({
      heading: 'Bonding',
      paragraphs: [`It is bonded to ${plural(neighbours.length, 'atom')} with a total bond order of ${valence.valence}, ${status}.`],
      evidence: 'rule-based',
    });
  }

  if (advanced) {
    const a = atom.neutrons === null ? (info.representative?.a ?? Math.round(element.atomicWeight)) : atom.protons + atom.neutrons;
    const nuclear = NUCLEAR_RADIUS_R0_FM * Math.cbrt(a);
    sections.push({
      heading: 'Scale',
      paragraphs: [
        `The nucleus is tiny compared with the atom. The empirical rule R ≈ r₀·A^(1/3) gives a nuclear radius of about **${nuclear.toFixed(2)} fm**, while the van der Waals radius used for the sphere is ${element.vdwRadius.toFixed(2)} Å (${(element.vdwRadius * 1e5).toLocaleString('en-US')} fm): roughly ${Math.round((element.vdwRadius * 1e5) / nuclear).toLocaleString('en-US')} times larger.`,
      ],
      equation: 'R ≈ r₀ · A^(1/3),   r₀ ≈ 1.2 fm',
      evidence: 'rule-based',
    });
  }

  sections.push({ heading: 'Reading the picture', paragraphs: [pictureNote(mode)], evidence: 'illustrative' });

  if (info.notes.length > 0) {
    sections.push({ heading: 'Caveats', paragraphs: info.notes.map((n) => n.message) });
  }

  return { title: `${element.name} ${info.label !== element.symbol ? `(${info.label})` : 'atom'}`, sections, references: [REF_PUBCHEM, ...REF_ISOTOPES, REF_RDKIT] };
}

export function explainBond(scene: Scene, bondId: BondId, level: ExplainLevel): Explanation | null {
  const bond = scene.bonds.get(bondId);
  if (!bond) return null;
  const a = scene.atoms.get(bond.a)!;
  const b = scene.atoms.get(bond.b)!;
  const ea = getElement(a.protons);
  const eb = getElement(b.protons);
  const length = vdist(a.position, b.position);
  const typical = idealBondLength(a.protons, b.protons, bond.order);
  const advanced = level === 'advanced';
  const orderName = bond.order === 1.5 ? 'aromatic' : bond.order === 1 ? 'single' : bond.order === 2 ? 'double' : 'triple';
  const pairs = bond.order === 1.5 ? 'about one and a half electron pairs' : `${bond.order === 1 ? 'one' : bond.order === 2 ? 'two' : 'three'} shared electron pair${bond.order === 1 ? '' : 's'}`;

  const sections: ExplainSection[] = [
    {
      heading: 'What this bond is',
      paragraphs: [
        `A **${orderName} bond** between ${atomLabel(a)} and ${atomLabel(b)}: ${pairs} holding the two nuclei together.`,
        bond.order === 1.5
          ? 'Aromatic bonds are drawn as a solid and a dashed line because the electrons are spread evenly around the ring instead of sitting in fixed double bonds.'
          : advanced
            ? 'Bond order is bookkeeping for shared electron pairs in a Lewis structure. It is an idealisation: real electron density is continuous, and delocalised systems do not have whole-number orders.'
            : 'More shared pairs pull the atoms closer and hold them more strongly, which is why double and triple bonds are shorter than single ones.',
      ],
      evidence: 'user-input',
    },
    {
      heading: 'Length',
      paragraphs: [
        `As drawn the bond is **${length.toFixed(3)} Å** long. A typical ${ea.symbol}–${eb.symbol} ${orderName} bond is about ${typical.toFixed(2)} Å.`,
        `That typical value is an estimate: the sum of the two covalent radii (${ea.covalentRadius.toFixed(2)} Å + ${eb.covalentRadius.toFixed(2)} Å), shortened for multiple bonds. Expect it to be right to a few hundredths of an angstrom for common organic bonds and less reliable elsewhere.`,
        ...(isBondInRing(scene, bond) ? ['This bond is part of a ring, so changing its length moves only one atom rather than a whole side of the molecule.'] : []),
      ],
      equation: advanced ? 'd ≈ (r_cov(A) + r_cov(B)) × s,   s = 1.00, 0.92, 0.87, 0.78 for orders 1, 1.5, 2, 3' : undefined,
      evidence: 'rule-based',
    },
    {
      heading: 'What is not shown',
      paragraphs: ['MATTER LAB has not computed a bond energy or electron density for this bond. The stick marks which atoms are connected; it is not a physical object.'],
      evidence: 'illustrative',
    },
  ];
  return { title: `${ea.symbol}–${eb.symbol} ${orderName} bond`, sections, references: [REF_CORDERO, REF_RDKIT] };
}

export function explainStructure(scene: Scene, atomIds: readonly AtomId[] | null, level: ExplainLevel, mode: RenderMode): Explanation | null {
  const ids = atomIds ?? [...scene.atoms.keys()];
  if (ids.length === 0) return null;
  const whole = atomIds === null;
  const total = composition(scene, ids);
  const mass = molecularMass(scene, ids);
  const advanced = level === 'advanced';
  const report = validateScene(scene);
  const parts = fragments(scene).length;

  const sections: ExplainSection[] = [
    {
      heading: 'Composition',
      paragraphs: [
        `${whole ? 'The workspace holds' : 'The selection is'} **${formatFormula(total)}**: ${total.parts.map((p) => `${p.count} ${getElement(p.z).name.toLowerCase()}`).join(', ')}${whole && parts > 1 ? `, in ${parts} separate molecules or atoms` : ''}.`,
        advanced
          ? 'The formula is written in Hill order: carbon first, then hydrogen, then the other elements alphabetically (purely alphabetical when there is no carbon).'
          : 'The formula simply counts the atoms of each element.',
      ],
      evidence: 'user-input',
    },
    {
      heading: 'Mass',
      paragraphs: [
        `The mass is **${mass.mass.toFixed(3)} u**, which is numerically the molar mass in g/mol.`,
        mass.basis === 'standard'
          ? 'It is the sum of standard atomic weights, i.e. the average for atoms with natural isotopic composition.'
          : mass.basis === 'isotopic'
            ? 'Every atom here is a specified isotope, so this is the exact mass of that one isotopologue (AME2020 masses), not an average.'
            : 'Some atoms are specified isotopes (their evaluated masses are used) and the rest use standard atomic weights.',
        ...(total.charge !== 0 ? [`The net charge is ${formatCharge(total.charge)}; the mass accounts for the electrons gained or lost.`] : []),
        ...(mass.estimated ? ['At least one nuclide has no evaluated mass, so its mass number was used instead. Treat the total as approximate.'] : []),
      ],
      equation: advanced ? 'M = Σ m_i − q·m_e' : undefined,
      evidence: mass.estimated ? 'rule-based' : 'reference',
    },
  ];

  if (whole) {
    sections.push({
      heading: 'Structure checks',
      paragraphs: [
        report.errors + report.warnings === 0
          ? 'The rule-based checks found no problems: every atom has an allowed valence, no atoms overlap, and bond lengths are plausible.'
          : `The rule-based checks found ${plural(report.errors, 'error')} and ${plural(report.warnings, 'warning')}; they are listed under Inspect.`,
        'These checks follow the valence model used by RDKit and simple geometric rules. Passing them means the drawing is chemically well-formed. It does **not** mean the molecule is stable, can be made, or has this exact shape.',
      ],
      evidence: 'rule-based',
    });
    sections.push({
      heading: 'Geometry',
      paragraphs: [
        'Positions are exactly where they were placed, imported or last optimised. Idealised hydrogens and hand-placed atoms are starting points, not predictions; a geometry optimisation is needed before reading bond lengths or angles as results.',
      ],
      evidence: 'user-input',
    });
  }
  sections.push({ heading: 'Reading the picture', paragraphs: [pictureNote(mode)], evidence: 'illustrative' });

  return { title: whole ? 'This structure' : `Selection of ${ids.length} atoms`, sections, references: [REF_PUBCHEM, REF_RDKIT, REF_CORDERO, ...REF_ISOTOPES] };
}
