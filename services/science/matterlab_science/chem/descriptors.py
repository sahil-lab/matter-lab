"""Property-panel descriptors from RDKit, each labelled with its method and how far to trust it."""

from __future__ import annotations

from typing import Any

from rdkit import Chem
from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors


def _quantity(value: float | int, unit: str | None, evidence: str, method: str, *, is_estimate: bool) -> dict[str, Any]:
    return {"value": value, "unit": unit, "evidence": evidence, "is_estimate": is_estimate, "method": method}


def descriptors(mol: Chem.Mol) -> dict[str, dict[str, Any]]:
    """`evidence` uses the frontend vocabulary: `computed` for exact arithmetic on the structure,
    `rule-based` for values that depend on an empirical model or a pattern definition."""
    return {
        "molecular_weight": _quantity(
            float(Descriptors.MolWt(mol)),
            "g/mol",
            "computed",
            "Sum of standard atomic weights (RDKit Descriptors.MolWt)",
            is_estimate=False,
        ),
        "monoisotopic_mass": _quantity(
            float(Descriptors.ExactMolWt(mol)),
            "u",
            "computed",
            "Sum of the masses of the most abundant isotopes (RDKit Descriptors.ExactMolWt)",
            is_estimate=False,
        ),
        "logp": _quantity(
            float(Crippen.MolLogP(mol)),
            None,
            "rule-based",
            "Wildman-Crippen atom-contribution estimate of the octanol/water log P (RDKit Crippen.MolLogP); an estimate, not a measurement",
            is_estimate=True,
        ),
        "molar_refractivity": _quantity(
            float(Crippen.MolMR(mol)),
            "cm^3/mol",
            "rule-based",
            "Wildman-Crippen atom-contribution estimate (RDKit Crippen.MolMR); an estimate, not a measurement",
            is_estimate=True,
        ),
        "tpsa": _quantity(
            float(rdMolDescriptors.CalcTPSA(mol)),
            "angstrom^2",
            "rule-based",
            "Topological polar surface area from Ertl fragment contributions for N and O (RDKit CalcTPSA); an estimate that uses no 3D geometry",
            is_estimate=True,
        ),
        "h_bond_donors": _quantity(
            int(rdMolDescriptors.CalcNumHBD(mol)),
            "count",
            "rule-based",
            "Count of atoms matching RDKit's hydrogen-bond donor pattern (CalcNumHBD)",
            is_estimate=False,
        ),
        "h_bond_acceptors": _quantity(
            int(rdMolDescriptors.CalcNumHBA(mol)),
            "count",
            "rule-based",
            "Count of atoms matching RDKit's hydrogen-bond acceptor pattern (CalcNumHBA)",
            is_estimate=False,
        ),
        "rotatable_bonds": _quantity(
            int(rdMolDescriptors.CalcNumRotatableBonds(mol)),
            "count",
            "rule-based",
            "Count of rotatable bonds, RDKit strict definition (CalcNumRotatableBonds)",
            is_estimate=False,
        ),
        "heavy_atoms": _quantity(int(mol.GetNumHeavyAtoms()), "count", "computed", "Count of non-hydrogen atoms", is_estimate=False),
        "rings": _quantity(int(rdMolDescriptors.CalcNumRings(mol)), "count", "computed", "Number of rings in the smallest set of smallest rings (RDKit CalcNumRings)", is_estimate=False),
        "aromatic_rings": _quantity(
            int(rdMolDescriptors.CalcNumAromaticRings(mol)),
            "count",
            "rule-based",
            "Rings that are aromatic under RDKit's aromaticity model (CalcNumAromaticRings)",
            is_estimate=False,
        ),
        "fraction_sp3_carbons": _quantity(
            float(rdMolDescriptors.CalcFractionCSP3(mol)),
            None,
            "computed",
            "Fraction of carbon atoms that are sp3 hybridised (RDKit CalcFractionCSP3)",
            is_estimate=False,
        ),
        "formal_charge": _quantity(int(Chem.GetFormalCharge(mol)), "e", "computed", "Sum of atomic formal charges", is_estimate=False),
    }
