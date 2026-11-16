"""RDKit job tasks: force-field geometry optimisation and conformer search.

These functions run inside a worker process. They never invent a result: a structure RDKit cannot
read ends as `failed` with RDKit's message, and a molecule no force field has parameters for ends
as `unsupported` with the reasons.
"""

from __future__ import annotations

from typing import Any

from rdkit import Chem
from rdkit.Chem import rdDistGeom, rdMolAlign

from ..chem import geometry, rdlog
from ..chem.structure import RDKIT_VERSION, ParsedStructure, has_usable_3d, identity, parse_structure
from .runtime import TaskFailure, TaskOutcome, Unsupported, WorkerContext

_FF_CHOICE = {"MMFF94": "mmff94", "MMFF94s": "mmff94s", "UFF": "uff"}
_EMBED_TIMEOUT_SECONDS = 120


def parse_job_structure(structure: dict[str, Any]) -> ParsedStructure:
    parsed = parse_structure(structure["format"], structure["data"])
    if not parsed.valid or parsed.mol is None:
        raise TaskFailure(
            "invalid_structure",
            f"RDKit could not interpret the structure: {parsed.error_summary()}",
            {"stage": parsed.stage, "failed_operation": parsed.failed_operation, "errors": [p.as_dict() for p in parsed.errors]},
        )
    return parsed


def structure_summary(mol: Chem.Mol, atom_count: int) -> dict[str, Any]:
    ident = identity(mol)
    return {
        "canonical_smiles": ident["canonical_smiles"],
        "inchikey": ident["inchikey"],
        "molecular_formula": ident["molecular_formula"],
        "formal_charge": ident["formal_charge"],
        "atom_count": atom_count,
    }


def stereo_warnings(mol: Chem.Mol) -> list[str]:
    unspecified = 0
    try:
        for element in Chem.FindPotentialStereo(mol):
            if element.specified != Chem.StereoSpecified.Specified:
                unspecified += 1
    except Exception:
        return []
    if unspecified:
        return [
            f"{unspecified} stereo element(s) are unspecified in the input; a generated 3D geometry realises one arbitrary configuration of them."
        ]
    return []


def fragment_warnings(mol: Chem.Mol) -> list[str]:
    fragments = len(Chem.GetMolFrags(mol))
    if fragments > 1:
        return [f"The structure has {fragments} disconnected fragments; in a generated geometry their initial relative placement is arbitrary."]
    return []


def check_atom_limit(atom_count: int, limit: int, what: str) -> None:
    if atom_count > limit:
        raise Unsupported(
            f"The system has {atom_count} atoms; this service runs {what} for at most {limit} atoms.",
            reasons=[f"atom count {atom_count} exceeds the configured limit of {limit}"],
            details={"atom_count": atom_count, "max_atoms": limit},
        )


def starting_geometry(mol: Chem.Mol, seed: int) -> tuple[Chem.Mol, int, dict[str, Any], list[str]]:
    """(molecule with every hydrogen explicit and one conformer, conformer id, GeometrySource, warnings)."""
    warnings: list[str] = []
    if has_usable_3d(mol):
        full, added = geometry.add_hydrogens(mol, with_coordinates=True)
        description = "3D coordinates of the input structure"
        if added:
            description += f"; {added} implicit hydrogen(s) were added at idealised positions"
            warnings.append(f"{added} hydrogen(s) were implicit in the input and were placed by RDKit at idealised positions.")
        source = {"source": "input-coordinates", "description": description, "hydrogens_added": added}
        return full, full.GetConformer().GetId(), source, warnings

    outcome = geometry.embed_3d(mol, seed=seed, timeout_seconds=_EMBED_TIMEOUT_SECONDS)
    if not outcome.succeeded:
        raise TaskFailure(
            "embedding_failed",
            f"RDKit {geometry.EMBED_METHOD} could not generate 3D coordinates for this structure.",
            {"attempts": outcome.attempts},
        )
    warnings.extend(stereo_warnings(mol))
    warnings.extend(fragment_warnings(mol))
    source = {
        "source": "generated",
        "description": f"The input had no usable 3D coordinates; a geometry was generated with RDKit {geometry.EMBED_METHOD} (seed {seed}).",
        "embedding": outcome.summary(),
        "hydrogens_added": outcome.added_hydrogens,
    }
    return outcome.mol, outcome.conf_id, source, warnings


def _unsupported_force_field(selection: geometry.ForceFieldSelection) -> Unsupported:
    asked = "MMFF94 or UFF" if selection.requested == "auto" else selection.requested.upper()
    return Unsupported(
        f"RDKit has no {asked} parameters for this molecule, so a force-field calculation is not possible.",
        reasons=selection.reasons,
        details={"requested_force_field": selection.requested},
    )


def _force_field_use(selection: geometry.ForceFieldSelection) -> dict[str, Any]:
    return {
        "requested": selection.requested,
        "used": selection.setup.name if selection.setup else None,
        "fallback_reason": selection.fallback_reason,
        "interfragment_interactions": "included",
    }


