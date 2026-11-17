"""Temperature dependence of weak-acid/weak-base ionization constants, for species with sourced
ionization thermodynamics (currently: acetic acid only -- see `species.py`).

Governing model
----------------
Starting from `deltaG = -RT ln K = RT ln(10) . pK` and the standard constant-heat-capacity
expansion `deltaH(T) = deltaH(theta) + deltaCp(T - theta)`, `deltaS(T) = deltaS(theta) + deltaCp
ln(T/theta)` (theta = 298.15 K, the reference temperature), substituting and simplifying gives:

    pK(T) = pK(theta) - [deltaH(theta) / (R ln 10)] . (1/theta - 1/T)
                       - [deltaCp / (R ln 10)]      . ( (theta/T - 1) + ln(T/theta) )

This is the same functional form used by Goldberg, Kishore & Lennen (2002) for buffer ionization
constants (and by the NBS/NIST standard pH buffer temperature equations more generally); it is
*derived* here from first thermodynamic principles, not copied from a possibly-misremembered
printed equation, and is checked in the test suite against the three pKa(T) values that source
paper is reported (elsewhere, via web search during this session) to give for acetic acid: pKa =
4.781 at 0 degC, 4.756 at 25 degC (the reference point, exact by construction) and 4.788 at 50 degC
-- this module's formula reproduces the first and third to within 0.003 pKa units using only the
paper's deltaH and deltaCp values, which is the validation that matters, not the formula's
resemblance to any one printed source.

Scope
------
Only acetic acid carries this temperature model in this package (`species.py`); every other
weak-acid/weak-base system still uses the simpler, more conservative +/-10 K band (`solver.py`,
`WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K`) because no sourced ionization enthalpy/heat-capacity was
found for them in this session. This module's `IonizationThermodynamics.valid_temperature_range_k`
is deliberately narrower than the printed equation's own claimed range (Goldberg et al. state their
fit is usable to roughly 274-350 K; this package validates only 273.15-323.15 K, the range over
which the paper's own tabulated, directly-measured pKa(T) values were checked against here) --
erring toward under-claiming validity rather than over-claiming it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .constants import GAS_CONSTANT_J_PER_MOL_K, STANDARD_TEMPERATURE_K
from .provenance import Citation, Provenance


@dataclass(frozen=True)
class IonizationThermodynamics:
    """Sourced ionization enthalpy/heat-capacity for one monoprotic weak-acid or weak-base system,
    enabling a real Ka(T) model in place of the generic +/-10 K band."""

    delta_h_kj_per_mol: float
    """Standard molar enthalpy of ionization at 298.15 K, kJ/mol."""
    delta_cp_j_per_mol_k: float
    """Standard molar heat-capacity change of ionization, J/(mol K), held constant with T."""
    valid_temperature_range_k: tuple[float, float]
    provenance: Provenance


def pKa_at_temperature(pKa_298_15k: float, thermo: IonizationThermodynamics, temperature_k: float) -> float:
    """pK at `temperature_k`, by the module's derived formula. Callers are expected to have already
    checked `temperature_k` against `thermo.valid_temperature_range_k`; this function does not
    check it itself (kept a pure, unconditional calculation, as `water.kw_at_temperature` is)."""
    theta = STANDARD_TEMPERATURE_K
    delta_h_j = thermo.delta_h_kj_per_mol * 1000.0
    r_ln10 = GAS_CONSTANT_J_PER_MOL_K * math.log(10.0)
    term_h = (delta_h_j / r_ln10) * (1.0 / theta - 1.0 / temperature_k)
    term_cp = (thermo.delta_cp_j_per_mol_k / r_ln10) * ((theta / temperature_k - 1.0) + math.log(temperature_k / theta))
    return pKa_298_15k - term_h - term_cp


_GOLDBERG_KISHORE_LENNEN_2002_THERMO = Citation(
    title="Thermodynamic Quantities for the Ionization Reactions of Buffers",
    authors="Goldberg, R. N.; Kishore, N.; Lennen, R. M.",
    source="Journal of Physical and Chemical Reference Data 31, 231-370",
    year=2002,
    url="https://www.nist.gov/publications/thermodynamic-quantities-ionization-reactions-buffers",
)

ACETIC_ACID_IONIZATION_THERMODYNAMICS = IonizationThermodynamics(
    delta_h_kj_per_mol=-0.41,
    delta_cp_j_per_mol_k=-142.0,
    valid_temperature_range_k=(273.15, 323.15),
    provenance=Provenance(
        source="Goldberg, Kishore & Lennen (2002), NIST-evaluated",
        evidence="REFERENCE_MEASURED",
        citations=(_GOLDBERG_KISHORE_LENNEN_2002_THERMO,),
        notes=(
            "deltaH = -0.41 kJ/mol, deltaCp = -142 J/(mol K) at 298.15 K, zero ionic strength. Combined with the module's own pK(T) derivation "
            "(see ka_temperature.py docstring), reproduces the paper's reported pKa(0 degC) = 4.781 and pKa(50 degC) = 4.788 to within 0.003 pKa units."
        ),
    ),
)
