"""Seed the chemistry tables: functional groups (RDKit's shipped definitions) and the starter
catalogue, solvents and catalysts (PubChem snapshot under seed/pubchem).

No structure or number is typed in here. Structures and names come from the snapshot fetched by
pubchem_fetch.py; every structure-derived column is recomputed with RDKit.
"""

from __future__ import annotations

import hashlib
import json
from importlib import metadata
from pathlib import Path
from typing import Any

import psycopg

from ..catalogue.records import StructureRejected, compound_fields, parse_or_reject, role_fields, upsert_compound, upsert_role
from ..chem import functional_groups
from ..chem.structure import RDKIT_VERSION
from ..provenance import upsert_data_source
from .reference import SeedError, _upsert_sql, record_seed, seed_is_current

_FG_COLUMNS = ("group_set", "key", "name", "smarts", "description", "parent_key", "position", "source_file", "source_id")


def _rdkit_license() -> str | None:
    try:
        text = metadata.metadata("rdkit").get("License")
    except metadata.PackageNotFoundError:
        return None
    return text if text and len(text) < 80 else None


def seed_functional_groups(conn: psycopg.Connection[Any], *, force: bool = False) -> dict[str, Any]:
    definitions, rejected, files_digest = functional_groups.rdkit_definitions()
    digest = hashlib.sha256(f"{files_digest}:{RDKIT_VERSION}".encode()).hexdigest()
    if not force and seed_is_current(conn, "functional-groups", digest):
        count = conn.execute("SELECT count(*) AS n FROM functional_groups").fetchone()
        return {"seed": "functional-groups", "status": "unchanged", "records": count["n"] if count else 0}

    source_id = upsert_data_source(
        conn,
        key="rdkit-data-files",
        version=RDKIT_VERSION,
        kind="software",
        title="RDKit functional-group definitions (data files shipped with RDKit)",
        publisher="RDKit: Open-source cheminformatics",
        url="https://www.rdkit.org",
        license=_rdkit_license(),
        notes=(
            "Read at seed time from RDConfig.RDDataDir of the installed RDKit: "
            + ", ".join(info["source_file"] for info in functional_groups.SET_INFO.values())
            + ". SMARTS are stored verbatim. For the fragment-descriptor set the display name is RDKit's description without its leading 'Number of'."
        ),
    )
    rows = [tuple(d[c] if c != "source_id" else source_id for c in _FG_COLUMNS) for d in definitions]
    with conn.cursor() as cur:
        cur.executemany(_upsert_sql("functional_groups", _FG_COLUMNS, ("group_set", "key")), rows)
    record_seed(
        conn,
        "functional-groups",
        digest,
        len(rows),
        {"rdkit_version": RDKIT_VERSION, "rejected": [{"group_set": r["group_set"], "key": r["key"], "reason": r["reason"]} for r in rejected]},
    )
    return {"seed": "functional-groups", "status": "applied", "records": len(rows), "rejected": len(rejected)}


def _load_snapshot(seed_dir: Path) -> tuple[dict[str, Any], dict[str, Any], str]:
    names_path = seed_dir / "pubchem" / "names.json"
    snapshot_path = seed_dir / "pubchem" / "snapshot.json"
    for path in (names_path, snapshot_path):
        if not path.is_file():
            raise SeedError(f"catalogue seed input not found: {path} (run python -m matterlab_science.seeding.pubchem_fetch)")
    digest = hashlib.sha256()
    digest.update(names_path.read_bytes())
    digest.update(snapshot_path.read_bytes())
    digest.update(RDKIT_VERSION.encode())
    return json.loads(names_path.read_text(encoding="utf-8")), json.loads(snapshot_path.read_text(encoding="utf-8")), digest.hexdigest()


