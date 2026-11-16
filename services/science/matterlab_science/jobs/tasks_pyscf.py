"""PySCF job task: single-point Hartree-Fock or Kohn-Sham DFT."""

from __future__ import annotations

from typing import Any

import numpy as np

from .qm_common import PreparedSystem, conversions, prepare_system
from .runtime import TaskFailure, TaskOutcome, Unsupported, WorkerContext
from .tasks_rdkit import check_atom_limit


def _software(system: PreparedSystem) -> dict[str, str]:
    import numpy
    import pyscf
    import scipy
    from pyscf.dft import libxc

    versions = {**system.software, "pyscf": pyscf.__version__, "numpy": numpy.__version__, "scipy": scipy.__version__}
    libxc_version = getattr(libxc, "__version__", None)
    if libxc_version:
        versions["libxc"] = str(libxc_version)
    return versions


def single_point(job_input: dict[str, Any], settings: dict[str, Any], ctx: WorkerContext) -> TaskOutcome:
    system = prepare_system(job_input, settings["random_seed"], ctx)
    check_atom_limit(len(system.numbers), ctx.limits["max_atoms_pyscf"], "PySCF calculations")

    from pyscf import dft, gto, scf
    from pyscf.dft import libxc
    from pyscf.gto.basis import BasisNotFoundError

    basis = settings["basis"]
    functional = settings["functional"]
    unrestricted = system.multiplicity > 1
    is_dft = settings["method"] == "dft"

    if is_dft:
        try:
            libxc.parse_xc(functional)
        except Exception as exc:
            raise Unsupported(
                f"PySCF (libxc) does not know the exchange-correlation functional {functional!r}.",
                reasons=[str(exc).strip() or type(exc).__name__],
            ) from exc

    try:
        mol = gto.M(
            atom=[(symbol, tuple(float(v) for v in xyz)) for symbol, xyz in zip(system.symbols, system.positions)],
            unit="Angstrom",
            basis=basis,
            charge=system.charge,
            spin=system.multiplicity - 1,
            verbose=0,
        )
    except BasisNotFoundError as exc:
        text = " ".join(str(exc).split())
        raise Unsupported(f"PySCF has no basis set {basis!r} for this system: {text}", reasons=[text]) from exc
    except Exception as exc:
        raise TaskFailure("engine_error", f"PySCF could not build the molecule: {' '.join(str(exc).split())}", {"exception": type(exc).__name__}) from exc

    basis_functions = int(mol.nao)
    limit = ctx.limits["max_basis_functions_pyscf"]
    if basis_functions > limit:
        raise Unsupported(
            f"The calculation needs {basis_functions} basis functions; this service runs PySCF with at most {limit}.",
            reasons=[f"{basis_functions} basis functions exceed the configured limit of {limit}"],
            details={"basis_function_count": basis_functions, "max_basis_functions": limit},
        )

    if is_dft:
        mf = dft.UKS(mol) if unrestricted else dft.RKS(mol)
        mf.xc = functional
        mf.grids.level = int(settings["grid_level"])
    else:
        mf = scf.UHF(mol) if unrestricted else scf.RHF(mol)
    scf_type = ("UKS" if unrestricted else "RKS") if is_dft else ("UHF" if unrestricted else "RHF")
    level = f"{scf_type}/{functional}/{basis}" if is_dft else f"{scf_type}/{basis}"
    mf.max_cycle = int(settings["max_scf_cycles"])
    mf.conv_tol = float(settings["convergence_tolerance_hartree"])
    mf.chkfile = None

    cycles: list[float] = []

    def on_cycle(envs: dict[str, Any]) -> None:
        cycles.append(float(envs["e_tot"]))
        ctx.progress(0.2 + 0.7 * min(len(cycles) / mf.max_cycle, 1.0), f"SCF cycle {len(cycles)}: E = {cycles[-1]:.10f} Eh")

    mf.callback = on_cycle
    ctx.progress(0.2, f"Running {level} with PySCF ({basis_functions} basis functions, {system.electron_count} electrons).")
    try:
        energy = float(mf.kernel())
    except Exception as exc:
        raise TaskFailure("engine_error", f"PySCF reported an error: {' '.join(str(exc).split())}", {"exception": type(exc).__name__}) from exc

    if not bool(mf.converged):
        raise TaskFailure(
            "scf_not_converged",
            f"The {level} SCF did not converge within {mf.max_cycle} cycles. No energy is reported because an unconverged SCF energy is not a result.",
            {"scf_cycles": len(cycles), "last_energy_hartree": cycles[-1] if cycles else None, "max_scf_cycles": mf.max_cycle},
        )
    if not np.isfinite(energy):
        raise TaskFailure("non_finite_result", "PySCF returned a non-finite energy; the calculation is not usable.")

    factors = conversions()
    to_ev = factors["hartree_to_ev"]
    n_alpha, n_beta = (int(n) for n in mol.nelec)
    if unrestricted:
        alpha = [float(v) for v in mf.mo_energy[0]]
        beta = [float(v) for v in mf.mo_energy[1]]
        alpha_occ = [float(v) for v in mf.mo_occ[0]]
        beta_occ = [float(v) for v in mf.mo_occ[1]]
        occupied = [alpha[n_alpha - 1]] if n_alpha else []
        if n_beta:
            occupied.append(beta[n_beta - 1])
        virtual = ([alpha[n_alpha]] if n_alpha < len(alpha) else []) + ([beta[n_beta]] if n_beta < len(beta) else [])
        spin_square = float(mf.spin_square()[0])
    else:
        alpha = [float(v) for v in mf.mo_energy]
        alpha_occ = [float(v) for v in mf.mo_occ]
        beta = beta_occ = None
        occupied = [alpha[n_alpha - 1]] if n_alpha else []
        virtual = [alpha[n_alpha]] if n_alpha < len(alpha) else []
        spin_square = None
    homo = max(occupied) if occupied else None
    lumo = min(virtual) if virtual else None

    _population, charges = mf.mulliken_pop(verbose=0)
    dipole = np.asarray(mf.dip_moment(unit="Debye", verbose=0), dtype=float)

    document = {
        "scf_type": scf_type,
        "method": level,
        "functional": functional if is_dft else None,
        "basis": basis,
        "grid_level": int(settings["grid_level"]) if is_dft else None,
        "charge": system.charge,
        "multiplicity": system.multiplicity,
        "electron_count": system.electron_count,
        "basis_function_count": basis_functions,
        "geometry": system.geometry,
        "converged": True,
        "scf_cycles": len(cycles),
        "energy_hartree": energy,
        "energy_ev": energy * to_ev,
        "nuclear_repulsion_hartree": float(mol.energy_nuc()),
        "orbital_energies_hartree": alpha,
        "orbital_occupations": alpha_occ,
        "beta_orbital_energies_hartree": beta,
        "beta_orbital_occupations": beta_occ,
        "homo_energy_hartree": homo,
        "lumo_energy_hartree": lumo,
        "homo_lumo_gap_ev": None if homo is None or lumo is None else (lumo - homo) * to_ev,
        "spin_square": spin_square,
        "mulliken_charges_e": [float(v) for v in np.asarray(charges, dtype=float)],
        "dipole_debye": [float(v) for v in dipole],
        "dipole_magnitude_debye": float(np.linalg.norm(dipole)),
        "atoms": system.atoms(),
        "units": {
            "coordinates": "angstrom",
            "energy": "hartree (energy_ev and homo_lumo_gap_ev in eV)",
            "orbital_energies": "hartree",
            "mulliken_charges": "e",
            "dipole": "debye",
        },
        "conversions": factors,
        "warnings": list(system.warnings),
    }
    return TaskOutcome(result=document, method=level, converged=True, software=_software(system))
