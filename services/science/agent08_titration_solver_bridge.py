"""Agent 08 integration bridge — NOT part of Agent 06's owned `titration/` package.

A thin CLI wrapper around Agent 06's real, pure `titration.solver.solve_equilibrium`
(`services/science/titration/solver.py`), used only so this repository's TypeScript code
(a Node-side `SolverClient` and a Vite dev-server middleware, see
`apps/web/src/lab/challenges/integration/`) can call the *actual* validated solver instead of
inventing pH numbers of its own, without standing up the full FastAPI service (which pulls in
RDKit/PySCF for unrelated endpoints). This script touches only Agent 06's public, documented
entry point; it does not modify or reimplement any chemistry.

Protocol: reads one JSON object from stdin, shaped like
    { "species": [{"speciesId": str, "moles": number}, ...],
      "volumeL": number, "temperatureK"?: number, "modelId"?: str }
and writes one JSON object (the solver's `SolveResult`, via `dataclasses.asdict`) to stdout.
Never used in production; dev/test only, and clearly out of Agent 06's and Agent 07's owned paths.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict

from titration.solver import solve_equilibrium
from titration.types import SpeciesAmountInput


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as error:
        print(json.dumps({"error": f"invalid JSON request: {error}"}), file=sys.stdout)
        return 1

    try:
        species = [SpeciesAmountInput(species_id=s["speciesId"], moles=float(s["moles"])) for s in request["species"]]
        volume_l = float(request["volumeL"])
        temperature_k = float(request.get("temperatureK", 298.15))
        kwargs = {}
        if "modelId" in request and request["modelId"]:
            kwargs["model_id"] = request["modelId"]
        result = solve_equilibrium(species, volume_l, temperature_k, **kwargs)
    except Exception as error:  # noqa: BLE001 - always report as structured JSON, never a bare traceback on stdout
        print(json.dumps({"error": str(error)}), file=sys.stdout)
        return 1

    print(json.dumps(asdict(result)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
