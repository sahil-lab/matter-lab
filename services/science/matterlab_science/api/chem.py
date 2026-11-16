"""Synchronous RDKit chemistry endpoints: validation, 3D coordinates, descriptors, functional groups."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator
from rdkit import Chem

from ..chem import functional_groups, geometry
from ..chem.descriptors import descriptors as compute_descriptors
from ..chem.structure import identity, parse_structure, validation_report
from ..errors import ApiError, error_responses
from ..models import Atom3D, Bond3D, EmbeddingInfo
from ..provenance import PROVENANCE_COLUMNS, EvidenceLevel, Provenance, provenance_from_row
from .common import Ctx, EngineStamp, StructureInput, engine_stamp, require_structure

router = APIRouter(prefix="/v1/chem", tags=["chemistry"])


# ---------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------


class ValidateRequest(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"structure": {"format": "smiles", "data": "c1ccccc1"}}]})

    structure: StructureInput
    implicit_hydrogens: bool = Field(
        default=True,
        description=(
            "True (default): standard valence model, missing hydrogens are implied. "
            "False (molblock only): the drawn atoms are the whole structure, no hydrogens are implied, and open valences are reported as radical electrons."
        ),
    )

    @model_validator(mode="after")
    def _explicit_only_needs_molblock(self) -> "ValidateRequest":
        if not self.implicit_hydrogens and self.structure.format != "molblock":
            raise ValueError("implicit_hydrogens=false is only meaningful for molblock input (a SMILES string implies its hydrogens)")
        return self


class StructureProblem(BaseModel):
    type: str = Field(description="RDKit's problem class, e.g. AtomValenceException, KekulizeException, or ParseError.")
    message: str = Field(description="RDKit's message, verbatim.")
    atom_indices: list[int] = Field(description="Input atoms the problem refers to, when RDKit names them.")


class SanitizationStatus(BaseModel):
    status: Literal["ok", "failed", "not-run"]
    failed_operation: str | None = Field(description="The RDKit sanitisation step that failed, e.g. SANITIZE_PROPERTIES.")
    hydrogen_model: Literal["implicit", "explicit-only"]


class AtomDetail(BaseModel):
    index: int
    element: str
    atomic_number: int
    formal_charge: int
    isotope: int | None
    implicit_hydrogens: int = Field(description="Hydrogens RDKit attributes to this atom that are not atoms of the input.")
    total_hydrogens: int = Field(description="All hydrogens on this atom, explicit neighbours included.")
    radical_electrons: int
    aromatic: bool
    in_ring: bool
    hybridization: str
    cip_label: str | None = Field(description="R or S for a specified stereocentre.")


class TetrahedralCenter(BaseModel):
    atom_index: int
    specified: bool
    cip_label: str | None


class DoubleBondStereo(BaseModel):
    bond_index: int
    begin_atom_index: int
    end_atom_index: int
    specified: bool
    cip_label: str | None = Field(description="E or Z for a specified double bond.")


class OtherStereoElement(BaseModel):
    type: str
    centered_on: int
    specified: bool


class StereoInfo(BaseModel):
    tetrahedral_centers: list[TetrahedralCenter]
    double_bonds: list[DoubleBondStereo]
    other_elements: list[OtherStereoElement]
    unspecified_count: int


class Ring(BaseModel):
    size: int
    atom_indices: list[int]
    aromatic: bool


class RingInfo(BaseModel):
    ring_count: int
    aromatic_ring_count: int
    aromatic_atom_count: int
    rings: list[Ring]


class StructureDetails(BaseModel):
    canonical_smiles: str = Field(description="RDKit canonical isomeric SMILES.")
    inchi: str | None = Field(description="Standard InChI; null when the InChI software rejects the structure.")
    inchikey: str | None
    molecular_formula: str
    molecular_weight_g_per_mol: float = Field(description="Average molecular weight in g/mol.")
    monoisotopic_mass_u: float = Field(description="Exact (monoisotopic) mass in unified atomic mass units.")
    formal_charge: int
    radical_electrons: int
    heavy_atom_count: int
    fragment_count: int
    atom_count: int = Field(description="Atoms present in the input (explicit atoms only).")
    bond_count: int
    implicit_hydrogen_count: int
    has_3d_coordinates: bool
    atoms: list[AtomDetail]
    stereo: StereoInfo
    rings: RingInfo


class ValidationResponse(BaseModel):
    valid: bool
    input_format: Literal["smiles", "molblock"]
    stage: Literal["parse", "sanitization", "complete"] = Field(description="How far RDKit got.")
    sanitization: SanitizationStatus
    errors: list[StructureProblem]
    warnings: list[str]
    engine: EngineStamp
    evidence: EvidenceLevel
    structure: StructureDetails | None = Field(description="Present only when the structure is valid.")


@router.post(
    "/validate",
    response_model=ValidationResponse,
    responses=error_responses(422),
    summary="Validate and normalise a structure",
)
def validate(request: ValidateRequest) -> ValidationResponse:
    """Parses and sanitises the structure with RDKit. An invalid structure is a normal answer
    (`valid: false`, HTTP 200) carrying RDKit's own error messages and the atoms they refer to."""
    parsed = parse_structure(request.structure.format, request.structure.data, implicit_hydrogens=request.implicit_hydrogens)
    return ValidationResponse(**validation_report(parsed))