def geometry_optimization(job_input: dict[str, Any], settings: dict[str, Any], ctx: WorkerContext) -> TaskOutcome:
    parsed = parse_job_structure(job_input["structure"])
    assert parsed.mol is not None
    ctx.progress(0.05, "Structure parsed and sanitised by RDKit.")

    full, conf_id, source, warnings = starting_geometry(parsed.mol, settings["random_seed"])
    check_atom_limit(full.GetNumAtoms(), ctx.limits["max_atoms_force_field"], "force-field calculations")
    ctx.progress(0.15, source["description"])

    selection = geometry.select_force_field(full, conf_id, settings["force_field"])
    if selection.setup is None:
        raise _unsupported_force_field(selection)
    if selection.fallback_reason:
        warnings.append(f"UFF was used instead of MMFF94. {selection.fallback_reason}")
        ctx.log(f"Falling back to UFF. {selection.fallback_reason}", "warning")
    ctx.progress(0.2, f"Minimising with {selection.setup.name} (at most {settings['max_iterations']} iterations).")

    record = settings["record_trajectory"]
    outcome = geometry.minimise(
        selection.setup,
        max_iterations=settings["max_iterations"],
        trajectory_frames=settings["trajectory_max_frames"] if record else None,
        trajectory_stride=settings["trajectory_stride"],
        on_progress=lambda fraction: ctx.progress(0.3 + 0.65 * fraction),
    )
    if not outcome.converged:
        warnings.append(
            f"The minimisation stopped at the limit of {outcome.max_iterations} iterations without meeting the convergence criteria; "
            "the returned geometry is not a stationary point."
        )

    trajectory = None
    if record and outcome.trajectory is not None:
        trajectory = {
            "energy_unit": "kcal/mol",
            "stride": outcome.trajectory_stride,
            "frames_recorded": len(outcome.trajectory),
            "frames_returned": len(outcome.trajectory),
            "thinned": False,
            "note": (
                "Frames are exact snapshots of the uninterrupted RDKit BFGS minimisation that produced the result. RDKit exposes no "
                "intermediate geometries, so the deterministic minimisation was replayed from the starting geometry with the iteration "
                "limit set to each frame's iteration number."
            ),
            "frames": [
                {"iteration": f["iteration"], "energy": f["energy_kcal_per_mol"], "coordinates_angstrom": f["coordinates_angstrom"]}
                for f in outcome.trajectory
            ],
        }

    result = {
        "structure": structure_summary(parsed.mol, full.GetNumAtoms()),
        "starting_geometry": source,
        "force_field": _force_field_use(selection),
        **{k: v for k, v in outcome.summary().items() if k != "force_field"},
        "atoms": geometry.atom_records(full, conf_id, input_atom_count=parsed.mol.GetNumAtoms()),
        "bonds": geometry.bond_records(full),
        "molblock": Chem.MolToMolBlock(full, confId=conf_id),
        "trajectory": trajectory,
        "units": {"coordinates": "angstrom", "energy": "kcal/mol", "gradient": "kcal/(mol*angstrom)"},
        "warnings": warnings,
    }
    return TaskOutcome(result=result, method=outcome.force_field, converged=outcome.converged, software={"rdkit": RDKIT_VERSION})