def seed_catalogue(conn: psycopg.Connection[Any], seed_dir: Path, *, force: bool = False) -> dict[str, Any]:
    names, snapshot, digest = _load_snapshot(seed_dir)
    if not force and seed_is_current(conn, "pubchem-catalogue", digest):
        counts = conn.execute(
            "SELECT (SELECT count(*) FROM compounds) AS compounds, (SELECT count(*) FROM solvents) AS solvents, (SELECT count(*) FROM catalysts) AS catalysts"
        ).fetchone()
        return {"seed": "pubchem-catalogue", "status": "unchanged", **(counts or {})}

    src = snapshot["source"]
    retrieved_on = snapshot["retrieved_on"]
    policy = snapshot["request_policy"]
    source_id = upsert_data_source(
        conn,
        key=src["key"],
        version=f"snapshot {retrieved_on}",
        kind="external-service",
        title=src["title"],
        publisher=src["publisher"],
        url=src["url"],
        license=src["license"],
        retrieved_on=retrieved_on,
        citations=[{"title": "PubChem PUG REST", "source": src["publisher"], "url": src["documentation_url"]}],
        notes=(
            f"{src['attribution']} Retrieved {snapshot['retrieval_started_at']} to {snapshot['retrieval_finished_at']} through PUG REST "
            f"({policy['requests_made']} sequential requests, at most {policy['max_requests_per_second']:g} per second). "
            f"Usage policies: {src['license_url']}. Snapshot file: services/science/seed/pubchem/snapshot.json."
        ),
    )

    resolution = {entry["name"]: entry for entry in snapshot["name_resolution"]}
    records = snapshot["records"]
    skipped: list[dict[str, str]] = []

    def record_for(name: str, list_name: str) -> tuple[int, dict[str, Any]] | None:
        entry = resolution.get(name)
        if entry is None:
            skipped.append({"list": list_name, "name": name, "reason": "not in the snapshot; run pubchem_fetch again"})
            return None
        if entry["chosen_cid"] is None:
            skipped.append({"list": list_name, "name": name, "reason": "PubChem did not resolve this name"})
            return None
        record = records.get(str(entry["chosen_cid"]))
        if record is None:
            skipped.append({"list": list_name, "name": name, "reason": "PubChem returned no properties for the resolved CID"})
            return None
        return entry["chosen_cid"], record

    compound_names: list[str] = list(names["compounds"]) + [n for n in names["solvents"] if n not in names["compounds"]]
    outcomes = {"inserted": 0, "updated": 0, "unchanged": 0}
    compound_count = 0
    for name in compound_names:
        found = record_for(name, "compounds")
        if found is None:
            continue
        cid, record = found
        props = record["properties"]
        try:
            parsed = parse_or_reject("smiles", props["SMILES"])
            fields = compound_fields(parsed.mol)
        except StructureRejected as exc:
            skipped.append({"list": "compounds", "name": name, "reason": f"RDKit rejected the PubChem structure: {exc}"})
            continue
        title = props.get("Title") or name
        synonyms = [(title, "preferred")]
        if props.get("IUPACName"):
            synonyms.append((props["IUPACName"], "iupac"))
        synonyms.append((name, "query"))
        synonyms.extend((s, "synonym") for s in record.get("synonyms", []))
        _, outcome = upsert_compound(
            conn,
            name=title,
            iupac_name=props.get("IUPACName"),
            fields=fields,
            source_id=source_id,
            external_ids={"pubchem_cid": cid},
            source_url=record["record_url"],
            source_record={
                "queried_name": name,
                "properties": props,
                "inchikey_matches_source": fields["inchikey"] == props.get("InChIKey"),
            },
            synonyms=synonyms,
        )
        outcomes[outcome] += 1
        compound_count += 1

    role_counts = {"solvents": 0, "catalysts": 0}
    for table in ("solvents", "catalysts"):
        for name in names[table]:
            found = record_for(name, table)
            if found is None:
                continue
            cid, record = found
            props = record["properties"]
            values = {
                "name": name,
                **role_fields("smiles", props["SMILES"]),
                "external_ids": {"pubchem_cid": cid, "pubchem_inchikey": props.get("InChIKey")},
                "properties": [
                    {
                        "name": "molecular_weight",
                        "value": float(props["MolecularWeight"]),
                        "unit": "g/mol",
                        "evidence": "reference",
                        "source": f"{src['title']}: MolecularWeight as computed by PubChem",
                        "source_key": src["key"],
                        "retrieved": retrieved_on,
                    }
                ]
                if props.get("MolecularWeight")
                else [],
                "source_id": source_id,
                "source_url": record["record_url"],
                "source_record": {"queried_name": name, "properties": props},
            }
            upsert_role(conn, table, values)
            role_counts[table] += 1

    record_seed(
        conn,
        "pubchem-catalogue",
        digest,
        compound_count,
        {
            "retrieved_on": retrieved_on,
            "rdkit_version": RDKIT_VERSION,
            "compounds": compound_count,
            "solvents": role_counts["solvents"],
            "catalysts": role_counts["catalysts"],
            "skipped": skipped,
        },
    )
    return {
        "seed": "pubchem-catalogue",
        "status": "applied",
        "compounds": compound_count,
        "solvents": role_counts["solvents"],
        "catalysts": role_counts["catalysts"],
        "skipped": skipped,
        **{f"compounds_{k}": v for k, v in outcomes.items()},
    }
