"""Reaction SMILES: parsing, canonicalisation and an element/charge balance check with RDKit."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from rdkit import Chem
from rdkit.Chem import rdChemReactions, rdMolDescriptors

from . import rdlog
from .structure import canonical_smiles, inchi_for


@dataclass
class Species:
    role: str
    position: int
    canonical_smiles: str
    inchikey: str | None
    molecular_formula: str
    stoichiometric_coefficient: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "position": self.position,
            "canonical_smiles": self.canonical_smiles,
            "inchikey": self.inchikey,
            "molecular_formula": self.molecular_formula,
            "stoichiometric_coefficient": self.stoichiometric_coefficient,
        }


@dataclass
class ReactionParse:
    valid: bool
    errors: list[str] = field(default_factory=list)
    reaction_smiles: str | None = None
    participants: list[Species] = field(default_factory=list)
    balanced: bool = False
    element_imbalance: dict[str, int] = field(default_factory=dict)
    charge_imbalance: int = 0


def _composition(mol: Chem.Mol) -> Counter[str]:
    counts: Counter[str] = Counter()
    for atom in Chem.AddHs(mol).GetAtoms():
        counts[atom.GetSymbol()] += 1
    return counts


def parse_reaction(text: str) -> ReactionParse:
    """Reads `reactants>agents>products`. Every species must be a structure RDKit can sanitise.

    `balanced` compares element counts (hydrogens included) and total charge of reactants against
    products; agents are not part of the balance. A positive imbalance means excess on the product side.
    """
    cleaned = text.strip()
    if cleaned.count(">") != 2:
        return ReactionParse(False, ["A reaction SMILES must have the form reactants>agents>products (exactly two '>' characters)."])
    with rdlog.capture() as log:
        try:
            reaction = rdChemReactions.ReactionFromSmarts(cleaned, useSmiles=True)
        except Exception as exc:
            said = rdlog.messages(log)
            return ReactionParse(False, [str(exc)] + [m for m in said if m not in str(exc)])
    if reaction is None:
        return ReactionParse(False, rdlog.messages(log) or ["RDKit could not parse the reaction SMILES."])
    if reaction.GetNumReactantTemplates() == 0 or reaction.GetNumProductTemplates() == 0:
        return ReactionParse(False, ["A reaction needs at least one reactant and one product."])

    errors: list[str] = []
    sides: dict[str, list[tuple[str, Chem.Mol]]] = {"reactant": [], "agent": [], "product": []}
    for role, templates in (("reactant", reaction.GetReactants()), ("agent", reaction.GetAgents()), ("product", reaction.GetProducts())):
        for index, template in enumerate(templates):
            mol = Chem.Mol(template)
            with rdlog.capture() as log:
                problems = Chem.DetectChemistryProblems(mol)
                if not problems:
                    try:
                        Chem.SanitizeMol(mol)
                    except Exception as exc:
                        problems = [exc]
            if problems:
                detail = "; ".join(p.Message() if hasattr(p, "Message") else str(p) for p in problems)
                errors.append(f"{role} {index + 1}: {detail}")
                continue
            sides[role].append((canonical_smiles(mol), mol))
    if errors:
        return ReactionParse(False, errors)

    participants: list[Species] = []
    totals: dict[str, Counter[str]] = {"reactant": Counter(), "product": Counter()}
    charges = {"reactant": 0, "product": 0}
    for role, species in sides.items():
        order: list[str] = []
        grouped: dict[str, list[Chem.Mol]] = {}
        for smiles, mol in species:
            if smiles not in grouped:
                order.append(smiles)
                grouped[smiles] = []
            grouped[smiles].append(mol)
        for position, smiles in enumerate(order):
            mol = grouped[smiles][0]
            _inchi, inchikey, _notes = inchi_for(mol)
            participants.append(
                Species(role, position, smiles, inchikey, rdMolDescriptors.CalcMolFormula(mol), len(grouped[smiles]))
            )
            if role in totals:
                for symbol, count in _composition(mol).items():
                    totals[role][symbol] += count * len(grouped[smiles])
                charges[role] += Chem.GetFormalCharge(mol) * len(grouped[smiles])

    imbalance = {
        symbol: totals["product"][symbol] - totals["reactant"][symbol]
        for symbol in sorted(set(totals["product"]) | set(totals["reactant"]))
        if totals["product"][symbol] != totals["reactant"][symbol]
    }
    charge_imbalance = charges["product"] - charges["reactant"]

    def side(role: str) -> str:
        return ".".join(smiles for smiles, _ in sides[role])

    return ReactionParse(
        valid=True,
        reaction_smiles=f"{side('reactant')}>{side('agent')}>{side('product')}",
        participants=participants,
        balanced=not imbalance and charge_imbalance == 0,
        element_imbalance=imbalance,
        charge_imbalance=charge_imbalance,
    )
