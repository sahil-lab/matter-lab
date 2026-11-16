/**
 * Physical constants and unit conversions. Values are the CODATA 2018 recommended values
 * (E. Tiesinga, P. J. Mohr, D. B. Newell, B. N. Taylor, Rev. Mod. Phys. 93, 025010 (2021)).
 * Entries marked "exact" are fixed by the 2019 SI definitions.
 */
export const CODATA_VERSION = 'CODATA 2018';

/** Bohr radius a0 in angstrom. */
export const BOHR_TO_ANGSTROM = 0.529177210903;
export const ANGSTROM_TO_BOHR = 1 / BOHR_TO_ANGSTROM;

/** Hartree energy Eh in other units. */
export const HARTREE_TO_EV = 27.211386245988;
export const HARTREE_TO_KJ_PER_MOL = 2625.4996394799;
export const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;

/** Thermochemical calorie (exact by definition). */
export const KCAL_TO_KJ = 4.184;
export const EV_TO_KJ_PER_MOL = 96.48533212331;

/** Avogadro constant in 1/mol (exact). */
export const AVOGADRO = 6.02214076e23;
/** Boltzmann constant in J/K (exact). */
export const BOLTZMANN_J_PER_K = 1.380649e-23;
/** Molar gas constant in J/(mol K) (exact, = N_A k_B). */
export const GAS_CONSTANT_J_PER_MOL_K = 8.31446261815324;
/** Elementary charge in C (exact). */
export const ELEMENTARY_CHARGE_C = 1.602176634e-19;
/** Planck constant in J s (exact). */
export const PLANCK_J_S = 6.62607015e-34;

/** Unified atomic mass unit in kg. */
export const ATOMIC_MASS_UNIT_KG = 1.6605390666e-27;
/** Particle rest masses in unified atomic mass units. */
export const ELECTRON_MASS_U = 5.48579909065e-4;
export const PROTON_MASS_U = 1.007276466621;
export const NEUTRON_MASS_U = 1.00866491595;

/** Dipole moment: 1 e a0 expressed in debye. */
export const AU_DIPOLE_TO_DEBYE = 2.541746473;

/** Standard pressures in Pa (exact by definition). */
export const ATM_TO_PA = 101325;
export const BAR_TO_PA = 100000;

/** Conventional reference temperature for tabulated thermochemistry, in K. */
export const STANDARD_TEMPERATURE_K = 298.15;

/** Empirical nuclear radius parameter r0 in femtometres, for R = r0 A^(1/3). */
export const NUCLEAR_RADIUS_R0_FM = 1.2;
export const FEMTOMETRE_TO_ANGSTROM = 1e-5;
