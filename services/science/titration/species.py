"""Registry of chemical species the v1 titration solver recognises.

v1 scientific scope (from `Agent_06_Scientific_Chemistry_and_Titration_Engine.md`): strong
monoprotic acid/strong base; weak monoprotic acid/strong base; weak base/strong acid; water
autoionization; dilution; and buffer cases prepared either by partial neutralization or by
dosing a weak acid/base together with its conjugate salt. Polyprotic acids/bases and mixtures of
several distinct weak systems are out of scope and are rejected as `UNSUPPORTED` by
`solver.classify_system`, not silently approximated.

Every entry below that carries a Ka value is cited to a specific, checkable source; none is a
memorised textbook number used without a reference. Where a value could plausibly be looked up
several ways, the source actually used is named so a reviewer can re-derive it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .provenance import Citation, Provenance

#: What role a species plays in the equilibrium. `unsupported_polyprotic` entries are registered
#: on purpose so that a user who reaches for sulfuric or phosphoric acid gets a precise, named
#: reason instead of a generic "unknown species" error.
SpeciesRole = Literal[
    "water",
    "strong_acid",
    "strong_base",
    "weak_acid",
    "weak_base",
    "weak_acid_conjugate_salt",
    "weak_base_conjugate_salt",
    "neutral_electrolyte",
    "unsupported_polyprotic",
    "unsupported_other",
]

_GOLDBERG_KISHORE_LENNEN_2002 = Citation(
    title="Thermodynamic Quantities for the Ionization Reactions of Buffers",
    authors="Goldberg, R. N.; Kishore, N.; Lennen, R. M.",
    source="Journal of Physical and Chemical Reference Data 31, 231-370",
    year=2002,
    url="https://www.nist.gov/publications/thermodynamic-quantities-ionization-reactions-buffers",
)
_CRC_HANDBOOK_84TH = Citation(
    title="CRC Handbook of Chemistry and Physics, 84th Edition",
    source="CRC Press",
    year=2004,
)
_NIST_WEBBOOK = Citation(
    title="NIST Chemistry WebBook, SRD 69",
    source="National Institute of Standards and Technology",
    url="https://webbook.nist.gov/chemistry/",
)
_IUPAC_NIST_KW = Citation(
    title="Recommended ion product of water at 298.15 K (pKw = 14.00; 13.995 in a more precise evaluation)",
    source="IUPAC / NIST Chemistry WebBook",
)


@dataclass(frozen=True)
class SpeciesDefinition:
    species_id: str
    name: str
    formula: str
    role: SpeciesRole

    #: Charge of the species exactly as it would be dosed (0 for a neutral molecule like CH3COOH or
    #: NH3; informational, not used directly by the solver's arithmetic).
    charge_as_dosed: int = 0

    #: pKa of the relevant Bronsted *acid* form, at 298.15 K: of HA itself for `weak_acid` /
    #: `weak_acid_conjugate_salt`, or of the conjugate acid BH+ for `weak_base` /
    #: `weak_base_conjugate_salt`. `None` for roles that do not use one.
    pKa_298_15k: float | None = None

    #: Identifier grouping species that share one equilibrium (e.g. "acetic-acid" for both
    #: "acetic-acid" and "sodium-acetate"); `None` for species with no such pool (water, strong
    #: acids/bases, neutral electrolytes, unsupported entries).
    system_id: str | None = None

    #: Per mole dosed: how many moles feed the named weak-acid/weak-base system total
    #: concentration (always 1.0 for every role that has a `system_id`, kept explicit for clarity).
    system_total_per_mole: float = 0.0

    #: Per mole dosed: moles of "complete, non-equilibrating acid/base equivalent" contributed
    #: (strong acids/bases only): a strong acid contributes to the spectator-anion side of the
    #: charge balance at the full dosed amount, with no Ka; symmetrically for a strong base.
    strong_acid_equivalent_per_mole: float = 0.0
    strong_base_equivalent_per_mole: float = 0.0

    #: Per mole dosed: additional inert (non-equilibrating) cation/anion charge contributed, beyond
    #: whatever the strong/weak acid-base bookkeeping above already counts. Used for conjugate
    #: salts (e.g. the Na+ of sodium acetate, the Cl- of ammonium chloride) and for simple
    #: supporting electrolytes (e.g. NaCl) that affect ionic strength but not pH under the ideal
    #: activity model.
    extra_spectator_cation_per_mole: float = 0.0
    extra_spectator_anion_per_mole: float = 0.0

    provenance: Provenance | None = None
    unsupported_reason: str | None = None

    @property
    def Ka_298_15k(self) -> float | None:
        return None if self.pKa_298_15k is None else 10.0 ** (-self.pKa_298_15k)


def _acid(species_id: str, name: str, formula: str, pKa: float, citation: Citation, notes: str) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_acid",
        pKa_298_15k=pKa,
        system_id=species_id,
        system_total_per_mole=1.0,
        provenance=Provenance(source=citation.source or citation.title, evidence="REFERENCE_MEASURED", citations=(citation,), notes=notes),
    )


def _conjugate_salt_of_acid(species_id: str, name: str, formula: str, acid_system_id: str, pKa: float, cation_charge: int) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_acid_conjugate_salt",
        charge_as_dosed=0,
        pKa_298_15k=pKa,
        system_id=acid_system_id,
        system_total_per_mole=1.0,
        extra_spectator_cation_per_mole=float(cation_charge),
        provenance=Provenance(
            source="Derived: dosed as the fully dissociated salt of the conjugate base",
            evidence="MODEL_CALCULATED",
            notes=f"Feeds the same equilibrium pool as '{acid_system_id}' (shares its Ka); contributes {cation_charge} spectator cation charge per mole dosed.",
        ),
    )


def _base(species_id: str, name: str, formula: str, pKa_conjugate_acid: float, citation: Citation, notes: str) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_base",
        pKa_298_15k=pKa_conjugate_acid,
        system_id=species_id,
        system_total_per_mole=1.0,
        provenance=Provenance(source=citation.source or citation.title, evidence="REFERENCE_MEASURED", citations=(citation,), notes=notes),
    )


def _strong_acid(species_id: str, name: str, formula: str) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="strong_acid",
        charge_as_dosed=0,
        strong_acid_equivalent_per_mole=1.0,
        provenance=Provenance(
            source="Complete dissociation in dilute aqueous solution (textbook-level strong acid, Ka >> 1)",
            evidence="REFERENCE_MEASURED",
            notes="Modelled as fully dissociated (no equilibrium with undissociated acid); its conjugate base is treated as a non-basic spectator anion.",
        ),
    )


def _strong_base(species_id: str, name: str, formula: str) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="strong_base",
        charge_as_dosed=0,
        strong_base_equivalent_per_mole=1.0,
        provenance=Provenance(
            source="Complete dissociation in dilute aqueous solution (textbook-level strong, monoacidic base)",
            evidence="REFERENCE_MEASURED",
            notes="Modelled as fully dissociated into one hydroxide ion and one non-acidic spectator cation per formula unit.",
        ),
    )


def _unsupported(species_id: str, name: str, formula: str, role: SpeciesRole, reason: str) -> SpeciesDefinition:
    return SpeciesDefinition(species_id=species_id, name=name, formula=formula, role=role, unsupported_reason=reason)


_SPECIES: tuple[SpeciesDefinition, ...] = (
    SpeciesDefinition(
        species_id="water",
        name="Water",
        formula="H2O",
        role="water",
        provenance=Provenance(source="Solvent; see water.py for the Kw(T) model", evidence="REFERENCE_MEASURED"),
    ),
    # --- strong monoprotic acids --------------------------------------------------------------
    _strong_acid("hydrochloric-acid", "Hydrochloric acid", "HCl"),
    _strong_acid("nitric-acid", "Nitric acid", "HNO3"),
    _strong_acid("hydrobromic-acid", "Hydrobromic acid", "HBr"),
    # --- strong monoacidic bases ---------------------------------------------------------------
    _strong_base("sodium-hydroxide", "Sodium hydroxide", "NaOH"),
    _strong_base("potassium-hydroxide", "Potassium hydroxide", "KOH"),
    # --- weak monoprotic acids -------------------------------------------------------------------
    _acid(
        "acetic-acid",
        "Acetic acid",
        "CH3COOH",
        4.756,
        _GOLDBERG_KISHORE_LENNEN_2002,
        "Ka = 1.75e-5, pKa = 4.756 at 25 degC and zero ionic strength (ideal dilute solution); NIST-evaluated.",
    ),
    _acid(
        "formic-acid",
        "Formic acid",
        "HCOOH",
        3.75,
        _CRC_HANDBOOK_84TH,
        "pKa = 3.75 at 25 degC, as tabulated by the NIST Chemistry WebBook and the CRC Handbook of Chemistry and Physics.",
    ),
    _acid(
        "benzoic-acid",
        "Benzoic acid",
        "C6H5COOH",
        4.20,
        _CRC_HANDBOOK_84TH,
        "pKa = 4.20 at 25 degC, as tabulated by the NIST Chemistry WebBook and the CRC Handbook of Chemistry and Physics.",
    ),
    # --- weak monoprotic bases -------------------------------------------------------------------
    _base(
        "ammonia",
        "Ammonia",
        "NH3",
        9.25,
        _NIST_WEBBOOK,
        "pKa(NH4+) = 9.25 at 25 degC (Kb(NH3) = Kw / Ka(NH4+) = 1.8e-5), a standard tabulated value consistent across NIST and CRC compilations.",
    ),
    # --- conjugate salts, for buffers prepared by direct dosing rather than partial titration ----
    _conjugate_salt_of_acid("sodium-acetate", "Sodium acetate", "CH3COONa", "acetic-acid", 4.756, cation_charge=1),
    SpeciesDefinition(
        species_id="ammonium-chloride",
        name="Ammonium chloride",
        formula="NH4Cl",
        role="weak_base_conjugate_salt",
        pKa_298_15k=9.25,
        system_id="ammonia",
        system_total_per_mole=1.0,
        extra_spectator_anion_per_mole=1.0,
        provenance=Provenance(
            source="Derived: dosed as the fully dissociated salt of the conjugate acid",
            evidence="MODEL_CALCULATED",
            notes="Feeds the same equilibrium pool as 'ammonia' (shares its Ka); contributes 1 spectator anion (Cl-) charge per mole dosed.",
        ),
    ),
    # --- simple supporting electrolyte (affects ionic strength only, under the ideal model) ------
    SpeciesDefinition(
        species_id="sodium-chloride",
        name="Sodium chloride",
        formula="NaCl",
        role="neutral_electrolyte",
        extra_spectator_cation_per_mole=1.0,
        extra_spectator_anion_per_mole=1.0,
        provenance=Provenance(source="Complete dissociation; neither ion is acidic or basic", evidence="REFERENCE_MEASURED"),
    ),
    SpeciesDefinition(
        species_id="potassium-nitrate",
        name="Potassium nitrate",
        formula="KNO3",
        role="neutral_electrolyte",
        extra_spectator_cation_per_mole=1.0,
        extra_spectator_anion_per_mole=1.0,
        provenance=Provenance(source="Complete dissociation; neither ion is acidic or basic", evidence="REFERENCE_MEASURED"),
    ),
    # --- explicitly out of v1 scope: registered with a precise reason, not left "unknown" --------
    _unsupported("sulfuric-acid", "Sulfuric acid", "H2SO4", "unsupported_polyprotic", "Diprotic (two acidic protons with distinct Ka1/Ka2); the v1 solver supports monoprotic acids only."),
    _unsupported(
        "phosphoric-acid", "Phosphoric acid", "H3PO4", "unsupported_polyprotic", "Triprotic (three acidic protons with distinct Ka1/Ka2/Ka3); the v1 solver supports monoprotic acids only."
    ),
    _unsupported("carbonic-acid", "Carbonic acid", "H2CO3", "unsupported_polyprotic", "Diprotic (Ka1/Ka2) and involves CO2(aq)/CO2(g) phase equilibria; the v1 solver supports monoprotic acids only."),
    _unsupported(
        "oxalic-acid", "Oxalic acid", "C2H2O4", "unsupported_polyprotic", "Diprotic (two acidic protons with distinct Ka1/Ka2); the v1 solver supports monoprotic acids only."
    ),
    _unsupported(
        "calcium-hydroxide",
        "Calcium hydroxide",
        "Ca(OH)2",
        "unsupported_polyprotic",
        "Diacidic (releases two hydroxide ions per formula unit, and is only sparingly soluble); the v1 solver supports monoacidic strong bases only.",
    ),
)

SPECIES_BY_ID: dict[str, SpeciesDefinition] = {s.species_id: s for s in _SPECIES}

assert len(SPECIES_BY_ID) == len(_SPECIES), "duplicate species_id in the registry"


def lookup(species_id: str) -> SpeciesDefinition | None:
    return SPECIES_BY_ID.get(species_id)


def all_species() -> tuple[SpeciesDefinition, ...]:
    return _SPECIES


def supported_species() -> tuple[SpeciesDefinition, ...]:
    return tuple(s for s in _SPECIES if s.unsupported_reason is None and s.role != "water")
