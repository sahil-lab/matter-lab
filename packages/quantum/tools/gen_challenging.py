#!/usr/bin/env python3
"""Generates PySCF reference energies for closed-shell systems on which SCF is awkward.

    docker run --rm -v "${PWD}\\packages\\quantum:/work" python:3.12-slim `
        bash -c "pip install -q pyscf && python /work/tools/gen_challenging.py"

Output: packages/quantum/test/fixtures/pyscf_challenging.json

These systems (stretched bonds, biradicaloids, molecules whose core-Hamiltonian guess leads to a
saddle point) have several RHF solutions. For each one PySCF is run from two different starting
guesses, with plain DIIS and with DIIS plus a level shift, and every converged solution is
followed along its internal (RHF -> RHF) instabilities until none is left; the energies of all the
stationary points met on the way are recorded, as is whether a run converged at all (plain DIIS
does not always). `lowestEnergy` is the lowest converged, internally stable energy found.

    docker run --rm -e OMP_NUM_THREADS=2 ... (two threads are plenty for these tiny systems)

Same basis-set snapshot, coordinates and conventions as gen_reference.py.
"""

import datetime
import json
import math
import os
import platform

import numpy as np
import pyscf
from pyscf import gto, scf
from pyscf.data import elements

from gen_reference import BASIS_PATH, BOHR_TO_ANGSTROM, CONV_TOL, CONV_TOL_GRAD, load_bse_basis

OUT_PATH = os.path.join(os.path.dirname(BASIS_PATH), "..", "test", "fixtures", "pyscf_challenging.json")


def ring(symbol, count, radius):
    return [(symbol, radius * math.cos(2 * math.pi * k / count), radius * math.sin(2 * math.pi * k / count), 0.0) for k in range(count)]


# name, charge, atoms (angstrom). Idealised or deliberately distorted geometries chosen by the author.
SYSTEMS = [
    ("N2 (1.098 A)", 0, [("N", 0, 0, 0), ("N", 0, 0, 1.098)]),
    ("N2 stretched (1.6 A)", 0, [("N", 0, 0, 0), ("N", 0, 0, 1.6)]),
    ("N2 stretched (2.5 A)", 0, [("N", 0, 0, 0), ("N", 0, 0, 2.5)]),
    ("H2 stretched (2.5 A)", 0, [("H", 0, 0, 0), ("H", 0, 0, 2.5)]),
    ("O2 closed-shell singlet", 0, [("O", 0, 0, 0), ("O", 0, 0, 1.208)]),
    ("O3", 0, [("O", 0, 0, 0), ("O", 1.076, 0, 0.672), ("O", -1.076, 0, 0.672)]),
    ("C2", 0, [("C", 0, 0, 0), ("C", 0, 0, 1.243)]),
    ("BN", 0, [("B", 0, 0, 0), ("N", 0, 0, 1.281)]),
    ("CH2 singlet", 0, [("C", 0, 0, 0), ("H", 0.862, 0, 0.697), ("H", -0.862, 0, 0.697)]),
    ("P2", 0, [("P", 0, 0, 0), ("P", 0, 0, 1.893)]),
    ("H4 square (1.2 A)", 0, [("H", 0, 0, 0), ("H", 1.2, 0, 0), ("H", 1.2, 1.2, 0), ("H", 0, 1.2, 0)]),
    ("H6 ring (1.5 A)", 0, ring("H", 6, 1.5)),
    ("H2O stretched (2.0 A)", 0, [("O", 0, 0, 0), ("H", 1.6, 0, 1.2), ("H", -1.6, 0, 1.2)]),
    ("LiH stretched (4.0 A)", 0, [("Li", 0, 0, 0), ("H", 0, 0, 4.0)]),
    ("NO+", 1, [("N", 0, 0, 0), ("O", 0, 0, 1.063)]),
    ("F2 stretched (2.2 A)", 0, [("F", 0, 0, 0), ("F", 0, 0, 2.2)]),
    ("C2H4 twisted 90 deg", 0, [("C", 0, 0, 0.67), ("C", 0, 0, -0.67), ("H", 0.92, 0, 1.24), ("H", -0.92, 0, 1.24), ("H", 0, 0.92, -1.24), ("H", 0, -0.92, -1.24)]),
]


