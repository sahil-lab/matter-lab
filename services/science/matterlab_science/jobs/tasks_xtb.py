"""GFN-xTB job tasks, computed by tblite (single points) and tblite + ASE (geometry optimisation)."""

from __future__ import annotations

from typing import Any

import numpy as np

from .qm_common import (
    PreparedSystem,
    boltzmann_hartree_per_kelvin,
    conversions,
    elementary_charge_angstrom_to_debye,
    frontier_gap_ev,
    prepare_system,
)
from .runtime import TaskFailure, TaskOutcome, Unsupported, WorkerContext
from .tasks_rdkit import check_atom_limit

_MAX_ATOMIC_NUMBER = 86


def _check_supported(system: PreparedSystem, ctx: WorkerContext) -> None:
    check_atom_limit(len(system.numbers), ctx.limits["max_atoms_xtb"], "GFN-xTB calculations")
    heavy = sorted({(number, symbol) for number, symbol in zip(system.numbers, system.symbols) if number > _MAX_ATOMIC_NUMBER})
    if heavy:
        raise Unsupported(
            f"GFN-xTB as implemented in tblite is parametrised for elements up to Z = {_MAX_ATOMIC_NUMBER}.",
            reasons=[f"{symbol} (Z = {number}) has no GFN-xTB parameters" for number, symbol in heavy],
        )


def _engine_failure(exc: Exception) -> Exception:
    text = str(exc).strip() or type(exc).__name__
    lowered = text.lower()
    if "not converged" in lowered:
        return TaskFailure("scf_not_converged", f"tblite: {text}. No energy is reported because the self-consistent cycle did not converge.")
    if "no support for elements" in lowered:
        return Unsupported(f"tblite: {text}", reasons=[text])
    return TaskFailure("engine_error", f"tblite reported an error: {text}", {"exception": type(exc).__name__})


def _software(system: PreparedSystem, *, with_ase: bool) -> dict[str, str]:
    import numpy
    import scipy
    from tblite import library

    versions = {**system.software, "tblite": ".".join(str(p) for p in library.get_version()), "numpy": numpy.__version__, "scipy": scipy.__version__}
    if with_ase:
        import ase

        versions["ase"] = ase.__version__
    return versions


def _finite(values: Any, what: str) -> None:
    if not np.all(np.isfinite(np.asarray(values, dtype=float))):
        raise TaskFailure("non_finite_result", f"tblite returned a non-finite {what}; the calculation is not usable.")


def single_point(job_input: dict[str, Any], settings: dict[str, Any], ctx: WorkerContext) -> TaskOutcome:
    system = prepare_system(job_input, settings["random_seed"], ctx)
    _check_supported(system, ctx)
    ctx.progress(0.2, f"Geometry ready ({len(system.numbers)} atoms). Running {settings['method']} with tblite.")

    from tblite.interface import Calculator

    factors = conversions()
    bohr = factors["bohr_to_angstrom"]
    try:
        calc = Calculator(
            settings["method"],
            np.array(system.numbers),
            system.positions / bohr,
            charge=float(system.charge),
            uhf=system.multiplicity - 1,
        )
        calc.set("verbosity", 0)
        calc.set("accuracy", float(settings["accuracy"]))
        calc.set("max-iter", int(settings["max_scf_iterations"]))
        calc.set("temperature", float(settings["electronic_temperature_k"]) * boltzmann_hartree_per_kelvin())
        result = calc.singlepoint()
    except Exception as exc:
        raise _engine_failure(exc) from exc

    energy = float(result.get("energy"))
    gradient = np.asarray(result.get("gradient"), dtype=float)
    charges = np.asarray(result.get("charges"), dtype=float)
    dipole = np.asarray(result.get("dipole"), dtype=float) * factors["atomic_unit_of_dipole_to_debye"]
    orbital_energies = np.asarray(result.get("orbital-energies"), dtype=float)
    occupations = np.asarray(result.get("orbital-occupations"), dtype=float)
    _finite([energy], "energy")
    _finite(gradient, "gradient")
    _finite(charges, "set of partial charges")

    warnings = list(system.warnings)
    spin_resolved = orbital_energies.ndim == 2
    if spin_resolved:
        # Spin-polarised output: report the alpha channel and say so.
        warnings.append("tblite returned spin-resolved orbitals; the alpha channel is reported.")
        orbital_energies, occupations = orbital_energies[0], occupations[0]
    energies_list = [float(v) for v in orbital_energies]
    occupations_list = [float(v) for v in occupations]

    orders = np.asarray(result.get("bond-orders"), dtype=float)
    orders = orders.reshape(len(system.numbers), len(system.numbers), -1).sum(axis=-1)
    bond_orders = [
        {"begin_atom_index": i, "end_atom_index": j, "wiberg_bond_order": float(orders[i, j])}
        for i in range(len(system.numbers))
        for j in range(i + 1, len(system.numbers))
        if orders[i, j] > 0.05
    ]

    document = {
        "method": settings["method"],
        "charge": system.charge,
        "multiplicity": system.multiplicity,
        "electron_count": system.electron_count,
        "geometry": system.geometry,
        "converged": True,
        "energy_hartree": energy,
        "energy_ev": energy * factors["hartree_to_ev"],
        "gradient_rms_hartree_per_bohr": float(np.sqrt(np.mean(gradient**2))),
        "gradient_max_hartree_per_bohr": float(np.abs(gradient).max()),
        "partial_charges_e": [float(v) for v in charges],
        "dipole_debye": [float(v) for v in dipole],
        "dipole_magnitude_debye": float(np.linalg.norm(dipole)),
        "orbital_energies_hartree": energies_list,
        "orbital_occupations": occupations_list,
        "homo_lumo_gap_ev": frontier_gap_ev(energies_list, occupations_list, factors["hartree_to_ev"]),
        "bond_orders": bond_orders,
        "atoms": system.atoms(),
        "units": {
            "coordinates": "angstrom",
            "energy": "hartree (energy_ev in eV)",
            "gradient": "hartree/bohr",
            "partial_charges": "e",
            "dipole": "debye",
            "orbital_energies": "hartree",
        },
        "conversions": factors,
        "warnings": warnings,
    }
    return TaskOutcome(result=document, method=settings["method"], converged=True, software=_software(system, with_ase=False))


