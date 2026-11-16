#!/usr/bin/env python3
"""Generates the PySCF reference for one large, spatially extended molecule.

    docker run --rm -e OMP_NUM_THREADS=2 -v "${PWD}\\packages\\quantum:/work" python:3.12-slim `
        bash -c "pip install -q pyscf && cd /work/tools && python gen_large.py"

Output: packages/quantum/test/fixtures/pyscf_large.json

The all-trans alkane C13H28 has 93 STO-3G basis functions, just below the engine's default limit of
96, and is long enough (about 16 angstrom) for integral screening to remove a large part of the
two-electron integrals. It checks that screening and the handling of a nearly full-size integral
table do not cost accuracy. Same basis-set snapshot, coordinates and conventions as
gen_reference.py; the geometry is idealised (C-C 1.53 A, C-H 1.09 A, tetrahedral angles).
"""

import datetime
import json
import math
import os
import platform

import numpy as np
import pyscf
from pyscf.data import elements

from gen_reference import BASIS_PATH, BOHR_TO_ANGSTROM, CONV_TOL, CONV_TOL_GRAD, build_mol, load_bse_basis, run_rhf

OUT_PATH = os.path.normpath(os.path.join(os.path.dirname(BASIS_PATH), "..", "test", "fixtures", "pyscf_large.json"))


def alkane(n):
    """All-trans C_nH_(2n+2): planar zigzag chain along x, two H per carbon out of plane, one more in plane at each end."""
    cc, ch = 1.53, 1.09
    half = math.radians(109.4712) / 2
    sin, cos = math.sin(half), math.cos(half)

    def carbon(i):
        return np.array([i * cc * sin, cc * cos if i % 2 else 0.0, 0.0])

    symbols, xyz = [], []
    for i in range(n):
        symbols.append("C")
        xyz.append(carbon(i))
    for i in range(n):
        c = carbon(i)
        away = 1.0 if i % 2 else -1.0
        for sign in (1.0, -1.0):
            symbols.append("H")
            xyz.append(c + np.array([0.0, away * ch * cos, sign * ch * sin]))
        for neighbour in (i - 1, i + 1):
            if 0 <= neighbour < n:
                continue
            symbols.append("H")
            xyz.append(c + (carbon(neighbour) - c) * ch / cc)
    return symbols, np.array(xyz)


def main():
    basis_by_z, basis_meta = load_bse_basis(BASIS_PATH)
    symbols, xyz = alkane(13)
    # A general orientation, so that no Cartesian axis is special.
    a, b = 0.41, 0.77
    rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    xyz = xyz @ (rz @ ry).T + np.array([0.3, -0.2, 0.5])

    system = {"name": "C13H28", "charge": 0, "symbols": symbols, "xyz": xyz}
    basis = {s: basis_by_z[elements.charge(s)] for s in set(symbols)}
    mol = build_mol(system, basis)
    mf = run_rhf(mol)
    if not mf.converged:
        raise RuntimeError("PySCF did not converge")
    dm = mf.make_rdm1()
    s = mol.intor_symmetric("int1e_ovlp")
    z = np.array([elements.charge(sym) for sym in symbols], dtype=float)
    gross = np.einsum("ij,ji->i", dm, s)
    charges = [float(z[atom] - gross[ao0:ao1].sum()) for atom, (_s0, _s1, ao0, ao1) in enumerate(mol.aoslice_by_atom())]
    coords = mol.atom_coords()
    origin = (z[:, None] * coords).sum(axis=0) / z.sum()
    with mol.with_common_orig(origin):
        r = mol.intor_symmetric("int1e_r", comp=3)
    dipole = (z[:, None] * (coords - origin)).sum(axis=0) - np.einsum("xij,ji->x", r, dm)
    _mo_i, _mo_e, stable_internal, _stable_external = mf.stability(internal=True, external=False, return_status=True)

    fixture = {
        "description": "RHF/STO-3G reference for all-trans C13H28 from PySCF. Atomic units; positions in angstrom.",
        "generator": "packages/quantum/tools/gen_large.py",
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "versions": {"pyscf": pyscf.__version__, "numpy": np.__version__, "python": platform.python_version()},
        "bohrToAngstrom": BOHR_TO_ANGSTROM,
        "basis": basis_meta,
        "settings": {"conv_tol": CONV_TOL, "conv_tol_grad": CONV_TOL_GRAD, "direct_scf": False},
        "molecule": {
            "name": "C13H28",
            "charge": 0,
            "atoms": [{"z": int(zz), "position": [float(c) for c in row]} for zz, row in zip(z, xyz)],
            "nBasis": int(mol.nao),
            "nElectrons": int(mol.nelectron),
            "energy": {"total": float(mf.e_tot), "nuclearRepulsion": float(mol.energy_nuc())},
            "orbitalEnergies": [float(e) for e in mf.mo_energy],
            "mullikenCharges": charges,
            "dipoleAu": [float(d) for d in dipole],
            "internalStable": bool(stable_internal),
        },
    }
    with open(OUT_PATH, "w") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"Wrote {OUT_PATH}: C13H28, {mol.nao} basis functions, E = {mf.e_tot:.10f} (PySCF {pyscf.__version__})")


if __name__ == "__main__":
    main()