# ---------------------------------------------------------------------------------------------
# 3D coordinates
# ---------------------------------------------------------------------------------------------


class Embed3DRequest(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"structure": {"format": "smiles", "data": "CCO"}}]})

    structure: StructureInput
    random_seed: int = Field(default=geometry.DEFAULT_SEED, ge=0, le=2**31 - 1, description="Seed of the ETKDG embedding; the same seed reproduces the same coordinates.")
    force_field: Literal["auto", "mmff94", "mmff94s", "uff", "none"] = Field(
        default="auto",
        description="Clean-up after embedding. `auto`: MMFF94, or UFF when MMFF94 has no parameters. `none`: return the raw ETKDG coordinates.",
    )
    max_iterations: int = Field(default=500, ge=1, le=10_000, description="Iteration limit of the force-field clean-up.")


class ForceFieldCleanup(BaseModel):
    requested: str
    used: str | None = Field(description="MMFF94, MMFF94s or UFF; null when no force field was applied.")
    applied: bool
    converged: bool | None
    max_iterations: int | None
    energy_initial_kcal_per_mol: float | None
    energy_final_kcal_per_mol: float | None
    gradient_rms_final_kcal_per_mol_angstrom: float | None
    fallback_reason: str | None = Field(description="Why UFF replaced MMFF94, in RDKit's words.")
    unavailable_reasons: list[str] = Field(description="Why no force field could be applied, when that is the case.")


class Embed3DResponse(BaseModel):
    succeeded: bool = Field(description="True when 3D coordinates are returned.")
    embedding: EmbeddingInfo
    force_field: ForceFieldCleanup
    atoms: list[Atom3D]
    bonds: list[Bond3D]
    molblock: str | None = Field(description="The 3D structure as a V2000 molfile with explicit hydrogens.")
    coordinate_unit: Literal["angstrom"]
    energy_unit: Literal["kcal/mol"]
    canonical_smiles: str
    inchikey: str | None
    warnings: list[str]
    engine: EngineStamp
    evidence: EvidenceLevel


