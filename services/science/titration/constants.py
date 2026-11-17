"""Physical constants used throughout the titration engine.

Every constant here is exact by SI definition or a fixed-point reference condition; none is a
measured, uncertain quantity. Values are kept consistent with the rest of the MATTER LAB monorepo
(see `packages/core/src/constants.ts`: `GAS_CONSTANT_J_PER_MOL_K = 8.31446261815324`).
"""

from __future__ import annotations

#: Molar gas constant R, J/(mol K). Exact since the 2019 SI redefinition.
GAS_CONSTANT_J_PER_MOL_K = 8.31446261815324

#: 0 degrees Celsius in kelvin, exact by definition.
CELSIUS_ZERO_K = 273.15

#: Standard reference temperature used by the CODATA Key Values and by this package's reference
#: equilibrium constants, in kelvin.
STANDARD_TEMPERATURE_K = 298.15

#: Validated temperature range of the aqueous equilibrium model, in kelvin: 0 degC to 100 degC,
#: the range over which water is an ordinary dilute-solution liquid solvent at 1 atm. Outside this
#: range the solver reports UNSUPPORTED rather than extrapolate silently.
MIN_VALID_TEMPERATURE_K = 273.15
MAX_VALID_TEMPERATURE_K = 373.15

#: Smallest and largest total volume accepted, in litres (1 microlitre to 1000 L: a wide margin
#: around any bench-scale glassware). Outside this range the solver reports FAILED.
MIN_VOLUME_L = 1e-9
MAX_VOLUME_L = 1000.0

#: Largest analytical concentration the ideal-dilute-solution model is considered for, in mol/L.
#: Above this (concentrated acids/bases, e.g. 12 M HCl) ionic activity deviates sharply from
#: concentration and the model is not validated; the solver reports UNSUPPORTED.
MAX_VALID_CONCENTRATION_MOLAR = 18.0

#: Smallest positive concentration of hydrogen ion considered numerically meaningful (pH 20); below
#: this bracketing the root is not attempted.
MIN_HYDROGEN_ION_MOLAR = 1e-20

#: Bounds of the pH search bracket used by the root finder. Wide enough to contain any input this
#: package accepts, including far outside the normal 0-14 scale, so that the solver can always
#: either bracket a root or report precisely why it could not.
PH_SEARCH_MIN = -3.0
PH_SEARCH_MAX = 20.0
