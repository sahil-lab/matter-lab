"""Stand-alone probe for the optional engines. Run in a child process so that a broken native
library can never take the API process down with it:

    python -m matterlab_science.engine_probe xtb|pyscf

Prints one JSON object: whether the engine imports, its version, the versions of its components,
and the outcome of a tiny real calculation (checked for internal consistency only, never against
a remembered reference value).
"""

from __future__ import annotations

import json
import math
import sys
import time
from importlib import metadata
from typing import Any


def _package(name: str) -> dict[str, Any]:
    try:
        meta = metadata.metadata(name)
    except metadata.PackageNotFoundError:
        return {}
    license_text = meta.get("License-Expression") or meta.get("License") or ""
    urls = {}
    for entry in meta.get_all("Project-URL") or []:
        label, _, url = entry.partition(",")
        urls[label.strip().lower()] = url.strip()
    return {
        "version": metadata.version(name),
        "license": license_text if license_text and len(license_text) < 80 else None,
        "url": urls.get("homepage") or urls.get("documentation") or urls.get("repository") or meta.get("Home-page"),
        "summary": meta.get("Summary"),
    }


def probe_xtb() -> dict[str, Any]:
    info: dict[str, Any] = {"engine": "xtb", "available": False, "components": {}, "self_test": None}
    package = _package("tblite")
    if not package:
        info["reason"] = "The Python package tblite is not installed."
        return info
    info.update(license=package["license"], url=package["url"], summary=package["summary"])
    try:
        import numpy as np
        from scipy import constants
        from tblite import library
        from tblite.interface import Calculator
    except Exception as exc:  # e.g. missing libgomp: the package is present but unusable
        info["reason"] = f"tblite is installed but cannot be imported: {type(exc).__name__}: {exc}"
        return info
    info["version"] = ".".join(str(part) for part in library.get_version())
    info["components"]["tblite"] = info["version"]
    ase_package = _package("ase")
    if ase_package:
        try:
            import ase  # noqa: F401
            import tblite.ase  # noqa: F401

            info["components"]["ase"] = ase_package["version"]
        except Exception as exc:
            info["ase_error"] = f"{type(exc).__name__}: {exc}"

    started = time.monotonic()
    try:
        bohr = constants.physical_constants["Bohr radius"][0] * 1e10
        positions = np.array([[0.0, 0.0, -0.37], [0.0, 0.0, 0.37]]) / bohr
        calc = Calculator("GFN2-xTB", np.array([1, 1]), positions)
        calc.set("verbosity", 0)
        result = calc.singlepoint()
        energy = float(result.get("energy"))
        gradient = np.asarray(result.get("gradient"))
        passed = math.isfinite(energy) and energy < 0 and gradient.shape == (2, 3) and bool(np.allclose(gradient.sum(axis=0), 0.0, atol=1e-8))
        detail = None if passed else "the GFN2-xTB test calculation returned inconsistent values"
    except Exception as exc:
        passed, detail = False, f"{type(exc).__name__}: {exc}"
    info["self_test"] = {
        "description": "GFN2-xTB single point on H2 (finite negative energy, forces sum to zero)",
        "passed": passed,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "detail": detail,
    }
    info["available"] = passed
    if not passed:
        info["reason"] = f"tblite imported but its self-test failed: {detail}"
    return info


def probe_pyscf() -> dict[str, Any]:
    info: dict[str, Any] = {"engine": "pyscf", "available": False, "components": {}, "self_test": None}
    package = _package("pyscf")
    if not package:
        info["reason"] = "The Python package pyscf is not installed."
        return info
    info.update(license=package["license"], url=package["url"], summary=package["summary"])
    try:
        import pyscf
        from pyscf import dft, gto, scf
        from pyscf.dft import libxc
    except Exception as exc:
        info["reason"] = f"pyscf is installed but cannot be imported: {type(exc).__name__}: {exc}"
        return info
    info["version"] = pyscf.__version__
    info["components"]["pyscf"] = pyscf.__version__
    libxc_version = getattr(libxc, "__version__", None)
    if libxc_version:
        info["components"]["libxc"] = str(libxc_version)

    started = time.monotonic()
    try:
        mol = gto.M(atom=[("H", (0.0, 0.0, -0.37)), ("H", (0.0, 0.0, 0.37))], unit="Angstrom", basis="sto-3g", verbose=0)
        hf = scf.RHF(mol)
        hf.chkfile = None
        e_hf = float(hf.kernel())
        ks = dft.RKS(mol)
        ks.chkfile = None
        ks.xc = "pbe"
        e_ks = float(ks.kernel())
        passed = (
            bool(hf.converged)
            and bool(ks.converged)
            and math.isfinite(e_hf)
            and math.isfinite(e_ks)
            and e_hf < 0
            and e_ks < 0
            and len(hf.mo_energy) == 2
            and abs(e_hf - e_ks) > 1e-6
        )
        detail = None if passed else "the RHF/RKS test calculations returned inconsistent values"
    except Exception as exc:
        passed, detail = False, f"{type(exc).__name__}: {exc}"
    info["self_test"] = {
        "description": "RHF and RKS(PBE) in STO-3G on H2 (both converge, finite negative energies, two molecular orbitals)",
        "passed": passed,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "detail": detail,
    }
    info["available"] = passed
    if not passed:
        info["reason"] = f"pyscf imported but its self-test failed: {detail}"
    return info


PROBES = {"xtb": probe_xtb, "pyscf": probe_pyscf}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in PROBES:
        print(f"usage: python -m matterlab_science.engine_probe {'|'.join(PROBES)}", file=sys.stderr)
        return 2
    # Results go to the real stdout; anything the libraries print is diverted to stderr.
    out = sys.stdout
    sys.stdout = sys.stderr
    report = PROBES[argv[0]]()
    out.write(json.dumps(report) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
