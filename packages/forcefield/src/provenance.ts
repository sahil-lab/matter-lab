/*
 * Provenance of every result this package returns: which engine was ported, from which exact
 * source, and the literature behind the method. The DOIs were checked against Crossref / DataCite.
 */
import type { Citation, Provenance } from '@matterlab/core';
import { UFF_PARAMS_PROVENANCE } from './generated/uffParams.generated';

/** The RDKit release whose UFF implementation this package reproduces. */
export const RDKIT_VERSION: string = UFF_PARAMS_PROVENANCE.rdkitVersion;

const CITATIONS: readonly Citation[] = [
  {
    authors: 'A. K. Rappé, C. J. Casewit, K. S. Colwell, W. A. Goddard III, W. M. Skiff',
    title: 'UFF, a full periodic table force field for molecular mechanics and molecular dynamics simulations',
    source: 'Journal of the American Chemical Society 114 (25), 10024-10035',
    year: 1992,
    doi: '10.1021/ja00051a040',
  },
  {
    authors: 'C. J. Casewit, K. S. Colwell, A. K. Rappé',
    title: 'Application of a universal force field to organic molecules',
    source: 'Journal of the American Chemical Society 114 (25), 10035-10046',
    year: 1992,
    doi: '10.1021/ja00051a041',
  },
  {
    authors: 'C. J. Casewit, K. S. Colwell, A. K. Rappé',
    title: 'Application of a universal force field to main group compounds',
    source: 'Journal of the American Chemical Society 114 (25), 10046-10053',
    year: 1992,
    doi: '10.1021/ja00051a042',
  },
  {
    authors: 'A. K. Rappé, K. S. Colwell, C. J. Casewit',
    title: 'Application of a universal force field to metal complexes',
    source: 'Inorganic Chemistry 32 (16), 3438-3450',
    year: 1993,
    doi: '10.1021/ic00068a012',
  },
  {
    authors: 'G. Landrum, P. Tosco, R. Rodriguez, B. Kelley and other RDKit contributors',
    title: `RDKit: Open-source cheminformatics, release ${UFF_PARAMS_PROVENANCE.rdkitVersion} (source of the ported implementation and of the parameter table)`,
    source: 'Zenodo',
    doi: '10.5281/zenodo.591637',
    url: 'https://www.rdkit.org',
  },
  {
    authors: 'W. H. Press, S. A. Teukolsky, W. T. Vetterling, B. P. Flannery',
    title: 'Numerical Recipes in C: The Art of Scientific Computing, 2nd edition (sections 9.7 and 10.7: the line search and BFGS scheme of the minimiser)',
    source: 'Cambridge University Press',
    year: 1992,
  },
];

/** A fresh, plain-data provenance record for one result. */
export function uffProvenance(): Provenance {
  return {
    source: `UFF as implemented in RDKit ${RDKIT_VERSION}, ported to TypeScript`,
    version: RDKIT_VERSION,
    citations: CITATIONS.map((c) => ({ ...c })),
    url: `https://github.com/rdkit/rdkit/tree/${UFF_PARAMS_PROVENANCE.rdkitCommit}/Code/ForceField/UFF`,
    retrieved: UFF_PARAMS_PROVENANCE.retrieved,
    license: 'BSD-3-Clause (RDKit source code and parameter table, Copyright (c) 2006-2015 Rational Discovery LLC, Greg Landrum, Julie Penzotti and others)',
    notes:
      `Universal Force Field energy, analytic gradient and geometry optimisation, ported from RDKit ${RDKIT_VERSION} ` +
      `(tag ${UFF_PARAMS_PROVENANCE.rdkitTag}, commit ${UFF_PARAMS_PROVENANCE.rdkitCommit}) with RDKit's default settings: ` +
      'van der Waals threshold 10, no non-bonded interactions between separate fragments, no electrostatics. ' +
      'UFF is a generic molecular-mechanics model: geometries are approximate and energies are not comparable between different molecules.',
  };
}
