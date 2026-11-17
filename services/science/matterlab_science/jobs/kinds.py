"""Job kinds: what can be submitted, with typed input, settings and result documents.

A kind is written `engine.task`. Its input and settings models define the canonical request that
is hashed and stored; its result model is the contract of the `result` document of a succeeded
job (the worker validates every result against it before reporting success).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from rdkit import Chem

from ..chem.geometry import DEFAULT_SEED
from ..chem.structure import MAX_STRUCTURE_CHARS
from ..models import Atom3D, Bond3D, GeometrySource

_PERIODIC_TABLE = Chem.GetPeriodicTable()
ELEMENT_SYMBOLS: dict[str, int] = {_PERIODIC_TABLE.GetElementSymbol(z): z for z in range(1, 119)}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------


class JobStructure(_Strict):
    """A structure with bonds: SMILES or molfile."""

    format: Literal["smiles", "molblock"]
    data: str = Field(min_length=1, max_length=MAX_STRUCTURE_CHARS)

    @model_validator(mode="after")
    def _normalise(self) -> "JobStructure":
        # Insignificant differences must not change the request hash.
        self.data = self.data.strip() if self.format == "smiles" else self.data.replace("\r\n", "\n").replace("\r", "\n")
        if not self.data.strip():
            raise ValueError("the structure text is empty")
        return self


class AtomPosition(_Strict):
    element: str = Field(description="Element symbol, e.g. `O`.")
    x: float = Field(description="x in angstrom")
    y: float = Field(description="y in angstrom")
    z: float = Field(description="z in angstrom")

    @field_validator("element")
    @classmethod
    def _known_element(cls, value: str) -> str:
        symbol = value.strip()
        symbol = symbol[:1].upper() + symbol[1:].lower()
        if symbol not in ELEMENT_SYMBOLS:
            raise ValueError(f"unknown element symbol: {value!r}")
        return symbol


class QuantumStructure(_Strict):
    """Geometry for an electronic-structure calculation.

    `atoms` gives element symbols and Cartesian coordinates in angstrom directly (no bonds needed).
    `smiles` and `molblock` are also accepted; when they carry no usable 3D coordinates the service
    generates a geometry with RDKit (ETKDGv3 plus force-field clean-up) and says so in the result.
    """

    format: Literal["smiles", "molblock", "atoms"]
    data: str | None = Field(default=None, max_length=MAX_STRUCTURE_CHARS, description="Structure text for `smiles` and `molblock`.")
    atoms: list[AtomPosition] | None = Field(default=None, min_length=1, max_length=5000, description="Atom list for `atoms`.")

    @model_validator(mode="after")
    def _consistent(self) -> "QuantumStructure":
        if self.format == "atoms":
            if not self.atoms:
                raise ValueError("format `atoms` needs a non-empty `atoms` list")
            if self.data is not None:
                raise ValueError("format `atoms` does not take `data`")
        else:
            if self.atoms is not None:
                raise ValueError(f"format `{self.format}` does not take `atoms`")
            if self.data is None or not self.data.strip():
                raise ValueError(f"format `{self.format}` needs the structure text in `data`")
            self.data = self.data.strip() if self.format == "smiles" else self.data.replace("\r\n", "\n").replace("\r", "\n")
        return self


class StructureJobInput(_Strict):
    structure: JobStructure


class QuantumJobInput(_Strict):
    structure: QuantumStructure
    charge: int | None = Field(
        default=None,
        ge=-20,
        le=20,
        description="Total charge in units of e. Default: the sum of formal charges for `smiles`/`molblock`, 0 for `atoms`.",
    )
    multiplicity: int | None = Field(
        default=None,
        ge=1,
        le=11,
        description="Spin multiplicity 2S+1. Default: 1 plus the number of radical electrons for `smiles`/`molblock`; for `atoms`, 1 for an even and 2 for an odd electron count.",
    )


# ---------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------


class GeometryOptimizationSettings(_Strict):
    force_field: Literal["auto", "mmff94", "mmff94s", "uff"] = Field(
        default="auto", description="`auto` uses MMFF94 and falls back to UFF when MMFF94 has no parameters for the molecule."
    )
    max_iterations: int = Field(default=2000, ge=1, le=200_000, description="Upper limit on minimiser iterations.")
    random_seed: int = Field(default=DEFAULT_SEED, ge=0, le=2**31 - 1, description="Seed for ETKDG, used only when a starting geometry has to be generated.")
    record_trajectory: bool = Field(
        default=False,
        description=(
            "Return intermediate geometries and energies, and the exact iteration count. RDKit exposes neither, so the minimisation is "
            "replayed once per frame; expect roughly trajectory_max_frames / 2 times the cost of a plain optimisation."
        ),
    )
    trajectory_stride: int = Field(default=1, ge=1, le=10_000, description="Minimum number of minimiser iterations between recorded frames.")
    trajectory_max_frames: int = Field(
        default=30, ge=2, le=500, description="Upper limit on recorded frames; the stride is widened as needed to respect it."
    )


class ConformerSearchSettings(_Strict):
    num_conformers: int = Field(default=50, ge=1, le=2000, description="Number of conformers to embed.")
    force_field: Literal["auto", "mmff94", "mmff94s", "uff", "none"] = Field(
        default="auto", description="Force field used to minimise and rank conformers; `none` returns the raw ETKDG conformers unranked."
    )
    max_iterations: int = Field(default=500, ge=1, le=100_000, description="Minimiser iteration limit per conformer.")
    random_seed: int = Field(default=DEFAULT_SEED, ge=0, le=2**31 - 1)
    prune_rms_threshold_angstrom: float = Field(
        default=0.5, ge=0.0, le=10.0, description="Minimised conformers closer than this heavy-atom RMSD (after alignment) to a lower-energy one are dropped."
    )
    energy_window_kcal_per_mol: float | None = Field(
        default=None, gt=0, description="When set, conformers more than this far above the lowest energy are dropped."
    )
    max_returned: int = Field(default=10, ge=1, le=200, description="Return at most this many conformers, lowest energy first.")


class XtbSettings(_Strict):
    method: Literal["GFN2-xTB", "GFN1-xTB"] = "GFN2-xTB"
    accuracy: float = Field(default=1.0, gt=0, le=1000, description="tblite numerical accuracy factor for the self-consistent cycle (1.0 is the default; smaller is tighter).")
    max_scf_iterations: int = Field(default=250, ge=1, le=10_000)
    electronic_temperature_k: float = Field(default=300.0, gt=0, le=100_000, description="Electronic temperature for Fermi smearing, in kelvin.")
    random_seed: int = Field(default=DEFAULT_SEED, ge=0, le=2**31 - 1, description="Seed for ETKDG, used only when a geometry has to be generated.")


class XtbOptimizationSettings(XtbSettings):
    max_steps: int = Field(default=500, ge=1, le=20_000, description="Upper limit on optimiser steps.")
    force_tolerance_ev_per_angstrom: float = Field(default=0.05, gt=0, le=10, description="Converged when the largest atomic force falls below this value.")
    record_trajectory: bool = False
    trajectory_max_frames: int = Field(default=200, ge=2, le=2000)


class PyscfSettings(_Strict):
    method: Literal["hf", "dft"] = Field(default="hf", description="`hf` for Hartree-Fock, `dft` for Kohn-Sham DFT.")
    functional: str | None = Field(
        default=None,
        max_length=64,
        description="Exchange-correlation functional for `dft`, by its libxc/PySCF name (e.g. `b3lyp`, `pbe`, `pbe0`). Defaults to `b3lyp` for `dft`; must be omitted for `hf`.",
    )
    basis: str = Field(default="sto-3g", min_length=1, max_length=64, description="Gaussian basis set by its PySCF name, e.g. `sto-3g`, `6-31g*`, `def2-svp`, `cc-pvdz`.")
    max_scf_cycles: int = Field(default=100, ge=1, le=2000)
    convergence_tolerance_hartree: float = Field(default=1e-9, gt=0, le=1e-3, description="SCF energy convergence threshold.")
    grid_level: int = Field(default=3, ge=0, le=9, description="PySCF DFT integration grid level (used by `dft` only).")
    random_seed: int = Field(default=DEFAULT_SEED, ge=0, le=2**31 - 1, description="Seed for ETKDG, used only when a geometry has to be generated.")

    @model_validator(mode="after")
    def _functional_matches_method(self) -> "PyscfSettings":
        if self.method == "hf":
            if self.functional is not None:
                raise ValueError("`functional` applies to method `dft` only")
        else:
            self.functional = (self.functional or "b3lyp").strip().lower()
            if not self.functional:
                raise ValueError("`functional` must not be empty")
        self.basis = self.basis.strip().lower()
        return self


# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------


class ForceFieldUse(_Strict):
    requested: str
    used: str | None = Field(description="Force field that actually ran: MMFF94, MMFF94s or UFF; null when none was applied.")
    fallback_reason: str | None = Field(description="Set when the requested force field was replaced by another, with RDKit's reason.")
    interfragment_interactions: Literal["included"] = "included"


class TrajectoryFrame(_Strict):
    iteration: int
    energy: float = Field(description="Energy of the frame, in the unit named by `energy_unit` of the trajectory.")
    coordinates_angstrom: list[list[float]]


class Trajectory(_Strict):
    energy_unit: str
    stride: int = Field(description="Minimiser iterations (or optimiser steps) between recorded frames.")
    frames_recorded: int
    frames_returned: int
    thinned: bool = Field(description="True when recorded frames were evenly thinned to respect the frame limit.")
    note: str = Field(description="How the frames were obtained.")
    frames: list[TrajectoryFrame]


class StructureSummary(_Strict):
    canonical_smiles: str
    inchikey: str | None
    molecular_formula: str
    formal_charge: int
    atom_count: int = Field(description="Number of atoms in the calculation, hydrogens included.")


class GeometryOptimizationResult(_Strict):
    structure: StructureSummary
    starting_geometry: GeometrySource
    force_field: ForceFieldUse
    converged: bool
    max_iterations: int
    iterations: int | None = Field(
        description="Exact number of minimiser iterations used. RDKit does not report it, so it is determined only when a trajectory is recorded; otherwise null."
    )
    energy_initial_kcal_per_mol: float
    energy_final_kcal_per_mol: float
    energy_change_kcal_per_mol: float
    gradient_rms_initial_kcal_per_mol_angstrom: float
    gradient_rms_final_kcal_per_mol_angstrom: float
    atoms: list[Atom3D]
    bonds: list[Bond3D]
    molblock: str = Field(description="Optimised geometry as a V2000 molfile.")
    trajectory: Trajectory | None
    units: dict[str, str]
    warnings: list[str]


class Conformer(_Strict):
    rank: int = Field(description="1 is the lowest-energy conformer returned.")
    conformer_id: int = Field(description="Index of the conformer in the order of embedding.")
    energy_kcal_per_mol: float | None
    relative_energy_kcal_per_mol: float | None
    converged: bool | None
    coordinates_angstrom: list[list[float]]


class ConformerSearchResult(_Strict):
    structure: StructureSummary
    embedding_method: str
    random_seed: int
    force_field: ForceFieldUse
    conformers_requested: int
    conformers_embedded: int
    conformers_unique: int = Field(description="Conformers left after energy-window and RMSD pruning.")
    conformers_returned: int
    all_converged: bool | None
    atoms: list[Atom3D] = Field(description="Atoms with the coordinates of the lowest-energy conformer.")
    bonds: list[Bond3D]
    conformers: list[Conformer]
    units: dict[str, str]
    warnings: list[str]


class BondOrder(_Strict):
    begin_atom_index: int
    end_atom_index: int
    wiberg_bond_order: float


class UnitConversions(_Strict):
    source: str = Field(description="Where the conversion factors come from.")
    hartree_to_ev: float
    bohr_to_angstrom: float
    atomic_unit_of_dipole_to_debye: float


class XtbSinglePointResult(_Strict):
    method: str
    charge: int
    multiplicity: int
    electron_count: int
    geometry: GeometrySource
    converged: bool
    energy_hartree: float
    energy_ev: float
    gradient_rms_hartree_per_bohr: float
    gradient_max_hartree_per_bohr: float
    partial_charges_e: list[float] = Field(description="Mulliken partial charges as reported by tblite, one per atom.")
    dipole_debye: list[float]
    dipole_magnitude_debye: float
    orbital_energies_hartree: list[float]
    orbital_occupations: list[float]
    homo_lumo_gap_ev: float | None = Field(description="Gap between the highest occupied and lowest unoccupied orbital; null when it is not defined.")
    bond_orders: list[BondOrder] = Field(description="Wiberg bond orders above 0.05.")
    atoms: list[Atom3D]
    units: dict[str, str]
    conversions: UnitConversions
    warnings: list[str]


class XtbOptimizationResult(_Strict):
    method: str
    optimizer: str
    charge: int
    multiplicity: int
    electron_count: int
    geometry: GeometrySource
    converged: bool
    steps: int
    max_steps: int
    force_tolerance_ev_per_angstrom: float
    max_force_initial_ev_per_angstrom: float
    max_force_final_ev_per_angstrom: float
    forces_ev_per_angstrom: list[tuple[float, float, float]] | None = Field(
        default=None, description="Cartesian forces at the returned geometry, one vector per atom in input order. Null for older stored records."
    )
    energy_initial_hartree: float
    energy_final_hartree: float
    energy_change_hartree: float
    energy_final_ev: float
    partial_charges_e: list[float]
    dipole_debye: list[float]
    dipole_magnitude_debye: float
    atoms: list[Atom3D]
    trajectory: Trajectory | None
    units: dict[str, str]
    conversions: UnitConversions
    warnings: list[str]


class PyscfSinglePointResult(_Strict):
    scf_type: Literal["RHF", "UHF", "RKS", "UKS"]
    method: str = Field(description="Level of theory, e.g. `RHF/sto-3g` or `RKS/b3lyp/6-31g*`.")
    functional: str | None
    basis: str
    grid_level: int | None
    charge: int
    multiplicity: int
    electron_count: int
    basis_function_count: int
    geometry: GeometrySource
    converged: bool
    scf_cycles: int
    energy_hartree: float
    energy_ev: float
    nuclear_repulsion_hartree: float
    orbital_energies_hartree: list[float] = Field(description="Molecular orbital energies; the alpha orbitals for unrestricted calculations.")
    orbital_occupations: list[float]
    beta_orbital_energies_hartree: list[float] | None = Field(description="Beta orbital energies (unrestricted calculations only).")
    beta_orbital_occupations: list[float] | None
    homo_energy_hartree: float | None
    lumo_energy_hartree: float | None
    homo_lumo_gap_ev: float | None
    spin_square: float | None = Field(description="<S^2> (unrestricted calculations only).")
    mulliken_charges_e: list[float]
    dipole_debye: list[float]
    dipole_magnitude_debye: float
    atoms: list[Atom3D]
    units: dict[str, str]
    conversions: UnitConversions
    warnings: list[str]


# ---------------------------------------------------------------------------------------------
# Requests (discriminated by `kind`) and the registry
# ---------------------------------------------------------------------------------------------

_TIMEOUT = Field(
    default=None,
    gt=0,
    description="Wall-clock limit for this job in seconds. Defaults to the service setting and is capped by it. Not part of the request hash.",
)


class RdkitGeometryOptimizationRequest(_Strict):
    kind: Literal["rdkit.geometry_optimization"]
    input: StructureJobInput
    settings: GeometryOptimizationSettings = Field(default_factory=GeometryOptimizationSettings)
    timeout_seconds: float | None = _TIMEOUT


class RdkitConformerSearchRequest(_Strict):
    kind: Literal["rdkit.conformer_search"]
    input: StructureJobInput
    settings: ConformerSearchSettings = Field(default_factory=ConformerSearchSettings)
    timeout_seconds: float | None = _TIMEOUT


class XtbSinglePointRequest(_Strict):
    kind: Literal["xtb.single_point"]
    input: QuantumJobInput
    settings: XtbSettings = Field(default_factory=XtbSettings)
    timeout_seconds: float | None = _TIMEOUT


class XtbGeometryOptimizationRequest(_Strict):
    kind: Literal["xtb.geometry_optimization"]
    input: QuantumJobInput
    settings: XtbOptimizationSettings = Field(default_factory=XtbOptimizationSettings)
    timeout_seconds: float | None = _TIMEOUT


class PyscfSinglePointRequest(_Strict):
    kind: Literal["pyscf.single_point"]
    input: QuantumJobInput
    settings: PyscfSettings = Field(default_factory=PyscfSettings)
    timeout_seconds: float | None = _TIMEOUT


JobRequest = Annotated[
    Union[
        RdkitGeometryOptimizationRequest,
        RdkitConformerSearchRequest,
        XtbSinglePointRequest,
        XtbGeometryOptimizationRequest,
        PyscfSinglePointRequest,
    ],
    Field(discriminator="kind"),
]


@dataclass(frozen=True)
class JobKind:
    name: str
    engine: str
    title: str
    description: str
    request_model: type[BaseModel]
    input_model: type[BaseModel]
    settings_model: type[BaseModel]
    result_model: type[BaseModel]
    runner: str
    required_components: tuple[str, ...] = ()


KINDS: dict[str, JobKind] = {
    kind.name: kind
    for kind in (
        JobKind(
            name="rdkit.geometry_optimization",
            engine="rdkit",
            title="Force-field geometry optimisation (RDKit)",
            description="Minimises a geometry with MMFF94 (or UFF when MMFF94 has no parameters) and returns the optimised coordinates, energies before and after, and convergence.",
            request_model=RdkitGeometryOptimizationRequest,
            input_model=StructureJobInput,
            settings_model=GeometryOptimizationSettings,
            result_model=GeometryOptimizationResult,
            runner="matterlab_science.jobs.tasks_rdkit:geometry_optimization",
        ),
        JobKind(
            name="rdkit.conformer_search",
            engine="rdkit",
            title="Conformer search (RDKit)",
            description="Embeds conformers with ETKDGv3, minimises them with a force field, removes duplicates and returns the lowest-energy ones.",
            request_model=RdkitConformerSearchRequest,
            input_model=StructureJobInput,
            settings_model=ConformerSearchSettings,
            result_model=ConformerSearchResult,
            runner="matterlab_science.jobs.tasks_rdkit:conformer_search",
        ),
        JobKind(
            name="xtb.single_point",
            engine="xtb",
            title="GFN-xTB single point (tblite)",
            description="Semi-empirical tight-binding energy, partial charges, dipole, orbital energies and bond orders at a fixed geometry.",
            request_model=XtbSinglePointRequest,
            input_model=QuantumJobInput,
            settings_model=XtbSettings,
            result_model=XtbSinglePointResult,
            runner="matterlab_science.jobs.tasks_xtb:single_point",
        ),
        JobKind(
            name="xtb.geometry_optimization",
            engine="xtb",
            title="GFN-xTB geometry optimisation (tblite + ASE)",
            description="Optimises a geometry on the GFN-xTB potential energy surface with ASE's LBFGS optimiser.",
            request_model=XtbGeometryOptimizationRequest,
            input_model=QuantumJobInput,
            settings_model=XtbOptimizationSettings,
            result_model=XtbOptimizationResult,
            runner="matterlab_science.jobs.tasks_xtb:geometry_optimization",
            required_components=("ase",),
        ),
        JobKind(
            name="pyscf.single_point",
            engine="pyscf",
            title="Hartree-Fock / DFT single point (PySCF)",
            description="Self-consistent-field energy, orbital energies, Mulliken charges and dipole moment with a selectable basis set and functional.",
            request_model=PyscfSinglePointRequest,
            input_model=QuantumJobInput,
            settings_model=PyscfSettings,
            result_model=PyscfSinglePointResult,
            runner="matterlab_science.jobs.tasks_pyscf:single_point",
        ),
    )
}


def canonical_request(request: BaseModel) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """(kind, input document, settings document) of a validated request, defaults filled in."""
    kind = request.kind  # type: ignore[attr-defined]
    return kind, request.input.model_dump(mode="json"), request.settings.model_dump(mode="json")  # type: ignore[attr-defined]
