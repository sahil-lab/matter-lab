#!/usr/bin/env python3
"""Generates the PySCF reference fixture for the @matterlab/quantum validation tests.

Run inside a throw-away container from the repository root (PowerShell):

    docker run --rm -v "${PWD}\\packages\\quantum:/work" python:3.12-slim `
        bash -c "pip install -q pyscf && python /work/tools/gen_reference.py"

Output: packages/quantum/test/fixtures/pyscf_reference.json

What makes the comparison meaningful
------------------------------------
* Same basis-set numbers. PySCF is NOT asked for its built-in "sto-3g"; it is given the very
  Basis Set Exchange snapshot the TypeScript engine ships (data/sto-3g.bse.json), SP shells split
  into an s and a p shell with shared exponents. (The built-in basis is also run once per molecule
  and its energy stored as `builtinSto3gTotalEnergy`, purely to document how much the choice of
  parameter table matters.)
* Same geometry. Coordinates are generated here in angstrom, stored in the fixture with full
  double precision and handed to PySCF in bohr using the same conversion constant as
  @matterlab/core (CODATA 2018, 0.529177210903 angstrom per bohr).
* s and p functions only, so spherical and Cartesian Gaussians coincide.

The geometries are idealised structures built from round bond lengths and angles chosen by the
author of this script. They are inputs shared by both programs, not reference data, and no claim
is made that they are experimental or optimised structures.
"""

import datetime
import hashlib
import json
import math
import os
import platform
import sys

import numpy as np
import pyscf
from pyscf import gto, scf
from pyscf.data import elements

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
BASIS_PATH = os.path.join(PACKAGE, "data", "sto-3g.bse.json")
OUT_PATH = os.path.join(PACKAGE, "test", "fixtures", "pyscf_reference.json")

# Bohr radius in angstrom, CODATA 2018: the value of BOHR_TO_ANGSTROM in packages/core/src/constants.ts.
BOHR_TO_ANGSTROM = 0.529177210903

CONV_TOL = 1e-12
CONV_TOL_GRAD = 1e-9