def conformer_search(job_input: dict[str, Any], settings: dict[str, Any], ctx: WorkerContext) -> TaskOutcome:
    parsed = parse_job_structure(job_input["structure"])
    assert parsed.mol is not None
    full, _added = geometry.add_hydrogens(parsed.mol, with_coordinates=False)
    full.RemoveAllConformers()
    check_atom_limit(full.GetNumAtoms(), ctx.limits["max_atoms_force_field"], "conformer searches")
    warnings = stereo_warnings(parsed.mol) + fragment_warnings(parsed.mol)
    requested = settings["num_conformers"]
    seed = settings["random_seed"]
    ctx.progress(0.02, f"Embedding {requested} conformer(s) with {geometry.EMBED_METHOD}.")

    def embed(count: int, batch_seed: int, use_random: bool) -> list[int]:
        params = rdDistGeom.ETKDGv3()
        params.randomSeed = batch_seed
        params.clearConfs = False
        params.useRandomCoords = use_random
        params.numThreads = max(1, ctx.threads)
        params.timeout = _EMBED_TIMEOUT_SECONDS
        with rdlog.capture():
            return [int(c) for c in rdDistGeom.EmbedMultipleConfs(full, count, params)]

    conformer_ids: list[int] = []
    batch_size = 20
    batches = [(start, min(batch_size, requested - start)) for start in range(0, requested, batch_size)]
    used_random = False
    for number, (start, count) in enumerate(batches):
        batch_seed = (seed + number) % (2**31 - 1)
        new = embed(count, batch_seed, use_random=used_random)
        if not new and not used_random and not conformer_ids:
            used_random = True
            new = embed(count, batch_seed, use_random=True)
        conformer_ids.extend(new)
        ctx.progress(0.02 + 0.43 * (start + count) / requested, f"Embedded {len(conformer_ids)} of {requested} conformer(s).")
    if not conformer_ids:
        raise TaskFailure("embedding_failed", f"RDKit {geometry.EMBED_METHOD} could not generate any conformer for this structure.", {"conformers_requested": requested})
    if used_random:
        warnings.append("Standard ETKDG embedding failed; conformers were generated from random initial coordinates.")
    if len(conformer_ids) < requested:
        warnings.append(f"Only {len(conformer_ids)} of the {requested} requested conformers could be embedded.")

    energies: dict[int, float] = {}
    converged: dict[int, bool] = {}
    selection = None
    if settings["force_field"] != "none":
        selection = geometry.select_force_field(full, conformer_ids[0], settings["force_field"])
        if selection.setup is None:
            raise _unsupported_force_field(selection)
        name = selection.setup.name
        if selection.fallback_reason:
            warnings.append(f"UFF was used instead of MMFF94. {selection.fallback_reason}")
        props = None if name == "UFF" else geometry.mmff_properties(full, name)
        for position, conf_id in enumerate(conformer_ids):
            setup = selection.setup if position == 0 else geometry.force_field_for_conformer(full, conf_id, name, props)
            outcome = geometry.minimise(setup, max_iterations=settings["max_iterations"])
            energies[conf_id] = outcome.energy_final
            converged[conf_id] = outcome.converged
            if (position + 1) % 5 == 0 or position + 1 == len(conformer_ids):
                ctx.progress(0.45 + 0.40 * (position + 1) / len(conformer_ids), f"Minimised {position + 1} of {len(conformer_ids)} conformer(s) with {name}.")
        ordered = sorted(conformer_ids, key=lambda c: (energies[c], c))
    else:
        ordered = list(conformer_ids)
        warnings.append("No force field was applied: conformers are raw ETKDG geometries in embedding order, without energies.")

    lowest = energies[ordered[0]] if energies else None
    window = settings["energy_window_kcal_per_mol"]
    threshold = settings["prune_rms_threshold_angstrom"]
    try:
        heavy = Chem.RemoveHs(full)
    except Exception:
        heavy = Chem.Mol(full)
    kept: list[int] = []
    for position, conf_id in enumerate(ordered):
        if window is not None and lowest is not None and energies[conf_id] - lowest > window:
            break
        duplicate = False
        if threshold > 0 and heavy.GetNumAtoms() > 1:
            for reference in kept:
                if rdMolAlign.GetBestRMS(heavy, heavy, conf_id, reference, maxMatches=2000) < threshold:
                    duplicate = True
                    break
        if not duplicate:
            kept.append(conf_id)
        if (position + 1) % 20 == 0:
            ctx.progress(0.85 + 0.13 * (position + 1) / len(ordered), f"Compared {position + 1} of {len(ordered)} conformer(s) for duplicates.")

    returned = kept[: settings["max_returned"]]
    conformers = []
    for rank, conf_id in enumerate(returned, start=1):
        energy = energies.get(conf_id)
        conformers.append(
            {
                "rank": rank,
                "conformer_id": conf_id,
                "energy_kcal_per_mol": energy,
                "relative_energy_kcal_per_mol": None if energy is None or lowest is None else energy - lowest,
                "converged": converged.get(conf_id),
                "coordinates_angstrom": geometry.positions_of(full, conf_id),
            }
        )
    all_converged = all(converged[c] for c in returned) if converged else None
    if converged and not all_converged:
        warnings.append("At least one returned conformer reached the iteration limit before converging.")

    force_field = (
        _force_field_use(selection)
        if selection is not None
        else {"requested": "none", "used": None, "fallback_reason": None, "interfragment_interactions": "included"}
    )
    result = {
        "structure": structure_summary(parsed.mol, full.GetNumAtoms()),
        "embedding_method": geometry.EMBED_METHOD,
        "random_seed": seed,
        "force_field": force_field,
        "conformers_requested": requested,
        "conformers_embedded": len(conformer_ids),
        "conformers_unique": len(kept),
        "conformers_returned": len(returned),
        "all_converged": all_converged,
        "atoms": geometry.atom_records(full, returned[0], input_atom_count=parsed.mol.GetNumAtoms()),
        "bonds": geometry.bond_records(full),
        "conformers": conformers,
        "units": {"coordinates": "angstrom", "energy": "kcal/mol", "rmsd": "angstrom"},
        "warnings": warnings,
    }
    method = f"{geometry.EMBED_METHOD} + {force_field['used']}" if force_field["used"] else geometry.EMBED_METHOD
    return TaskOutcome(result=result, method=method, converged=all_converged, software={"rdkit": RDKIT_VERSION})