def new_rhf(mol, level_shift=0.0):
    mf = scf.RHF(mol)
    mf.conv_tol = CONV_TOL
    mf.conv_tol_grad = CONV_TOL_GRAD
    mf.max_cycle = 150
    mf.direct_scf = False
    # A level shift damps the oscillations plain DIIS runs into for stretched bonds; it does not
    # change which densities are stationary.
    mf.level_shift = level_shift
    return mf


def follow(mol, init_guess, level_shift=0.0):
    """SCF from `init_guess`, then repeatedly leave internal instabilities. Returns (energies, stable, converged)."""
    mf = new_rhf(mol, level_shift)
    mf.init_guess = init_guess
    mf.kernel()
    energies = [float(mf.e_tot)]
    stable = None
    converged = bool(mf.converged)
    for _ in range(8):
        if not mf.converged or mol.nelectron // 2 == mol.nao:
            break
        mo, _mo_external, stable, _stable_external = mf.stability(internal=True, external=False, return_status=True)
        stable = bool(stable)
        if stable:
            break
        dm = mf.make_rdm1(mo, mf.mo_occ)
        mf = new_rhf(mol, level_shift)
        mf.kernel(dm)
        converged = bool(mf.converged)
        energies.append(float(mf.e_tot))
    return energies, stable, converged


def main():
    basis_by_z, basis_meta = load_bse_basis(BASIS_PATH)
    records = []
    for name, charge, atoms in SYSTEMS:
        symbols = [a[0] for a in atoms]
        xyz = np.array([[a[1], a[2], a[3]] for a in atoms], dtype=float)
        mol = gto.Mole()
        mol.atom = [[s, tuple(float(v) for v in row)] for s, row in zip(symbols, xyz / BOHR_TO_ANGSTROM)]
        mol.unit = "Bohr"
        mol.charge = charge
        mol.spin = 0
        mol.symmetry = False
        mol.verbose = 0
        mol.basis = {s: basis_by_z[elements.charge(s)] for s in set(symbols)}
        mol.build()
        runs = {}
        for label, guess, level_shift in (("minao", "minao", 0.0), ("1e", "1e", 0.0), ("minao-levelshift", "minao", 0.5), ("1e-levelshift", "1e", 0.5)):
            energies, stable, converged = follow(mol, guess, level_shift)
            runs[label] = {"energies": energies, "internalStable": stable, "converged": converged}
        # Only converged solutions that were confirmed stable (or have no virtual orbitals) count.
        candidates = [run["energies"][-1] for run in runs.values() if run["converged"] and run["internalStable"] is not False]
        lowest = min(candidates) if candidates else None
        records.append(
            {
                "name": name,
                "charge": charge,
                "atoms": [{"z": int(elements.charge(s)), "position": [float(c) for c in row]} for s, row in zip(symbols, xyz)],
                "nBasis": int(mol.nao),
                "nElectrons": int(mol.nelectron),
                "runs": runs,
                "lowestEnergy": lowest,
            }
        )
        summary = "  ".join(f"{label}: {[round(e, 8) for e in run['energies']]} conv={run['converged']} stable={run['internalStable']}" for label, run in runs.items())
        print(f"{name:26s} lowest={lowest}  {summary}", flush=True)

    fixture = {
        "description": "RHF/STO-3G energies (hartree) of systems with several SCF solutions, from PySCF with internal-stability following. Positions in angstrom.",
        "generator": "packages/quantum/tools/gen_challenging.py",
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "versions": {"pyscf": pyscf.__version__, "numpy": np.__version__, "python": platform.python_version()},
        "bohrToAngstrom": BOHR_TO_ANGSTROM,
        "basis": basis_meta,
        "systems": records,
    }
    with open(os.path.normpath(OUT_PATH), "w") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"Wrote {os.path.normpath(OUT_PATH)}: {len(records)} systems (PySCF {pyscf.__version__})")


if __name__ == "__main__":
    main()
