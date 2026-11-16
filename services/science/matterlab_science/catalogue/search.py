"""In-service catalogue search with RDKit.

PostgreSQL stores the catalogue (structures and fingerprints) but has no chemistry cartridge, so
it cannot evaluate a substructure or similarity query itself. This index loads the catalogue rows
from PostgreSQL into memory and runs those searches in the service process with RDKit. It reloads
whenever the compounds table changes, so the database stays the single source of truth.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from rdkit import Chem, DataStructs

from ..chem import fingerprints
from ..chem.structure import standard_mol
from ..db import Database

log = logging.getLogger("matterlab.catalogue")

CATALOG_KEY = "matterlab-compound-catalogue"
CATALOG_TITLE = "MATTER LAB local compound catalogue"
CATALOG_DESCRIPTION = (
    "The compounds table of this MATTER LAB instance (a small starter catalogue seeded from PubChem, plus any imported compounds). "
    "It is searched inside the science service with RDKit; it is not a comprehensive chemical database."
)
SIMILARITY_METHOD = (
    f"Tanimoto similarity of Morgan bit fingerprints (radius {fingerprints.MORGAN_RADIUS}, {fingerprints.MORGAN_BITS} bits, no chirality), "
    "computed in the science service with RDKit on catalogue rows loaded from PostgreSQL"
)
SUBSTRUCTURE_METHOD = (
    "RDKit substructure matching (pattern-fingerprint pre-screen, then atom-by-atom match without chirality), "
    "run in the science service on catalogue rows loaded from PostgreSQL"
)
EXACT_METHOD = "Equality of the standard InChIKey computed by RDKit (SQL lookup on the unique inchikey column)"


@dataclass(frozen=True)
class Entry:
    id: UUID
    name: str
    canonical_smiles: str
    inchikey: str
    molecular_formula: str
    molecular_weight_g_per_mol: float
    mol: Chem.Mol
    morgan: DataStructs.ExplicitBitVect
    pattern: DataStructs.ExplicitBitVect

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "canonical_smiles": self.canonical_smiles,
            "inchikey": self.inchikey,
            "molecular_formula": self.molecular_formula,
            "molecular_weight_g_per_mol": self.molecular_weight_g_per_mol,
        }


class CatalogueIndex:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._lock = threading.Lock()
        self._stamp: tuple[Any, ...] | None = None
        self._entries: list[Entry] = []
        self._morgan: list[DataStructs.ExplicitBitVect] = []
        self._loaded_at: datetime | None = None

    def _current(self) -> list[Entry]:
        row = self._db.fetch_one("SELECT count(*) AS n, max(updated_at) AS updated, max(created_at) AS created FROM compounds")
        stamp = (row["n"], row["updated"], row["created"]) if row else (0, None, None)
        with self._lock:
            if stamp != self._stamp:
                rows = self._db.fetch_all(
                    "SELECT id, name, canonical_smiles, inchikey, molecular_formula, molecular_weight_g_per_mol, morgan_fp, pattern_fp, fingerprint_params "
                    "FROM compounds ORDER BY lower(name), id"
                )
                entries: list[Entry] = []
                recomputed = 0
                for r in rows:
                    mol = Chem.MolFromSmiles(r["canonical_smiles"])
                    if mol is None:
                        log.warning("catalogue compound %s has a canonical SMILES this RDKit cannot read; it is skipped by searches", r["id"])
                        continue
                    if r["fingerprint_params"] == fingerprints.FINGERPRINT_PARAMS:
                        morgan, pattern = fingerprints.from_bytes(r["morgan_fp"]), fingerprints.from_bytes(r["pattern_fp"])
                    else:
                        # Stored with other parameters (e.g. by an older release): recompute in memory.
                        morgan, pattern = fingerprints.morgan(mol), fingerprints.pattern(mol)
                        recomputed += 1
                    entries.append(
                        Entry(r["id"], r["name"], r["canonical_smiles"], r["inchikey"], r["molecular_formula"], r["molecular_weight_g_per_mol"], mol, morgan, pattern)
                    )
                self._entries = entries
                self._morgan = [e.morgan for e in entries]
                self._stamp = stamp
                self._loaded_at = datetime.now(timezone.utc)
                log.info("catalogue index loaded: %d compound(s)%s", len(entries), f", {recomputed} fingerprint(s) recomputed" if recomputed else "")
            return self._entries

    def record_count(self) -> int:
        return len(self._current())

    def similarity(self, mol: Chem.Mol, *, threshold: float, limit: int) -> tuple[list[tuple[Entry, float]], int, int]:
        """(hits sorted by decreasing similarity, number of hits at or above the threshold, records searched)."""
        entries = self._current()
        if not entries:
            return [], 0, 0
        query = fingerprints.morgan(standard_mol(mol))
        with self._lock:
            scores = DataStructs.BulkTanimotoSimilarity(query, self._morgan)
        ranked = sorted(((score, index) for index, score in enumerate(scores) if score >= threshold), key=lambda item: (-item[0], item[1]))
        return [(entries[index], float(score)) for score, index in ranked[:limit]], len(ranked), len(entries)

    def substructure(self, query: Chem.Mol, *, limit: int, offset: int = 0) -> tuple[list[tuple[Entry, list[int]]], int, int]:
        """(page of matches with the matched atom indices, total matches, records searched)."""
        entries = self._current()
        screen = fingerprints.pattern(query)
        hits: list[tuple[Entry, list[int]]] = []
        for entry in entries:
            if not DataStructs.AllProbeBitsMatch(screen, entry.pattern):
                continue
            match = entry.mol.GetSubstructMatch(query)
            if match:
                hits.append((entry, [int(i) for i in match]))
        return hits[offset : offset + limit], len(hits), len(entries)

    def exact(self, inchikey: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
        """(records with this InChIKey, records sharing only its connectivity block, records searched)."""
        columns = "id, name, canonical_smiles, inchikey, molecular_formula, molecular_weight_g_per_mol"
        with self._db.connection() as conn:
            exact = conn.execute(f"SELECT {columns} FROM compounds WHERE inchikey = %s", (inchikey,)).fetchall()
            related = conn.execute(
                f"SELECT {columns} FROM compounds WHERE left(inchikey, 14) = %s AND inchikey <> %s ORDER BY lower(name)",
                (inchikey[:14], inchikey),
            ).fetchall()
            total = conn.execute("SELECT count(*) AS n FROM compounds").fetchone()
        return exact, related, int(total["n"]) if total else 0
