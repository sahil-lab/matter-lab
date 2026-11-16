"""MATTER LAB Astra: scientific chemistry and titration engine (Agent 06).

Pure, dependency-free (no FastAPI, no PostgreSQL, no RDKit) chemistry library that solves
acid/base equilibria by mass-balance and charge-balance (electroneutrality) root-finding. It is
the sole source of truth for pH and equilibrium concentrations in the MATTER LAB Astra lab
expansion: nothing here is a hardcoded or shape-interpolated titration curve.

Governing rule (binding for this package, same as the rest of MATTER LAB): every number this
package returns carries an explicit evidence label from the shared integration contract's
vocabulary (`REFERENCE_MEASURED`, `MODEL_CALCULATED`, `ILLUSTRATIVE`, `UNVERIFIED`,
`UNSUPPORTED`; see `provenance.py`), and a system this package cannot treat validly is reported
as `UNSUPPORTED` or `FAILED` with diagnostics, never as a plausible-looking number.

See `README.md` in this directory for the governing equations, data sources, tolerances and
method IDs, and `services/science/tests/test_titration_*.py` for the automated test suite.
"""

from __future__ import annotations

__version__ = "0.1.0"
