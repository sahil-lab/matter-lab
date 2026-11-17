"""Water autoionization: Kw as a function of temperature.

Governing equilibrium
----------------------
    H2O(l) <=> H+(aq) + OH-(aq)        Kw = a(H+) . a(OH-)  (ideal dilute solution: a = [X])

Reference value
----------------
`KW_REFERENCE_298_15K = 1.0e-14` at 298.15 K is the long-established IUPAC/NIST-recommended value
(pKw = 14.00; a more precise evaluation gives pKw = 13.995). It is the anchor this module's
temperature model extrapolates from.

Temperature dependence
-----------------------
This package derives the standard reaction enthalpy of autoionization from the same CODATA Key
Values table already used by `packages/reactions` (Cox, J. D.; Wagman, D. D.; Medvedev, V. A.
*CODATA Key Values for Thermodynamics*; Hemisphere, 1989; see
`packages/reactions/src/data/thermo.generated.ts` for the values as tabulated in this repository):

    species        deltaHf298 (kJ/mol)   S298 (J/(mol K))
    H+(aq)         0 (exact, convention)  0 (exact, convention)
    OH-(aq)        -230.015 +/- 0.04      -10.9 +/- 0.2
    H2O(l)         -285.83 +/- 0.04       69.95 +/- 0.03

    deltaH_rxn = deltaHf(H+) + deltaHf(OH-) - deltaHf(H2O) = +55.815 kJ/mol
    deltaS_rxn = S(H+) + S(OH-) - S(H2O)   = -80.85 J/(mol K)

`codata_cross_check_kw(298.15)` recomputes Kw from deltaG = deltaH - T deltaS as an independent
check of `KW_REFERENCE_298_15K`: it gives Kw = 9.967e-15 (pKw = 14.0015), within 0.4% of the
literature value, well inside the combined tabulated uncertainties of the three CODATA entries
once exponentiated. That is the cross-check this module reports, not a second working value.

For T != 298.15 K this module applies the van't Hoff equation with deltaH_rxn held constant:

    ln(Kw(T) / Kw(298.15 K)) = -(deltaH_rxn / R) . (1/T - 1/298.15)

the same "constant-enthalpy approximation" `packages/reactions` already uses and labels for
reaction thermodynamics away from 298.15 K (see `docs/feature-status.md`). It is adequate over the
validated range of this module (0 degC to 100 degC) but is an approximation: the true heat
capacity change of the reaction is not zero, so results away from 298.15 K are labelled
MODEL_CALCULATED (not REFERENCE_MEASURED) with the approximation stated explicitly.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .constants import GAS_CONSTANT_J_PER_MOL_K, MAX_VALID_TEMPERATURE_K, MIN_VALID_TEMPERATURE_K, STANDARD_TEMPERATURE_K
from .provenance import Citation, EvidenceLevel, Provenance

#: IUPAC/NIST-recommended ion product of water at 298.15 K (pKw = 14.00; pKw = 13.995 more precisely).
KW_REFERENCE_298_15K = 1.0e-14

_CODATA_CITATION = Citation(
    title="CODATA Key Values for Thermodynamics",
    authors="Cox, J. D.; Wagman, D. D.; Medvedev, V. A.",
    source="Hemisphere Publishing Corporation, New York",
    year=1989,
)

# CODATA Key Values, kJ/mol and J/(mol K) at 298.15 K, as already tabulated in this repository
# (packages/reactions/src/data/thermo.generated.ts, source id "codata-key-values").
_DELTA_HF_H_PLUS_KJ = 0.0  # exact, hydrogen-ion convention
_DELTA_HF_OH_MINUS_KJ = -230.015
_DELTA_HF_H2O_L_KJ = -285.83
_S_H_PLUS = 0.0  # exact, hydrogen-ion convention
_S_OH_MINUS = -10.9
_S_H2O_L = 69.95

#: Standard reaction enthalpy of H2O(l) -> H+(aq) + OH-(aq) at 298.15 K, derived from the CODATA
#: values above (not independently tabulated): +55.815 kJ/mol.
DELTA_H_AUTOIONIZATION_KJ_PER_MOL = (_DELTA_HF_H_PLUS_KJ + _DELTA_HF_OH_MINUS_KJ) - _DELTA_HF_H2O_L_KJ

#: Standard reaction entropy of the same reaction at 298.15 K, derived the same way: -80.85 J/(mol K).
DELTA_S_AUTOIONIZATION_J_PER_MOL_K = (_S_H_PLUS + _S_OH_MINUS) - _S_H2O_L


def codata_cross_check_kw(temperature_k: float = STANDARD_TEMPERATURE_K) -> float:
    """Kw implied purely by the CODATA enthalpies/entropies above, via deltaG = deltaH - T deltaS
    and Kw = exp(-deltaG / RT). An independent consistency check on `KW_REFERENCE_298_15K`, not the
    value this module's `kw_at_temperature` uses (see module docstring)."""
    delta_g_j = DELTA_H_AUTOIONIZATION_KJ_PER_MOL * 1000.0 - temperature_k * DELTA_S_AUTOIONIZATION_J_PER_MOL_K
    return math.exp(-delta_g_j / (GAS_CONSTANT_J_PER_MOL_K * temperature_k))