def geometry_optimization(job_input: dict[str, Any], settings: dict[str, Any], ctx: WorkerContext) -> TaskOutcome:
    system = prepare_system(job_input, settings["random_seed"], ctx)
    _check_supported(system, ctx)
    ctx.progress(0.1, f"Geometry ready ({len(system.numbers)} atoms). Optimising with {settings['method']} (tblite) and ASE LBFGS.")

    import ase.units
    from ase import Atoms
    from ase.optimize import LBFGS
    from tblite.ase import TBLite

    factors = conversions()
    max_steps = int(settings["max_steps"])
    tolerance = float(settings["force_tolerance_ev_per_angstrom"])

    def max_force(structure: Atoms) -> float:
        return float(np.sqrt((structure.get_forces() ** 2).sum(axis=1)).max())

    frames: list[dict[str, Any]] = []
    try:
        atoms = Atoms(numbers=system.numbers, positions=system.positions)
        atoms.calc = TBLite(
            method=settings["method"],
            charge=float(system.charge),
            multiplicity=system.multiplicity,
            accuracy=float(settings["accuracy"]),
            max_iterations=int(settings["max_scf_iterations"]),
            electronic_temperature=float(settings["electronic_temperature_k"]),
            verbosity=0,
        )
        energy_initial = float(atoms.get_potential_energy()) / ase.units.Hartree
        force_initial = max_force(atoms)
        optimizer = LBFGS(atoms, logfile=None)
        converged = False
        for converged in optimizer.irun(fmax=tolerance, steps=max_steps):
            step = int(optimizer.nsteps)
            if settings["record_trajectory"]:
                frames.append(
                    {
                        "iteration": step,
                        "energy": float(atoms.get_potential_energy()) / ase.units.Hartree,
                        "coordinates_angstrom": [[float(v) for v in row] for row in atoms.get_positions()],
                    }
                )
            ctx.progress(0.1 + 0.85 * min(step / max_steps, 1.0), None if step % 10 else f"Optimisation step {step}: max force {max_force(atoms):.4f} eV/angstrom.")
        converged = bool(converged)
        steps = int(optimizer.nsteps)
        energy_final = float(atoms.get_potential_energy()) / ase.units.Hartree
        force_final = max_force(atoms)
        charges = np.asarray(atoms.calc.results["charges"], dtype=float)
        dipole = np.asarray(atoms.calc.results["dipole"], dtype=float) * elementary_charge_angstrom_to_debye()
        positions = np.asarray(atoms.get_positions(), dtype=float)
    except (TaskFailure, Unsupported):
        raise
    except Exception as exc:
        raise _engine_failure(exc) from exc
    _finite([energy_initial, energy_final], "energy")
    _finite(positions, "geometry")

    warnings = list(system.warnings)
    if not converged:
        warnings.append(
            f"The optimisation stopped at the limit of {max_steps} steps with a largest force of {force_final:.4f} eV/angstrom "
            f"(tolerance {tolerance} eV/angstrom); the returned geometry is not a stationary point."
        )
    trajectory = None
    if settings["record_trajectory"]:
        from ..chem.geometry import thin_trajectory

        thinned = thin_trajectory(frames, settings["trajectory_max_frames"])
        trajectory = {
            "energy_unit": "hartree",
            "stride": 1,
            "frames_recorded": len(frames),
            "frames_returned": len(thinned),
            "thinned": len(thinned) < len(frames),
            "note": "One frame per LBFGS step, starting with the initial geometry (iteration 0).",
            "frames": thinned,
        }

    document = {
        "method": settings["method"],
        "optimizer": f"ASE {ase.__version__} LBFGS in Cartesian coordinates",
        "charge": system.charge,
        "multiplicity": system.multiplicity,
        "electron_count": system.electron_count,
        "geometry": system.geometry,
        "converged": converged,
        "steps": steps,
        "max_steps": max_steps,
        "force_tolerance_ev_per_angstrom": tolerance,
        "max_force_initial_ev_per_angstrom": force_initial,
        "max_force_final_ev_per_angstrom": force_final,
        "energy_initial_hartree": energy_initial,
        "energy_final_hartree": energy_final,
        "energy_change_hartree": energy_final - energy_initial,
        "energy_final_ev": energy_final * factors["hartree_to_ev"],
        "partial_charges_e": [float(v) for v in charges],
        "dipole_debye": [float(v) for v in dipole],
        "dipole_magnitude_debye": float(np.linalg.norm(dipole)),
        "atoms": system.atoms(positions),
        "trajectory": trajectory,
        "units": {
            "coordinates": "angstrom",
            "energy": "hartree (energy_final_ev in eV)",
            "force": "eV/angstrom",
            "partial_charges": "e",
            "dipole": "debye",
        },
        "conversions": factors,
        "warnings": warnings,
    }
    return TaskOutcome(
        result=document,
        method=f"{settings['method']} / ASE LBFGS",
        converged=converged,
        software=_software(system, with_ase=True),
    )