@router.post(
    "/3d",
    response_model=Embed3DResponse,
    responses=error_responses(422),
    summary="Generate 3D coordinates",
)
def embed_3d(request: Embed3DRequest, ctx: Ctx) -> Embed3DResponse:
    """ETKDGv3 embedding with explicit hydrogens, followed by MMFF94 (or UFF) clean-up. Coordinates
    of the input, if any, are not used. Atoms keep the input order; added hydrogens come last."""
    parsed = require_structure(request.structure, max_atoms=ctx.settings.max_atoms_sync)
    mol = parsed.mol
    assert mol is not None
    ident = identity(mol)
    warnings = list(parsed.warnings)

    outcome = geometry.embed_3d(mol, seed=request.random_seed, timeout_seconds=20)
    cleanup = ForceFieldCleanup(
        requested=request.force_field,
        used=None,
        applied=False,
        converged=None,
        max_iterations=None,
        energy_initial_kcal_per_mol=None,
        energy_final_kcal_per_mol=None,
        gradient_rms_final_kcal_per_mol_angstrom=None,
        fallback_reason=None,
        unavailable_reasons=[],
    )
    if not outcome.succeeded:
        warnings.append("RDKit could not generate 3D coordinates for this structure; no coordinates are returned.")
        return Embed3DResponse(
            succeeded=False,
            embedding=EmbeddingInfo(**outcome.summary()),
            force_field=cleanup,
            atoms=[],
            bonds=[],
            molblock=None,
            coordinate_unit="angstrom",
            energy_unit="kcal/mol",
            canonical_smiles=ident["canonical_smiles"],
            inchikey=ident["inchikey"],
            warnings=warnings,
            engine=engine_stamp(),
            evidence="unsupported",
        )

    from ..jobs.tasks_rdkit import fragment_warnings, stereo_warnings

    warnings.extend(stereo_warnings(mol))
    warnings.extend(fragment_warnings(mol))
    if request.force_field != "none":
        selection = geometry.select_force_field(outcome.mol, outcome.conf_id, request.force_field)
        if selection.setup is None:
            cleanup.unavailable_reasons = selection.reasons
            warnings.append("No force-field clean-up was possible; the coordinates are the raw ETKDG embedding.")
        else:
            result = geometry.minimise(selection.setup, max_iterations=request.max_iterations)
            cleanup = ForceFieldCleanup(
                requested=request.force_field,
                used=result.force_field,
                applied=True,
                converged=result.converged,
                max_iterations=result.max_iterations,
                energy_initial_kcal_per_mol=result.energy_initial,
                energy_final_kcal_per_mol=result.energy_final,
                gradient_rms_final_kcal_per_mol_angstrom=result.gradient_rms_final,
                fallback_reason=selection.fallback_reason,
                unavailable_reasons=[],
            )
            if selection.fallback_reason:
                warnings.append(f"UFF was used instead of MMFF94. {selection.fallback_reason}")
            if not result.converged:
                warnings.append(f"The force-field clean-up did not converge within {result.max_iterations} iterations.")

    return Embed3DResponse(
        succeeded=True,
        embedding=EmbeddingInfo(**outcome.summary()),
        force_field=cleanup,
        atoms=[Atom3D(**a) for a in geometry.atom_records(outcome.mol, outcome.conf_id, input_atom_count=mol.GetNumAtoms())],
        bonds=[Bond3D(**b) for b in geometry.bond_records(outcome.mol)],
        molblock=Chem.MolToMolBlock(outcome.mol, confId=outcome.conf_id),
        coordinate_unit="angstrom",
        energy_unit="kcal/mol",
        canonical_smiles=ident["canonical_smiles"],
        inchikey=ident["inchikey"],
        warnings=warnings,
        engine=engine_stamp(),
        evidence="computed",
    )


# ---------------------------------------------------------------------------------------------
# Descriptors
# ---------------------------------------------------------------------------------------------


class DescriptorValue(BaseModel):
    value: float
    unit: str | None = Field(description="Unit of the value; null for dimensionless quantities.")
    evidence: EvidenceLevel = Field(description="`computed`: exact arithmetic on the structure. `rule-based`: depends on an empirical model or a pattern definition.")
    is_estimate: bool = Field(description="True for values that are estimates of a physical property rather than exact properties of the structure.")
    method: str


class Descriptors(BaseModel):
    molecular_weight: DescriptorValue
    monoisotopic_mass: DescriptorValue
    logp: DescriptorValue = Field(description="Estimated octanol/water partition coefficient (log10). An estimate, never a measurement.")
    molar_refractivity: DescriptorValue
    tpsa: DescriptorValue
    h_bond_donors: DescriptorValue
    h_bond_acceptors: DescriptorValue
    rotatable_bonds: DescriptorValue
    heavy_atoms: DescriptorValue
    rings: DescriptorValue
    aromatic_rings: DescriptorValue
    fraction_sp3_carbons: DescriptorValue
    formal_charge: DescriptorValue


class DescriptorsRequest(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"structure": {"format": "smiles", "data": "CC(=O)Oc1ccccc1C(=O)O"}}]})

    structure: StructureInput


class DescriptorsResponse(BaseModel):
    canonical_smiles: str
    inchikey: str | None
    molecular_formula: str
    descriptors: Descriptors
    warnings: list[str]
    engine: EngineStamp


