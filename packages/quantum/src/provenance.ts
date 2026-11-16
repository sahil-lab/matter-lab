import type { Citation, Provenance } from '@matterlab/core';
import { STO3G_REFERENCES, STO3G_SOURCE } from './basis/sto3g.generated';

/** Name and version of this engine, reported in every result's provenance. */
export const ENGINE_NAME = '@matterlab/quantum RHF/STO-3G engine';
/** Kept equal to the version in package.json (a test checks this). */
export const ENGINE_VERSION = '0.1.0';

/**
 * Method references. Titles, authors, journals, volumes, pages and years were checked against the
 * Crossref record of each DOI on 2026-11-13.
 */
export const METHOD_CITATIONS: readonly Citation[] = [
  {
    authors: 'C. C. J. Roothaan',
    title: 'New Developments in Molecular Orbital Theory',
    source: 'Rev. Mod. Phys. 23, 69-89',
    year: 1951,
    doi: '10.1103/RevModPhys.23.69',
  },
  {
    authors: 'S. F. Boys',
    title: 'Electronic wave functions - I. A general method of calculation for the stationary states of any molecular system',
    source: 'Proc. R. Soc. Lond. A 200, 542-554',
    year: 1950,
    doi: '10.1098/rspa.1950.0036',
  },
  {
    authors: 'L. E. McMurchie; E. R. Davidson',
    title: 'One- and two-electron integrals over Cartesian Gaussian functions',
    source: 'J. Comput. Phys. 26, 218-231',
    year: 1978,
    doi: '10.1016/0021-9991(78)90092-X',
  },
  {
    authors: 'S. Obara; A. Saika',
    title: 'Efficient recursive computation of molecular integrals over Cartesian Gaussian functions',
    source: 'J. Chem. Phys. 84, 3963-3974',
    year: 1986,
    doi: '10.1063/1.450106',
  },
  {
    authors: 'M. Häser; R. Ahlrichs',
    title: 'Improvements on the direct SCF method',
    source: 'J. Comput. Chem. 10, 104-111',
    year: 1989,
    doi: '10.1002/jcc.540100111',
  },
  {
    authors: 'P.-O. Löwdin',
    title: 'On the Non-Orthogonality Problem Connected with the Use of Atomic Wave Functions in the Theory of Molecules and Crystals',
    source: 'J. Chem. Phys. 18, 365-375',
    year: 1950,
    doi: '10.1063/1.1747632',
  },
  {
    authors: 'P. Pulay',
    title: 'Convergence acceleration of iterative sequences. The case of SCF iteration',
    source: 'Chem. Phys. Lett. 73, 393-398',
    year: 1980,
    doi: '10.1016/0009-2614(80)80396-4',
  },
  {
    authors: 'P. Pulay',
    title: 'Improved SCF convergence acceleration',
    source: 'J. Comput. Chem. 3, 556-560',
    year: 1982,
    doi: '10.1002/jcc.540030413',
  },
  {
    authors: 'R. Seeger; J. A. Pople',
    title: 'Self-consistent molecular orbital methods. XVIII. Constraints and stability in Hartree-Fock theory',
    source: 'J. Chem. Phys. 66, 3045-3050',
    year: 1977,
    doi: '10.1063/1.434318',
  },
  {
    authors: 'E. R. Davidson',
    title: 'The iterative calculation of a few of the lowest eigenvalues and corresponding eigenvectors of large real-symmetric matrices',
    source: 'J. Comput. Phys. 17, 87-94',
    year: 1975,
    doi: '10.1016/0021-9991(75)90065-0',
  },
  {
    authors: 'M. R. Hestenes; E. Stiefel',
    title: 'Methods of conjugate gradients for solving linear systems',
    source: 'J. Res. Natl. Bur. Stand. 49, 409',
    year: 1952,
    doi: '10.6028/jres.049.044',
  },
  {
    authors: 'R. S. Mulliken',
    title: 'Electronic Population Analysis on LCAO-MO Molecular Wave Functions. I',
    source: 'J. Chem. Phys. 23, 1833-1840',
    year: 1955,
    doi: '10.1063/1.1740588',
  },
  {
    authors: 'T. Helgaker; P. Jørgensen; J. Olsen',
    title: 'Molecular Electronic-Structure Theory',
    source: 'Wiley',
    year: 2000,
    doi: '10.1002/9781119019572',
  },
];

/** The references the Basis Set Exchange lists for STO-3G, plus the Basis Set Exchange itself. */
export const BASIS_CITATIONS: readonly Citation[] = [
  ...STO3G_REFERENCES.map(
    (reference): Citation => ({
      authors: reference.authors.join('; '),
      title: reference.title,
      source: `${reference.journal} ${reference.volume}, ${reference.pages}`,
      year: reference.year,
      doi: reference.doi,
    }),
  ),
  {
    authors: 'B. P. Pritchard; D. Altarawy; B. Didier; T. D. Gibson; T. L. Windus',
    title: 'New Basis Set Exchange: An Open, Up-to-Date Resource for the Molecular Sciences Community',
    source: 'J. Chem. Inf. Model. 59, 4814-4820',
    year: 2019,
    doi: '10.1021/acs.jcim.9b00725',
  },
];

/** Provenance attached to every `ScfResult`. A fresh plain object each time (structured-cloneable). */
export function engineProvenance(): Provenance {
  return {
    source: ENGINE_NAME,
    version: ENGINE_VERSION,
    citations: [...BASIS_CITATIONS, ...METHOD_CITATIONS].map((citation) => ({ ...citation })),
    url: STO3G_SOURCE.url,
    retrieved: STO3G_SOURCE.retrieved,
    notes:
      `Restricted Hartree-Fock (closed shell) computed in the browser. Basis set ${STO3G_SOURCE.name} from the ${STO3G_SOURCE.publisher} ` +
      `(library version ${STO3G_SOURCE.bseVersion}; basis-set version ${STO3G_SOURCE.basisVersion}, "${STO3G_SOURCE.revisionDescription}", ` +
      `revised ${STO3G_SOURCE.revisionDate}; snapshot sha256 ${STO3G_SOURCE.sha256}). ` +
      'Integrals by the McMurchie-Davidson scheme with Schwarz screening; symmetric orthogonalisation; core-Hamiltonian guess; Pulay DIIS; ' +
      'the converged solution is tested for internal stability (full diagonalisation of the orbital-rotation Hessian for up to 32 rotations, ' +
      'a randomised conjugate-gradient certificate beyond) and saddle points are left. ' +
      'Energies in hartree; a minimal basis gives qualitative orbitals, densities and potentials, not quantitative energetics.',
  };
}
