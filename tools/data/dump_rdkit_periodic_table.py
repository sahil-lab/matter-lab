"""Dump RDKit's periodic-table data (radii, valence model, common isotopes) for Z = 1..118 as JSON.

Run with the project venv from the repository root:

    .venv\\Scripts\\python.exe tools\\data\\dump_rdkit_periodic_table.py

The output is committed under tools/data/sources so element data can be rebuilt without Python.
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone

import rdkit
from rdkit import Chem

OUT = pathlib.Path(__file__).parent / "sources" / "rdkit-periodic-table.json"


def main() -> None:
    table = Chem.GetPeriodicTable()
    rows = []
    for z in range(1, 119):
        rows.append(
            {
                "z": z,
                "symbol": table.GetElementSymbol(z),
                "atomicWeight": table.GetAtomicWeight(z),
                "covalentRadius": table.GetRcovalent(z),
                "vdwRadius": table.GetRvdw(z),
                "defaultValence": table.GetDefaultValence(z),
                "valenceList": list(table.GetValenceList(z)),
                "outerElectrons": table.GetNOuterElecs(z),
                "mostCommonIsotope": table.GetMostCommonIsotope(z),
                "mostCommonIsotopeMass": table.GetMostCommonIsotopeMass(z),
            }
        )
    payload = {
        "source": "RDKit PeriodicTable",
        "rdkitVersion": rdkit.__version__,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elements": rows,
    }
    OUT.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"wrote {OUT} ({len(rows)} elements, RDKit {rdkit.__version__})")


if __name__ == "__main__":
    main()
