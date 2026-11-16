"""Fingerprints stored with catalogue compounds and used for similarity and substructure search.

Both fingerprints are computed on the standard form of a molecule (rebuilt from its canonical
SMILES) and stored as raw bit strings, so they do not depend on RDKit's pickle format.
"""

from __future__ import annotations

from typing import Any

from rdkit import Chem, DataStructs
from rdkit.Chem import rdFingerprintGenerator

MORGAN_RADIUS = 2
MORGAN_BITS = 2048
PATTERN_BITS = 2048

_morgan_generator = rdFingerprintGenerator.GetMorganGenerator(radius=MORGAN_RADIUS, fpSize=MORGAN_BITS)

FINGERPRINT_PARAMS: dict[str, Any] = {
    "morgan": {
        "kind": "Morgan (circular) bit fingerprint",
        "radius": MORGAN_RADIUS,
        "bits": MORGAN_BITS,
        "use_chirality": False,
        "rdkit_generator": _morgan_generator.GetInfoString(),
    },
    "pattern": {"kind": "RDKit pattern fingerprint (substructure pre-screen)", "bits": PATTERN_BITS},
    "encoding": "raw bit string as written by RDKit DataStructs.BitVectToBinaryText",
}


def morgan(mol: Chem.Mol) -> DataStructs.ExplicitBitVect:
    return _morgan_generator.GetFingerprint(mol)


def pattern(mol: Chem.Mol) -> DataStructs.ExplicitBitVect:
    return Chem.PatternFingerprint(mol, fpSize=PATTERN_BITS)


def to_bytes(fingerprint: DataStructs.ExplicitBitVect) -> bytes:
    return DataStructs.BitVectToBinaryText(fingerprint)


def from_bytes(raw: bytes) -> DataStructs.ExplicitBitVect:
    return DataStructs.CreateFromBinaryText(bytes(raw))
