"""3D coordinates from RDKit: ETKDGv3 embedding and MMFF94 / UFF force-field minimisation.

Coordinates are in angstrom and force-field energies in kcal/mol (RDKit's native units). Every
function reports what was actually done: which method ran, whether it converged, and why a
fallback was taken.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

import numpy as np
from rdkit import Chem
from rdkit.Chem import rdDistGeom, rdForceFieldHelpers
from rdkit.ForceField import rdForceField
from rdkit.Geometry import Point3D

from . import rdlog

ForceFieldChoice = Literal["auto", "mmff94", "mmff94s", "uff", "none"]

_FAILURE_NAMES = [name for name, _ in sorted(rdDistGeom.EmbedFailureCauses.names.items(), key=lambda item: int(item[1]))]

EMBED_METHOD = "ETKDGv3"
DEFAULT_SEED = 61453


def positions_of(mol: Chem.Mol, conf_id: int = -1) -> list[list[float]]:
    return [[float(x), float(y), float(z)] for x, y, z in mol.GetConformer(conf_id).GetPositions()]


def atom_records(mol: Chem.Mol, conf_id: int = -1, *, input_atom_count: int | None = None) -> list[dict[str, Any]]:
    positions = mol.GetConformer(conf_id).GetPositions()
    atoms = []
    for atom in mol.GetAtoms():
        x, y, z = positions[atom.GetIdx()]
        record = {
            "index": atom.GetIdx(),
            "element": atom.GetSymbol(),
            "atomic_number": atom.GetAtomicNum(),
            "formal_charge": atom.GetFormalCharge(),
            "isotope": atom.GetIsotope() or None,
            "x": float(x),
            "y": float(y),
            "z": float(z),
        }
        if input_atom_count is not None:
            record["added_hydrogen"] = atom.GetIdx() >= input_atom_count
        atoms.append(record)
    return atoms


_BOND_ORDERS = {
    Chem.BondType.SINGLE: 1.0,
    Chem.BondType.DOUBLE: 2.0,
    Chem.BondType.TRIPLE: 3.0,
    Chem.BondType.AROMATIC: 1.5,
    Chem.BondType.QUADRUPLE: 4.0,
    Chem.BondType.DATIVE: 1.0,
    Chem.BondType.ZERO: 0.0,
}


def bond_records(mol: Chem.Mol) -> list[dict[str, Any]]:
    bonds = []
    for bond in mol.GetBonds():
        kind = bond.GetBondType()
        bonds.append(
            {
                "index": bond.GetIdx(),
                "begin_atom_index": bond.GetBeginAtomIdx(),
                "end_atom_index": bond.GetEndAtomIdx(),
                "order": _BOND_ORDERS.get(kind, float(bond.GetBondTypeAsDouble())),
                "aromatic": bond.GetIsAromatic(),
                "rdkit_bond_type": str(kind),
            }
        )
    return bonds


@dataclass
class EmbedOutcome:
    mol: Chem.Mol
    succeeded: bool
    conf_id: int
    seed: int
    attempts: list[dict[str, Any]]
    added_hydrogens: int
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "method": EMBED_METHOD,
            "succeeded": self.succeeded,
            "random_seed": self.seed,
            "used_random_initial_coordinates": bool(self.succeeded and self.attempts and self.attempts[-1]["random_initial_coordinates"]),
            "attempts": self.attempts,
            "explicit_hydrogens_added": self.added_hydrogens,
        }


def add_hydrogens(mol: Chem.Mol, *, with_coordinates: bool) -> tuple[Chem.Mol, int]:
    """Makes every hydrogen an explicit atom. New hydrogens are appended after the existing atoms."""
    before = mol.GetNumAtoms()
    full = Chem.AddHs(mol, addCoords=with_coordinates)
    return full, full.GetNumAtoms() - before


def embed_3d(mol: Chem.Mol, *, seed: int = DEFAULT_SEED, timeout_seconds: int = 20) -> EmbedOutcome:
    """ETKDGv3 embedding with explicit hydrogens. If the standard attempt fails, one more attempt is
    made from random initial coordinates (RDKit's documented remedy for large or strained systems)."""
    full, added = add_hydrogens(mol, with_coordinates=False)
    full.RemoveAllConformers()
    attempts: list[dict[str, Any]] = []
    conf_id = -1
    for use_random in (False, True):
        params = rdDistGeom.ETKDGv3()
        params.randomSeed = int(seed)
        params.useRandomCoords = use_random
        params.timeout = int(timeout_seconds)
        params.trackFailures = True
        with rdlog.capture() as log:
            conf_id = int(rdDistGeom.EmbedMolecule(full, params))
        failures = {name: int(count) for name, count in zip(_FAILURE_NAMES, params.GetFailureCounts()) if count}
        attempts.append(
            {
                "random_initial_coordinates": use_random,
                "succeeded": conf_id >= 0,
                "failure_counts": failures,
                "messages": rdlog.messages(log),
            }
        )
        if conf_id >= 0:
            break
    return EmbedOutcome(mol=full, succeeded=conf_id >= 0, conf_id=conf_id, seed=int(seed), attempts=attempts, added_hydrogens=added)


@dataclass
class ForceFieldSetup:
    name: str  # "MMFF94", "MMFF94s" or "UFF"
    field: rdForceField.ForceField
    mol: Chem.Mol
    conf_id: int


def _mmff(mol: Chem.Mol, conf_id: int, variant: str) -> tuple[ForceFieldSetup | None, list[str]]:
    with rdlog.capture() as log:
        if not rdForceFieldHelpers.MMFFHasAllMoleculeParams(mol):
            said = rdlog.messages(log)
            return None, said or [f"{variant} has no parameters for at least one atom of this molecule (RDKit MMFFHasAllMoleculeParams is False)."]
        props = rdForceFieldHelpers.MMFFGetMoleculeProperties(mol, mmffVariant=variant)
        ff = None if props is None else rdForceFieldHelpers.MMFFGetMoleculeForceField(mol, props, confId=conf_id, ignoreInterfragInteractions=False)
    if ff is None:
        return None, rdlog.messages(log) or [f"RDKit could not set up the {variant} force field for this molecule."]
    ff.Initialize()
    return ForceFieldSetup(variant, ff, mol, conf_id), []


def _uff(mol: Chem.Mol, conf_id: int) -> tuple[ForceFieldSetup | None, list[str]]:
    with rdlog.capture() as log:
        if not rdForceFieldHelpers.UFFHasAllMoleculeParams(mol):
            said = rdlog.messages(log)
            return None, said or ["UFF has no parameters for at least one atom of this molecule (RDKit UFFHasAllMoleculeParams is False)."]
        ff = rdForceFieldHelpers.UFFGetMoleculeForceField(mol, confId=conf_id, ignoreInterfragInteractions=False)
    if ff is None:
        return None, rdlog.messages(log) or ["RDKit could not set up the UFF force field for this molecule."]
    ff.Initialize()
    return ForceFieldSetup("UFF", ff, mol, conf_id), []


@dataclass
class ForceFieldSelection:
    requested: str
    setup: ForceFieldSetup | None
    fallback_reason: str | None
    reasons: list[str]  # why nothing could be set up (empty when setup is not None)


def select_force_field(mol: Chem.Mol, conf_id: int, choice: str) -> ForceFieldSelection:
    """`auto` means MMFF94, falling back to UFF when MMFF94 has no parameters for the molecule."""
    if choice in ("mmff94", "mmff94s"):
        variant = "MMFF94" if choice == "mmff94" else "MMFF94s"
        setup, why = _mmff(mol, conf_id, variant)
        return ForceFieldSelection(choice, setup, None, [] if setup else why)
    if choice == "uff":
        setup, why = _uff(mol, conf_id)
        return ForceFieldSelection(choice, setup, None, [] if setup else why)
    if choice == "auto":
        setup, why_mmff = _mmff(mol, conf_id, "MMFF94")
        if setup:
            return ForceFieldSelection(choice, setup, None, [])
        setup, why_uff = _uff(mol, conf_id)
        if setup:
            return ForceFieldSelection(choice, setup, "MMFF94 unavailable: " + " ".join(why_mmff), [])
        return ForceFieldSelection(choice, None, None, [f"MMFF94: {m}" for m in why_mmff] + [f"UFF: {m}" for m in why_uff])
    raise ValueError(f"unknown force field choice: {choice}")


def mmff_properties(mol: Chem.Mol, name: str) -> Any:
    """MMFF atom typing and charges for the molecule (conformer independent)."""
    return rdForceFieldHelpers.MMFFGetMoleculeProperties(mol, mmffVariant=name)


def force_field_for_conformer(mol: Chem.Mol, conf_id: int, name: str, mmff_props: Any = None) -> ForceFieldSetup:
    """Binds an already selected force field (MMFF94, MMFF94s or UFF) to another conformer of `mol`."""
    if name == "UFF":
        ff = rdForceFieldHelpers.UFFGetMoleculeForceField(mol, confId=conf_id, ignoreInterfragInteractions=False)
    else:
        props = mmff_props if mmff_props is not None else mmff_properties(mol, name)
        ff = rdForceFieldHelpers.MMFFGetMoleculeForceField(mol, props, confId=conf_id, ignoreInterfragInteractions=False)
    if ff is None:
        raise RuntimeError(f"RDKit could not set up {name} for conformer {conf_id}")
    ff.Initialize()
    return ForceFieldSetup(name, ff, mol, conf_id)


def gradient_rms(ff: rdForceField.ForceField) -> float:
    grad = np.asarray(ff.CalcGrad(), dtype=float)
    return float(np.sqrt(np.mean(grad**2))) if grad.size else 0.0


@dataclass
class MinimisationOutcome:
    force_field: str
    converged: bool
    max_iterations: int
    iterations: int | None
    energy_initial: float
    energy_final: float
    gradient_rms_initial: float
    gradient_rms_final: float
    trajectory: list[dict[str, Any]] | None
    trajectory_stride: int | None

    def summary(self) -> dict[str, Any]:
        return {
            "force_field": self.force_field,
            "converged": self.converged,
            "max_iterations": self.max_iterations,
            "iterations": self.iterations,
            "energy_initial_kcal_per_mol": self.energy_initial,
            "energy_final_kcal_per_mol": self.energy_final,
            "energy_change_kcal_per_mol": self.energy_final - self.energy_initial,
            "gradient_rms_initial_kcal_per_mol_angstrom": self.gradient_rms_initial,
            "gradient_rms_final_kcal_per_mol_angstrom": self.gradient_rms_final,
        }


def minimise(
    setup: ForceFieldSetup,
    *,
    max_iterations: int,
    force_tolerance: float = 1e-4,
    energy_tolerance: float = 1e-6,
    trajectory_frames: int | None = None,
    trajectory_stride: int = 1,
    on_progress: Callable[[float], None] | None = None,
) -> MinimisationOutcome:
    """Runs RDKit's BFGS minimiser, uninterrupted, on the conformer bound to `setup`.

    RDKit reports neither the number of iterations it used nor intermediate geometries. When
    `trajectory_frames` is given, both are recovered exactly by replaying the (deterministic)
    minimisation from the starting geometry with a lower iteration limit: a bisection finds the
    iteration at which convergence is reached, and one replay per frame yields the geometry after
    that many iterations. The frames are therefore snapshots of the very minimisation that produced
    the result, at the cost of roughly `trajectory_frames / 2` extra minimisations.
    """
    ff = setup.field
    conformer = setup.mol.GetConformer(setup.conf_id)
    start = np.asarray(conformer.GetPositions(), dtype=float).copy()
    energy_initial = float(ff.CalcEnergy())
    grad_initial = gradient_rms(ff)

    def run(limit: int) -> bool:
        return ff.Minimize(maxIts=int(limit), forceTol=force_tolerance, energyTol=energy_tolerance) == 0

    def place(positions: np.ndarray) -> None:
        for index, (x, y, z) in enumerate(positions):
            conformer.SetAtomPosition(index, Point3D(float(x), float(y), float(z)))
        ff.Initialize()

    def frame(iteration: int) -> dict[str, Any]:
        return {
            "iteration": iteration,
            "energy_kcal_per_mol": float(ff.CalcEnergy()),
            "coordinates_angstrom": [[float(v) for v in row] for row in conformer.GetPositions()],
        }

    converged = run(max_iterations)
    final = np.asarray(conformer.GetPositions(), dtype=float).copy()
    energy_final = float(ff.CalcEnergy())
    grad_final = gradient_rms(ff)

    iterations: int | None = None
    trajectory: list[dict[str, Any]] | None = None
    stride: int | None = None
    if trajectory_frames is not None:
        if converged:
            low, high = 1, int(max_iterations)
            while low < high:
                middle = (low + high) // 2
                place(start)
                if run(middle):
                    high = middle
                else:
                    low = middle + 1
            iterations = low
        else:
            iterations = int(max_iterations)
        stride = max(int(trajectory_stride), math.ceil(iterations / max(trajectory_frames - 1, 1)))
        marks = [*range(stride, iterations, stride), iterations]
        place(start)
        trajectory = [frame(0)]
        for number, mark in enumerate(marks, start=1):
            place(start)
            run(mark)
            trajectory.append(frame(mark))
            if on_progress:
                on_progress(number / len(marks))
        place(final)

    return MinimisationOutcome(
        force_field=setup.name,
        converged=converged,
        max_iterations=int(max_iterations),
        iterations=iterations,
        energy_initial=energy_initial,
        energy_final=energy_final,
        gradient_rms_initial=grad_initial,
        gradient_rms_final=grad_final,
        trajectory=trajectory,
        trajectory_stride=stride,
    )


def thin_trajectory(frames: list[dict[str, Any]], max_frames: int) -> list[dict[str, Any]]:
    """Evenly thins a trajectory to at most `max_frames`, always keeping the first and last frame."""
    if len(frames) <= max_frames:
        return frames
    picks = sorted({round(i * (len(frames) - 1) / (max_frames - 1)) for i in range(max_frames)})
    return [frames[i] for i in picks]