@dataclass(frozen=True)
class WaterAutoionizationResult:
    kw: float
    pkw: float
    temperature_k: float
    evidence: EvidenceLevel
    provenance: Provenance
    warnings: tuple[str, ...] = ()


def validate_temperature_k(temperature_k: float) -> str | None:
    """None when the temperature is acceptable; otherwise the reason it is not."""
    if not math.isfinite(temperature_k) or temperature_k <= 0:
        return f"Temperature must be a positive, finite number of kelvin; got {temperature_k!r}."
    if not (MIN_VALID_TEMPERATURE_K <= temperature_k <= MAX_VALID_TEMPERATURE_K):
        return (
            f"Temperature {temperature_k:.2f} K is outside the validated range of the aqueous equilibrium model "
            f"({MIN_VALID_TEMPERATURE_K:.2f} K to {MAX_VALID_TEMPERATURE_K:.2f} K, i.e. 0 degC to 100 degC at 1 atm)."
        )
    return None


def kw_at_temperature(temperature_k: float) -> WaterAutoionizationResult:
    """Ion product of water at `temperature_k`.

    At 298.15 K this is the cited reference value (REFERENCE_MEASURED). At any other temperature
    within the validated range it is the van't Hoff extrapolation described in the module docstring
    (MODEL_CALCULATED), with a warning naming the approximation.

    @raises ValueError if `temperature_k` is outside the validated range (0 degC to 100 degC); the
    caller (the solver entrypoint) turns this into an explicit UNSUPPORTED result with diagnostics.
    """
    reason = validate_temperature_k(temperature_k)
    if reason is not None:
        raise ValueError(reason)

    base_notes = (
        "Kw(298.15 K) = 1.0e-14 (IUPAC/NIST-recommended ion product of water; pKw = 14.00, "
        "pKw = 13.995 in a more precise evaluation). Ideal dilute solution: activities are taken "
        "equal to molar concentrations."
    )
    if abs(temperature_k - STANDARD_TEMPERATURE_K) < 1e-9:
        kw = KW_REFERENCE_298_15K
        return WaterAutoionizationResult(
            kw=kw,
            pkw=-math.log10(kw),
            temperature_k=temperature_k,
            evidence="REFERENCE_MEASURED",
            provenance=Provenance(source="IUPAC/NIST-recommended ion product of water at 298.15 K", evidence="REFERENCE_MEASURED", notes=base_notes),
            warnings=(),
        )

    delta_h_j = DELTA_H_AUTOIONIZATION_KJ_PER_MOL * 1000.0
    ln_ratio = -(delta_h_j / GAS_CONSTANT_J_PER_MOL_K) * (1.0 / temperature_k - 1.0 / STANDARD_TEMPERATURE_K)
    kw = KW_REFERENCE_298_15K * math.exp(ln_ratio)
    notes = (
        f"{base_notes} Extrapolated to {temperature_k:.2f} K by the van't Hoff equation "
        f"ln(Kw(T)/Kw(298.15 K)) = -(deltaH/R)(1/T - 1/298.15) with deltaH = {DELTA_H_AUTOIONIZATION_KJ_PER_MOL:.3f} kJ/mol "
        "held constant with temperature (the heat capacity of the reaction is not modelled); deltaH is derived from the "
        "CODATA Key Values enthalpies of formation of H+(aq) (0, convention), OH-(aq) (-230.015 kJ/mol) and H2O(l) "
        "(-285.83 kJ/mol). This is the same constant-enthalpy approximation packages/reactions uses and labels for "
        "reaction thermodynamics away from 298.15 K; it is adequate over the validated 0 degC-100 degC range but is "
        "an approximation, not a second reference measurement."
    )
    return WaterAutoionizationResult(
        kw=kw,
        pkw=-math.log10(kw),
        temperature_k=temperature_k,
        evidence="MODEL_CALCULATED",
        provenance=Provenance(
            source="Van't Hoff extrapolation of the IUPAC/NIST Kw(298.15 K) using a CODATA-derived reaction enthalpy",
            evidence="MODEL_CALCULATED",
            citations=(_CODATA_CITATION,),
            notes=notes,
        ),
        warnings=(f"Kw at {temperature_k:.2f} K is a constant-enthalpy extrapolation, not a directly measured reference value.",),
    )