@router.post(
    "/descriptors",
    response_model=DescriptorsResponse,
    responses=error_responses(422),
    summary="Property-panel descriptors",
)
def descriptors(request: DescriptorsRequest, ctx: Ctx) -> DescriptorsResponse:
    """Descriptors computed by RDKit. Each value states its unit, its method and whether it is an estimate."""
    parsed = require_structure(request.structure, max_atoms=ctx.settings.max_atoms_force_field)
    assert parsed.mol is not None
    ident = identity(parsed.mol)
    return DescriptorsResponse(
        canonical_smiles=ident["canonical_smiles"],
        inchikey=ident["inchikey"],
        molecular_formula=ident["molecular_formula"],
        descriptors=Descriptors(**compute_descriptors(parsed.mol)),
        warnings=list(parsed.warnings),
        engine=engine_stamp(),
    )


# ---------------------------------------------------------------------------------------------
# Functional groups
# ---------------------------------------------------------------------------------------------


class FunctionalGroupsRequest(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"structure": {"format": "smiles", "data": "CC(=O)Oc1ccccc1C(=O)O"}, "sets": ["rdkit-fragment-descriptors"]}]})

    structure: StructureInput
    sets: list[str] | None = Field(default=None, description="Definition sets to search; all sets when omitted. See GET /v1/functional-groups/sets.")


class GroupMatch(BaseModel):
    atom_indices: list[int] = Field(description="Input atoms forming the group, in the order of the SMARTS atoms.")
    attachment_atom_index: int | None = Field(description="For substituent patterns: the atom the group is attached to (not part of the group).")


class DetectedGroup(BaseModel):
    id: int
    group_set: str
    key: str
    name: str
    smarts: str
    description: str | None
    parent_key: str | None
    match_count: int
    matches: list[GroupMatch]
    provenance: Provenance


class FunctionalGroupsResponse(BaseModel):
    canonical_smiles: str
    inchikey: str | None
    sets_searched: list[str]
    definitions_searched: int
    groups: list[DetectedGroup] = Field(description="Definitions that match at least once. A definition that is absent here did not match.")
    note: str
    warnings: list[str]
    engine: EngineStamp
    evidence: EvidenceLevel


@router.post(
    "/functional-groups",
    response_model=FunctionalGroupsResponse,
    responses=error_responses(422, 503),
    summary="Detect functional groups",
)
def detect_functional_groups(request: FunctionalGroupsRequest, ctx: Ctx) -> FunctionalGroupsResponse:
    """Matches the SMARTS definitions stored in PostgreSQL (seeded from RDKit's own data files)
    against the structure. Names and patterns are RDKit's; the result is rule-based."""
    parsed = require_structure(request.structure, max_atoms=ctx.settings.max_atoms_force_field)
    assert parsed.mol is not None
    with ctx.db.connection() as conn:
        known = [r["group_set"] for r in conn.execute("SELECT DISTINCT group_set FROM functional_groups ORDER BY group_set")]
        wanted = known if request.sets is None else list(dict.fromkeys(request.sets))
        unknown = [name for name in wanted if name not in known]
        if unknown:
            raise ApiError(422, "unknown_functional_group_set", f"Unknown functional-group set(s): {', '.join(unknown)}.", {"unknown": unknown, "available": known})
        rows = conn.execute(
            f"""
            SELECT fg.id, fg.group_set, fg.key, fg.name, fg.smarts, fg.description, fg.parent_key, {PROVENANCE_COLUMNS}
            FROM functional_groups fg JOIN data_sources ds ON ds.id = fg.source_id
            WHERE fg.group_set = ANY(%s) ORDER BY fg.group_set, fg.position, fg.id
            """,
            (wanted,),
        ).fetchall()
    found = functional_groups.detect(parsed.mol, rows)
    ident = identity(parsed.mol)
    return FunctionalGroupsResponse(
        canonical_smiles=ident["canonical_smiles"],
        inchikey=ident["inchikey"],
        sets_searched=wanted,
        definitions_searched=len(rows),
        groups=[
            DetectedGroup(
                id=g["id"],
                group_set=g["group_set"],
                key=g["key"],
                name=g["name"],
                smarts=g["smarts"],
                description=g["description"],
                parent_key=g["parent_key"],
                match_count=g["match_count"],
                matches=[GroupMatch(**m) for m in g["matches"]],
                provenance=provenance_from_row(g),
            )
            for g in found
        ],
        note=(
            "Pattern matching against the listed definition sets only. Names and SMARTS are those of the definition source; "
            "overlapping definitions can match the same atoms, and a group that no definition describes is not reported."
        ),
        warnings=list(parsed.warnings),
        engine=engine_stamp(),
        evidence="rule-based",
    )
