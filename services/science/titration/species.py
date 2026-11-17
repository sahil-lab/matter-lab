"""Registry of chemical species the titration solver recognises.

Scope (v2: polyprotic acids/bases and multi-weak-system mixtures, extending the v1 scope of
`Agent_06_Scientific_Chemistry_and_Titration_Engine.md` by explicit user request -- see
`services/science/titration/README.md` Section 3 for what changed and why): strong or weak,
monoprotic or polyprotic acids and bases, any number of distinct weak-acid/weak-base systems
together, water autoionization, dilution, and buffers prepared either by partial neutralization or
by dosing a weak acid/base together with its conjugate salt.

Every entry below that carries a pKa is cited to a specific, checkable source; none is a memorised
textbook number used without a reference. Where a value could plausibly be looked up several ways,
the source actually used is named so a reviewer can re-derive it. A few species are registered as
explicitly unsupported with a precise, chemistry-specific reason (e.g. boric acid, a Lewis acid
that does not dissociate as a simple proton donor) so a request for them answers with that reason
instead of a generic "unknown species" error.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .ka_temperature import ACETIC_ACID_IONIZATION_THERMODYNAMICS, IonizationThermodynamics
from .provenance import Citation, Provenance

#: What role a species plays in the equilibrium. `unsupported_other` entries are registered on
#: purpose so a user who reaches for them gets a precise, named reason instead of a generic
#: "unknown species" error.
SpeciesRole = Literal[
    "water",
    "strong_acid",
    "strong_base",
    "weak_acid",
    "weak_base",
    "weak_acid_conjugate_salt",
    "weak_base_conjugate_salt",
    "neutral_electrolyte",
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

    #: Ordered stepwise pKa of the relevant Bronsted *acid* form at 298.15 K: of H_nA itself for
    #: `weak_acid` / `weak_acid_conjugate_salt` (one value per ionizable proton, most acidic
    #: first), or of the conjugate acid BH_n^n+ for `weak_base` / `weak_base_conjugate_salt`.
    #: `None` for roles that do not use one. A monoprotic/monoacidic system is the `len() == 1`
    #: case; `equilibrium.py`'s n-step formulas treat every system this way, so there is no
    #: separate "polyprotic" code path.
    pKa_steps: tuple[float, ...] | None = None

    #: Identifier grouping species that share one equilibrium (e.g. "acetic-acid" for both
    #: "acetic-acid" and "sodium-acetate"); `None` for species with no such pool (water, strong
    #: acids/bases, neutral electrolytes, unsupported entries).
    system_id: str | None = None

    #: Per mole dosed: how many moles feed the named weak-acid/weak-base system total
    #: concentration (always 1.0 for every role that has a `system_id`, kept explicit for clarity).
    system_total_per_mole: float = 0.0

    #: Per mole dosed: moles of "complete, non-equilibrating acid/base equivalent" contributed
    #: (strong acids/bases only): a strong acid contributes to the spectator-anion side of the
    #: charge balance at the full dosed amount, with no Ka; symmetrically for a strong base. Set
    #: to 2.0 for a diacidic strong base (e.g. Ca(OH)2: two hydroxide ions per formula unit).
    strong_acid_equivalent_per_mole: float = 0.0
    strong_base_equivalent_per_mole: float = 0.0

    #: Per mole dosed: additional inert (non-equilibrating) cation/anion charge contributed, beyond
    #: whatever the strong/weak acid-base bookkeeping above already counts. Used for conjugate
    #: salts (e.g. the Na+ of sodium acetate, the Cl- of ammonium chloride) and for simple
    #: supporting electrolytes (e.g. NaCl) that affect ionic strength but not pH under the ideal
    #: activity model.
    extra_spectator_cation_per_mole: float = 0.0
    extra_spectator_anion_per_mole: float = 0.0

    #: Sourced ionization enthalpy/heat-capacity enabling a real Ka(T) model (`ka_temperature.py`)
    #: over a wider, independently validated range than the generic +/-10 K band; `None` for every
    #: species without one (the overwhelming majority -- see `ka_temperature.py` module docstring
    #: for why only acetic acid has one in this session).
    ionization_thermodynamics: IonizationThermodynamics | None = None

    provenance: Provenance | None = None
    unsupported_reason: str | None = None

    @property
    def Ka_steps(self) -> tuple[float, ...] | None:
        return None if self.pKa_steps is None else tuple(10.0 ** (-p) for p in self.pKa_steps)

    @property
    def pKa_298_15k(self) -> float | None:
        """The single pKa, for a monoprotic/monoacidic system only (`len(pKa_steps) == 1`); `None`
        for a polyprotic system, which has no single pKa to report (use `pKa_steps`)."""
        return self.pKa_steps[0] if self.pKa_steps is not None and len(self.pKa_steps) == 1 else None

    @property
    def Ka_298_15k(self) -> float | None:
        p = self.pKa_298_15k
        return None if p is None else 10.0 ** (-p)


def _acid(
    species_id: str, name: str, formula: str, pKa_steps: tuple[float, ...], citation: Citation, notes: str, *, evidence: str = "REFERENCE_MEASURED", ionization_thermodynamics: IonizationThermodynamics | None = None
) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_acid",
        pKa_steps=pKa_steps,
        system_id=species_id,
        system_total_per_mole=1.0,
        ionization_thermodynamics=ionization_thermodynamics,
        provenance=Provenance(source=citation.source or citation.title, evidence=evidence, citations=(citation,), notes=notes),
    )


def _conjugate_salt_of_acid(species_id: str, name: str, formula: str, acid_system_id: str, pKa_steps: tuple[float, ...], cation_charge: int) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_acid_conjugate_salt",
        charge_as_dosed=0,
        pKa_steps=pKa_steps,
        system_id=acid_system_id,
        system_total_per_mole=1.0,
        extra_spectator_cation_per_mole=float(cation_charge),
        provenance=Provenance(
            source="Derived: dosed as the fully dissociated salt of the conjugate base",
            evidence="MODEL_CALCULATED",
            notes=f"Feeds the same equilibrium pool as '{acid_system_id}' (shares its Ka); contributes {cation_charge} spectator cation charge per mole dosed.",
        ),
    )


def _base(species_id: str, name: str, formula: str, pKa_conjugate_acid_steps: tuple[float, ...], citation: Citation, notes: str) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="weak_base",
        pKa_steps=pKa_conjugate_acid_steps,
        system_id=species_id,
        system_total_per_mole=1.0,
        provenance=Provenance(source=citation.source or citation.title, evidence="REFERENCE_MEASURED", citations=(citation,), notes=notes),
    )


def _strong_acid(species_id: str, name: str, formula: str, *, protons_per_mole: float = 1.0) -> SpeciesDefinition:
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="strong_acid",
        charge_as_dosed=0,
        strong_acid_equivalent_per_mole=protons_per_mole,
        provenance=Provenance(
            source="Complete dissociation in dilute aqueous solution (textbook-level strong acid, Ka >> 1)",
            evidence="REFERENCE_MEASURED",
            notes="Modelled as fully dissociated (no equilibrium with undissociated acid); its conjugate base is treated as a non-basic spectator anion.",
        ),
    )


def _strong_base(species_id: str, name: str, formula: str, *, hydroxides_per_mole: float = 1.0, solubility_note: str = "") -> SpeciesDefinition:
    notes = "Modelled as fully dissociated into hydroxide ions and a non-acidic spectator cation."
    if solubility_note:
        notes += f" {solubility_note}"
    return SpeciesDefinition(
        species_id=species_id,
        name=name,
        formula=formula,
        role="strong_base",
        charge_as_dosed=0,
        strong_base_equivalent_per_mole=hydroxides_per_mole,
        provenance=Provenance(
            source="Complete dissociation in dilute aqueous solution (textbook-level strong base)",
            evidence="REFERENCE_MEASURED" if hydroxides_per_mole == 1.0 else "MODEL_CALCULATED",
            notes=notes,
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
    # --- strong acids ----------------------------------------------------------------------------
    _strong_acid("hydrochloric-acid", "Hydrochloric acid", "HCl"),
    _strong_acid("nitric-acid", "Nitric acid", "HNO3"),
    _strong_acid("hydrobromic-acid", "Hydrobromic acid", "HBr"),
    # --- strong bases ------------------------------------------------------------------------------
    _strong_base("sodium-hydroxide", "Sodium hydroxide", "NaOH"),
    _strong_base("potassium-hydroxide", "Potassium hydroxide", "KOH"),
    _strong_base(
        "calcium-hydroxide",
        "Calcium hydroxide",
        "Ca(OH)2",
        hydroxides_per_mole=2.0,
        solubility_note=(
            "Diacidic (two OH- per formula unit); modelled here as fully dissolved and fully dissociated. Calcium hydroxide is only sparingly soluble "
            "(roughly 0.02 mol/L in water at 25 degC) and this solver does not model a solubility limit or precipitation -- a request for more than that "
            "concentration is still solved as if it were all in solution, which is itself a limitation worth flagging, not a validated prediction of what "
            "a real saturated/oversaturated slurry would do."
        ),
    ),
    _strong_base(
        "barium-hydroxide",
        "Barium hydroxide",
        "Ba(OH)2",
        hydroxides_per_mole=2.0,
        solubility_note="Diacidic (two OH- per formula unit); modelled as fully dissolved and fully dissociated. No solubility limit is modelled (see calcium hydroxide).",
    ),
    # --- weak acids (monoprotic) -----------------------------------------------------------------
    _acid(
        "acetic-acid",
        "Acetic acid",
        "CH3COOH",
        (4.756,),
        _GOLDBERG_KISHORE_LENNEN_2002,
        "Ka = 1.75e-5, pKa = 4.756 at 25 degC and zero ionic strength (ideal dilute solution); NIST-evaluated.",
        ionization_thermodynamics=ACETIC_ACID_IONIZATION_THERMODYNAMICS,
    ),
    _acid(
        "formic-acid",
        "Formic acid",
        "HCOOH",
        (3.75,),
        _CRC_HANDBOOK_84TH,
        "pKa = 3.75 at 25 degC, as tabulated by the NIST Chemistry WebBook and the CRC Handbook of Chemistry and Physics.",
    ),
    _acid(
        "benzoic-acid",
        "Benzoic acid",
        "C6H5COOH",
        (4.20,),
        _CRC_HANDBOOK_84TH,
        "pKa = 4.20 at 25 degC, as tabulated by the NIST Chemistry WebBook and the CRC Handbook of Chemistry and Physics.",
    ),
    # --- weak acids (polyprotic) -----------------------------------------------------------------
    _acid(
        "sulfuric-acid",
        "Sulfuric acid",
        "H2SO4",
        (-3.0, 1.99),
        _CRC_HANDBOOK_84TH,
        "Diprotic: the first dissociation (H2SO4 -> H+ + HSO4-) is complete in dilute solution, so pKa1 = -3.0 is a representative modelling value "
        "(not an independently measured constant: the literature describes it only as 'extremely large, approximately -2 to -3') rather than a citation; "
        "it is large enough that undissociated H2SO4 is below 1% at any pH from -2 to 14. The second dissociation (HSO4- -> H+ + SO4^2-) is the genuinely "
        "weak, measured step: Ka2 = 1.0e-2, pKa2 = 1.99 at 25 degC, CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook.",
        evidence="MODEL_CALCULATED",  # pKa1 is a modelling choice, not an independent citation (see notes); the pair as a whole is not purely reference data.
    ),
    _acid(
        "phosphoric-acid",
        "Phosphoric acid",
        "H3PO4",
        (2.15, 7.21, 12.32),
        _CRC_HANDBOOK_84TH,
        "Triprotic: Ka1 = 6.9e-3 (pKa1 = 2.15), Ka2 = 6.2e-8 (pKa2 = 7.21), Ka3 = 4.8e-13 (pKa3 = 12.32) at 25 degC, CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook.",
    ),
    _acid(
        "carbonic-acid",
        "Carbonic acid",
        "H2CO3",
        (6.35, 10.33),
        _CRC_HANDBOOK_84TH,
        "Diprotic, using the conventional 'apparent' pKa1 = 6.35 (Ka1 = 4.45e-7) that lumps dissolved CO2(aq) together with true H2CO3 -- the universal "
        "practical convention (true pKa1 of the molecular species alone is approximately 3.6, for a tiny equilibrium fraction of CO2(aq) that is actually "
        "hydrated) -- and pKa2 = 10.33 (Ka2 = 4.7e-11) for HCO3- -> H+ + CO3^2-, both at 25 degC. CRC Handbook of Chemistry and Physics. This solver treats "
        "the dosed amount as a fixed total 'carbonate system' concentration: it does not model exchange with CO2(g) (e.g. loss of CO2 to the atmosphere), "
        "which a real open beaker would show.",
    ),
    _acid(
        "oxalic-acid",
        "Oxalic acid",
        "C2H2O4",
        (1.25, 3.81),
        _CRC_HANDBOOK_84TH,
        "Diprotic: Ka1 = 5.6e-2 (pKa1 = 1.25), Ka2 = 1.5e-4 (pKa2 = 3.81) at 25 degC, CRC Handbook of Chemistry and Physics / NIST Chemistry WebBook.",
    ),
    # --- weak bases (monoprotic/monoacidic) -------------------------------------------------------
    _base(
        "ammonia",
        "Ammonia",
        "NH3",
        (9.25,),
        _NIST_WEBBOOK,
        "pKa(NH4+) = 9.25 at 25 degC (Kb(NH3) = Kw / Ka(NH4+) = 1.8e-5), a standard tabulated value consistent across NIST and CRC compilations.",
    ),
    # --- conjugate salts, for buffers prepared by direct dosing rather than partial titration ----
    _conjugate_salt_of_acid("sodium-acetate", "Sodium acetate", "CH3COONa", "acetic-acid", (4.756,), cation_charge=1),
    SpeciesDefinition(
        species_id="ammonium-chloride",
        name="Ammonium chloride",
        formula="NH4Cl",
        role="weak_base_conjugate_salt",
        pKa_steps=(9.25,),
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
    # --- explicitly out of scope: registered with a precise reason, not left "unknown" ------------
    _unsupported(
        "boric-acid",
        "Boric acid",
        "H3BO3",
        "unsupported_other",
        "Boric acid is a Lewis acid, not a Bronsted proton donor: it raises pH by accepting a hydroxide ion from water "
        "(B(OH)3 + H2O <-> B(OH)4- + H+), not by releasing a proton of its own. The n-step Bronsted dissociation model this "
        "solver implements does not describe that mechanism, so it is excluded rather than given an inapplicable pKa.",
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