# --------------------------------------------------------------------------------------------
# Basis set: the committed Basis Set Exchange snapshot, converted to PySCF's list format.
# --------------------------------------------------------------------------------------------
def load_bse_basis(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    data = json.loads(raw)
    basis = {}
    for z_text, element in data["elements"].items():
        shells = []
        for shell in element["electron_shells"]:
            exponents = [float(x) for x in shell["exponents"]]
            for l, coefficients in zip(shell["angular_momentum"], shell["coefficients"]):
                shells.append([l] + [[e, float(c)] for e, c in zip(exponents, coefficients)])
        basis[int(z_text)] = shells
    meta = {
        "name": data["name"],
        "version": data["version"],
        "revisionDescription": data["revision_description"],
        "revisionDate": data["revision_date"],
        "snapshot": "packages/quantum/data/sto-3g.bse.json",
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    return basis, meta


# --------------------------------------------------------------------------------------------
# Geometries (angstrom). Idealised, see the module docstring.
# --------------------------------------------------------------------------------------------
def deg(x):
    return x * math.pi / 180.0


def diatomic(a, b, r):
    return [(a, 0.0, 0.0, -r / 2), (b, 0.0, 0.0, r / 2)]


def bent(centre, outer, r, angle_deg):
    half = deg(angle_deg) / 2
    return [(centre, 0.0, 0.0, 0.0), (outer, r * math.sin(half), 0.0, r * math.cos(half)), (outer, -r * math.sin(half), 0.0, r * math.cos(half))]


def pyramidal(centre, outer, r, angle_deg):
    """C3v XY3 with Y-X-Y angle `angle_deg`."""
    beta = math.asin(2 * math.sin(deg(angle_deg) / 2) / math.sqrt(3))
    atoms = [(centre, 0.0, 0.0, 0.0)]
    for k in range(3):
        phi = 2 * math.pi * k / 3
        atoms.append((outer, r * math.sin(beta) * math.cos(phi), r * math.sin(beta) * math.sin(phi), -r * math.cos(beta)))
    return atoms


def trigonal_planar(centre, outer, r):
    atoms = [(centre, 0.0, 0.0, 0.0)]
    for k in range(3):
        phi = 2 * math.pi * k / 3
        atoms.append((outer, r * math.cos(phi), r * math.sin(phi), 0.0))
    return atoms


def tetrahedral(centre, outer, r):
    s = r / math.sqrt(3)
    return [(centre, 0.0, 0.0, 0.0), (outer, s, s, s), (outer, s, -s, -s), (outer, -s, s, -s), (outer, -s, -s, s)]


def linear(symbols, bonds):
    z = [0.0]
    for b in bonds:
        z.append(z[-1] + b)
    return [(s, 0.0, 0.0, zz) for s, zz in zip(symbols, z)]


def ethylene(cc, ch, hch_deg):
    gamma = deg((360.0 - hch_deg) / 2)  # H-C-C angle
    atoms = [("C", 0.0, 0.0, cc / 2), ("C", 0.0, 0.0, -cc / 2)]
    for sz in (1, -1):
        for sx in (1, -1):
            atoms.append(("H", sx * ch * math.sin(gamma), 0.0, sz * (cc / 2 - ch * math.cos(gamma))))
    return atoms


def formaldehyde(co, ch, hch_deg):
    half = deg(hch_deg) / 2
    return [("C", 0.0, 0.0, 0.0), ("O", 0.0, 0.0, co), ("H", ch * math.sin(half), 0.0, -ch * math.cos(half)), ("H", -ch * math.sin(half), 0.0, -ch * math.cos(half))]


def benzene(cc, ch):
    atoms = []
    for k in range(6):
        phi = math.pi * k / 3
        atoms.append(("C", cc * math.cos(phi), cc * math.sin(phi), 0.0))
    for k in range(6):
        phi = math.pi * k / 3
        atoms.append(("H", (cc + ch) * math.cos(phi), (cc + ch) * math.sin(phi), 0.0))
    return atoms


def ethane(cc, ch, hcc_deg):
    """Staggered ethane."""
    theta = deg(hcc_deg)
    atoms = [("C", 0.0, 0.0, cc / 2), ("C", 0.0, 0.0, -cc / 2)]
    for sz, offset in ((1, 0.0), (-1, math.pi / 3)):
        for k in range(3):
            phi = 2 * math.pi * k / 3 + offset
            atoms.append(("H", ch * math.sin(theta) * math.cos(phi), ch * math.sin(theta) * math.sin(phi), sz * (cc / 2 - ch * math.cos(theta))))
    return atoms


# name, charge, atoms in a canonical (symmetric) orientation
CANONICAL = [
    ("H2", 0, diatomic("H", "H", 0.74)),
    ("HeH+", 1, diatomic("He", "H", 0.774)),
    ("LiH", 0, diatomic("Li", "H", 1.595)),
    ("H2O", 0, bent("O", "H", 0.9572, 104.52)),
    ("NH3", 0, pyramidal("N", "H", 1.012, 106.67)),
    ("CH4", 0, tetrahedral("C", "H", 1.087)),
    ("HF", 0, diatomic("H", "F", 0.917)),
    ("N2", 0, diatomic("N", "N", 1.098)),
    ("CO", 0, diatomic("C", "O", 1.128)),
    ("CO2", 0, linear(["O", "C", "O"], [1.16, 1.16])),
    ("HCN", 0, linear(["H", "C", "N"], [1.064, 1.156])),
    ("C2H4", 0, ethylene(1.339, 1.087, 117.4)),
    ("C2H2", 0, linear(["H", "C", "C", "H"], [1.063, 1.203, 1.063])),
    ("H2S", 0, bent("S", "H", 1.336, 92.1)),
    ("HCl", 0, diatomic("H", "Cl", 1.275)),
    ("SiH4", 0, tetrahedral("Si", "H", 1.48)),
    ("PH3", 0, pyramidal("P", "H", 1.42, 93.3)),
    ("NH4+", 1, tetrahedral("N", "H", 1.02)),
    ("OH-", -1, diatomic("O", "H", 0.964)),
    ("H2CO", 0, formaldehyde(1.205, 1.111, 116.1)),
    ("C6H6", 0, benzene(1.397, 1.084)),
    # Beyond the required set: more third-period atoms, ions, closed-shell atoms.
    ("He", 0, [("He", 0.0, 0.0, 0.0)]),
    ("Be", 0, [("Be", 0.0, 0.0, 0.0)]),
    ("Ne", 0, [("Ne", 0.0, 0.0, 0.0)]),
    ("Mg", 0, [("Mg", 0.0, 0.0, 0.0)]),
    ("Ar", 0, [("Ar", 0.0, 0.0, 0.0)]),
    ("BeH2", 0, linear(["H", "Be", "H"], [1.33, 1.33])),
    ("BH3", 0, trigonal_planar("B", "H", 1.19)),
    ("LiF", 0, diatomic("Li", "F", 1.564)),
    ("F2", 0, diatomic("F", "F", 1.412)),
    ("NaH", 0, diatomic("Na", "H", 1.887)),
    ("NaCl", 0, diatomic("Na", "Cl", 2.361)),
    ("MgH2", 0, linear(["H", "Mg", "H"], [1.7, 1.7])),
    ("AlH3", 0, trigonal_planar("Al", "H", 1.58)),
    ("Cl2", 0, diatomic("Cl", "Cl", 1.988)),
    ("CS", 0, diatomic("C", "S", 1.535)),
    ("SO2", 0, bent("S", "O", 1.431, 119.3)),
    ("H3O+", 1, pyramidal("O", "H", 0.98, 113.0)),
    ("CN-", -1, diatomic("C", "N", 1.18)),
    ("C2H6", 0, ethane(1.535, 1.094, 111.2)),
]

# Systems that are additionally stored in their canonical orientation (symmetry axes along the
# Cartesian axes), to exercise exact zeros and degeneracies as well as the general case.
ALSO_CANONICAL = {"H2", "H2O", "N2", "CO2", "C2H4", "C6H6", "HCl", "Ar"}

# Element-wise integral matrices are stored for these (small) systems.
INTEGRAL_SYSTEMS = {"LiH", "HCl", "H2S", "SiH4", "NaCl"}

# Density / orbital / electrostatic-potential values at sample points are stored for these.
FIELD_SYSTEMS = {"H2O", "NH4+", "OH-", "HCl", "C2H4", "LiH"}


def rotation(index):
    """A different general rotation for every system (Rz Ry Rx with irrational-looking angles)."""
    a = 0.37 + 0.611 * index
    b = 0.59 + 0.377 * index
    c = 1.13 + 0.233 * index
    rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    rx = np.array([[1, 0, 0], [0, math.cos(c), -math.sin(c)], [0, math.sin(c), math.cos(c)]])
    return rz @ ry @ rx


def systems():
    out = []
    for index, (name, charge, atoms) in enumerate(CANONICAL):
        symbols = [a[0] for a in atoms]
        xyz = np.array([[a[1], a[2], a[3]] for a in atoms], dtype=float)
        shift = np.array([0.4 + 0.05 * index, -0.3 + 0.03 * index, 0.2 - 0.04 * index])
        out.append({"name": name, "orientation": "general", "charge": charge, "symbols": symbols, "xyz": xyz @ rotation(index).T + shift})
        if name in ALSO_CANONICAL:
            out.append({"name": name, "orientation": "canonical", "charge": charge, "symbols": symbols, "xyz": xyz})
    return out


# --------------------------------------------------------------------------------------------
# Reference calculations
# --------------------------------------------------------------------------------------------
def build_mol(system, basis):
    mol = gto.Mole()
    bohr = system["xyz"] / BOHR_TO_ANGSTROM
    mol.atom = [[s, tuple(float(v) for v in row)] for s, row in zip(system["symbols"], bohr)]
    mol.unit = "Bohr"
    mol.charge = system["charge"]
    mol.spin = 0
    mol.symmetry = False
    mol.cart = False
    mol.verbose = 0
    mol.basis = basis
    mol.build()
    return mol


def run_rhf(mol, init_guess="minao"):
    mf = scf.RHF(mol)
    mf.conv_tol = CONV_TOL
    mf.conv_tol_grad = CONV_TOL_GRAD
    mf.max_cycle = 500
    mf.init_guess = init_guess
    mf.direct_scf = False
    mf.kernel()
    return mf


def ao_keys(mol):
    """AO labels in the form used by the TypeScript tests: '<atom index>:<shell>', e.g. '0:2px'."""
    return [f"{ia}:{nl}{m}" for ia, _symbol, nl, m in mol.ao_labels(fmt=False)]


def pack_eri(eri, n):
    """Unique integrals (ij|kl), i>=j, k>=l, ij>=kl, at index ij(ij+1)/2+kl with ij=i(i+1)/2+j."""
    values = []
    for i in range(n):
        for j in range(i + 1):
            ij = i * (i + 1) // 2 + j
            for k in range(n):
                for l in range(k + 1):
                    kl = k * (k + 1) // 2 + l
                    if kl <= ij:
                        values.append(float(eri[i, j, k, l]))
    return values


def sample_points(xyz, seed):
    """Points in angstrom: near the molecule and far away along random directions."""
    rng = np.random.default_rng(seed)
    lo = xyz.min(axis=0) - 2.5
    hi = xyz.max(axis=0) + 2.5
    near = rng.uniform(lo, hi, size=(24, 3))
    centre = xyz.mean(axis=0)
    far = []
    for distance in (6.0, 10.0, 20.0, 40.0, 80.0, 160.0):
        direction = rng.normal(size=3)
        direction /= np.linalg.norm(direction)
        far.append(centre + distance * direction)
    return np.vstack([near, np.array(far)])


def main():
    basis_by_z, basis_meta = load_bse_basis(BASIS_PATH)
    molecules = []
    integrals = []
    fields = []

    for index, system in enumerate(systems()):
        z = [elements.charge(s) for s in system["symbols"]]
        basis = {s: basis_by_z[elements.charge(s)] for s in set(system["symbols"])}
        mol = build_mol(system, basis)
        mf = run_rhf(mol)
        if not mf.converged:
            raise RuntimeError(f"PySCF did not converge for {system['name']}")

        dm = mf.make_rdm1()
        s = mol.intor_symmetric("int1e_ovlp")
        t = mol.intor_symmetric("int1e_kin")
        v = mol.intor_symmetric("int1e_nuc")
        vhf = mf.get_veff(mol, dm)
        e_kin = float(np.einsum("ij,ji", dm, t))
        e_att = float(np.einsum("ij,ji", dm, v))
        e_two = float(0.5 * np.einsum("ij,ji", dm, vhf))
        e_nuc = float(mol.energy_nuc())
        if abs(e_kin + e_att + e_two + e_nuc - mf.e_tot) > 1e-9:
            raise RuntimeError(f"Energy components do not add up for {system['name']}")

        # Mulliken net charges, written out explicitly and cross-checked against PySCF's own routine.
        gross = np.einsum("ij,ji->i", dm, s)
        charges = []
        for atom, (_sh0, _sh1, ao0, ao1) in enumerate(mol.aoslice_by_atom()):
            charges.append(float(z[atom] - gross[ao0:ao1].sum()))
        _pop, pyscf_charges = mf.mulliken_pop(mol, dm, s, verbose=0)
        if np.max(np.abs(np.array(charges) - pyscf_charges)) > 1e-10:
            raise RuntimeError(f"Mulliken charges disagree with PySCF's routine for {system['name']}")

        # Dipole moment in e a0 about the centre of nuclear charge (origin-independent when neutral).
        coords = mol.atom_coords()
        zs = np.array(z, dtype=float)
        origin = (zs[:, None] * coords).sum(axis=0) / zs.sum()
        with mol.with_common_orig(origin):
            r = mol.intor_symmetric("int1e_r", comp=3)
        dipole = (zs[:, None] * (coords - origin)).sum(axis=0) - np.einsum("xij,ji->x", r, dm)
        if system["charge"] == 0:
            pyscf_dipole = mf.dip_moment(mol, dm, unit="AU", verbose=0)
            if np.max(np.abs(dipole - pyscf_dipole)) > 1e-9:
                raise RuntimeError(f"Dipole disagrees with PySCF's routine for {system['name']}")

        # Is the solution a true minimum within RHF (internal) and with respect to UHF (external)?
        try:
            _mo_i, _mo_e, stable_internal, stable_external = mf.stability(internal=True, external=True, return_status=True)
            stable_internal = bool(stable_internal)
            stable_external = bool(stable_external)
        except Exception as error:  # pragma: no cover - depends on the PySCF version
            print(f"  stability analysis unavailable: {error}", file=sys.stderr)
            stable_internal = None
            stable_external = None

        # Same calculation started from the core-Hamiltonian guess (what the TypeScript engine uses).
        mf_core = run_rhf(mol, init_guess="1e")

        # Same geometry with PySCF's own "sto-3g" table instead of the Basis Set Exchange snapshot.
        system_builtin = dict(system)
        mf_builtin = run_rhf(build_mol(system_builtin, "sto-3g"))

        nocc = mol.nelectron // 2
        record = {
            "name": system["name"],
            "orientation": system["orientation"],
            "charge": system["charge"],
            "atoms": [{"z": int(zz), "position": [float(c) for c in row]} for zz, row in zip(z, system["xyz"])],
            "nBasis": int(mol.nao),
            "nElectrons": int(mol.nelectron),
            "nOccupied": int(nocc),
            "converged": bool(mf.converged),
            "energy": {
                "total": float(mf.e_tot),
                "electronic": float(mf.e_tot - e_nuc),
                "nuclearRepulsion": e_nuc,
                "kinetic": e_kin,
                "nuclearAttraction": e_att,
                "twoElectron": e_two,
            },
            "orbitalEnergies": [float(e) for e in mf.mo_energy],
            "mullikenCharges": charges,
            "dipoleAu": [float(d) for d in dipole],
            "dipoleOriginBohr": [float(o) for o in origin],
            "internalStable": stable_internal,
            "externalStable": stable_external,
            "coreGuess": {"converged": bool(mf_core.converged), "totalEnergy": float(mf_core.e_tot)},
            "builtinSto3gTotalEnergy": float(mf_builtin.e_tot) if mf_builtin.converged else None,
        }
        molecules.append(record)
        print(
            f"{system['name']:6s} {system['orientation']:9s} nbf={mol.nao:3d} E={mf.e_tot:.10f} "
            f"core-guess dE={mf_core.e_tot - mf.e_tot:+.2e} builtin dE={mf_builtin.e_tot - mf.e_tot:+.2e} "
            f"stable(int/ext)={stable_internal}/{stable_external}",
            flush=True,
        )

        if system["name"] in INTEGRAL_SYSTEMS and system["orientation"] == "general":
            n = mol.nao
            with mol.with_common_orig((0.0, 0.0, 0.0)):
                r0 = mol.intor_symmetric("int1e_r", comp=3)
            integrals.append(
                {
                    "name": system["name"],
                    "orientation": system["orientation"],
                    "aoLabels": ao_keys(mol),
                    "overlap": s.tolist(),
                    "kinetic": t.tolist(),
                    "nuclearAttraction": v.tolist(),
                    "position": [r0[axis].tolist() for axis in range(3)],
                    "eriPacking": "unique (ij|kl) with i>=j, k>=l, ij>=kl at ij(ij+1)/2+kl, ij=i(i+1)/2+j, in the order of aoLabels",
                    "eri": pack_eri(mol.intor("int2e", aosym="s1"), n),
                }
            )

        if system["name"] in FIELD_SYSTEMS and system["orientation"] == "general":
            points = sample_points(system["xyz"], seed=1000 + index)
            points_bohr = points / BOHR_TO_ANGSTROM
            ao = mol.eval_gto("GTOval", points_bohr)
            density = np.einsum("pi,ij,pj->p", ao, dm, ao)
            orbitals = ao @ mf.mo_coeff
            esp = []
            for point in points_bohr:
                with mol.with_rinv_origin(point):
                    rinv = mol.intor("int1e_rinv")
                electronic = -float(np.einsum("ij,ji", rinv, dm))
                nuclear = float((zs / np.linalg.norm(coords - point, axis=1)).sum())
                esp.append(nuclear + electronic)
            fields.append(
                {
                    "name": system["name"],
                    "orientation": system["orientation"],
                    "pointsAngstrom": points.tolist(),
                    "density": density.tolist(),
                    "esp": esp,
                    "orbitals": orbitals.T.tolist(),
                }
            )

    fixture = {
        "description": "RHF/STO-3G reference values from PySCF for the @matterlab/quantum tests. Atomic units unless stated; positions in angstrom.",
        "generator": "packages/quantum/tools/gen_reference.py",
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "versions": {
            "pyscf": pyscf.__version__,
            "numpy": np.__version__,
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "bohrToAngstrom": BOHR_TO_ANGSTROM,
        "basis": basis_meta,
        "settings": {
            "method": "RHF",
            "conv_tol": CONV_TOL,
            "conv_tol_grad": CONV_TOL_GRAD,
            "init_guess": "minao",
            "dipoleOrigin": "centre of nuclear charge",
            "units": {"energy": "hartree", "dipole": "e a0", "charge": "e", "density": "e/bohr^3", "esp": "hartree/e", "orbitals": "bohr^-3/2"},
        },
        "molecules": molecules,
        "integrals": integrals,
        "fields": fields,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as handle:
        json.dump(fixture, handle, indent=1)
        handle.write("\n")
    print(f"Wrote {OUT_PATH}: {len(molecules)} systems, {len(integrals)} integral sets, {len(fields)} field sets (PySCF {pyscf.__version__})")


if __name__ == "__main__":
    main()
