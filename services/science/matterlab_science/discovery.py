"""Discovery candidates: validation, catalogue searches, evidence trail and the status ladder.

The ladder is deliberately modest and every transition leaves an evidence record:

  user-created                    entered by a user; nothing has been established
  structurally-validated          RDKit accepts the structure
  no-match-in-searched-catalogs   no identical structure in the catalogues that were searched
  computationally-plausible       a converged calculation for this very structure is attached
  experimentally-observed         a user recorded an observation, with a reference (not verified here)
  independently-validated         a user recorded an independent confirmation, with a reference

No status says that a compound is unknown to science: a catalogue search only speaks for the
catalogues searched, and the response always lists which ones, how many records, and when.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import psycopg

from .catalogue import search
from .catalogue.search import CatalogueIndex
from .chem import fingerprints
from .chem.structure import ParsedStructure, derived_by, identity, parse_structure, standard_mol, validation_report
from .catalogue.records import depiction_molblock
from .db import Jsonb
from .errors import ApiError
from .external import PUBCHEM_CATALOG_KEY, PUBCHEM_CATALOG_TITLE, lookup_pubchem_inchikey

LADDER = (
    "user-created",
    "structurally-validated",
    "no-match-in-searched-catalogs",
    "computationally-plausible",
    "experimentally-observed",
    "independently-validated",
)
RANK = {status: rank for rank, status in enumerate(LADDER)}

STATUS_MEANING = {
    "user-created": "Entered by a user. The structure has not passed validation, and nothing about it has been established.",
    "structurally-validated": "RDKit accepts the structure as chemically well-formed. Nothing more is claimed.",
    "no-match-in-searched-catalogs": (
        "No identical structure was found in the catalogues that were searched; they are listed under searched_catalogs. "
        "Other databases and the literature were not searched."
    ),
    "computationally-plausible": (
        "At least one converged calculation for this structure is attached, and the searched catalogues hold no identical structure. "
        "A calculation is not an observation."
    ),
    "experimentally-observed": "A user has recorded an experimental observation with a reference. The service has not verified it.",
    "independently-validated": "A user has recorded an independent confirmation with a reference. The service has not verified it.",
}

EXACT_LOCAL = "exact-inchikey"
SIMILARITY_LOCAL = "similarity-morgan-tanimoto"
EXACT_PUBCHEM = "external-inchikey-lookup"
IDENTITY_METHODS = (EXACT_LOCAL, EXACT_PUBCHEM)

USER_EVIDENCE_KINDS = ("calculation", "experimental-observation", "independent-validation", "note")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def add_evidence(
    conn: psycopg.Connection[Any],
    discovery_id: UUID,
    *,
    kind: str,
    summary: str,
    recorded_by: str,
    details: dict[str, Any] | None = None,
    calculation_id: UUID | None = None,
    catalog_search_id: UUID | None = None,
    reference: str | None = None,
    status_before: str | None = None,
    status_after: str | None = None,
) -> UUID:
    row = conn.execute(
        """
        INSERT INTO discovery_evidence (discovery_id, kind, summary, details, recorded_by, calculation_id, catalog_search_id,
                                        reference, status_before, status_after, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, clock_timestamp()) RETURNING id
        """,
        (discovery_id, kind, summary, Jsonb(details or {}), recorded_by, calculation_id, catalog_search_id, reference, status_before, status_after),
    ).fetchone()
    assert row is not None
    return row["id"]


def _set_status(conn: psycopg.Connection[Any], discovery_id: UUID, before: str, after: str, summary: str, recorded_by: str, details: dict[str, Any] | None = None) -> None:
    if before == after:
        return
    conn.execute("UPDATE discoveries SET status = %s WHERE id = %s", (after, discovery_id))
    add_evidence(conn, discovery_id, kind="status-change", summary=summary, recorded_by=recorded_by, details=details, status_before=before, status_after=after)


# ---------------------------------------------------------------------------------------------
# Searches
# ---------------------------------------------------------------------------------------------


def perform_searches(
    catalogue: CatalogueIndex,
    parsed: ParsedStructure,
    inchikey: str,
    *,
    similarity_threshold: float,
    similarity_limit: int,
    query_pubchem: bool,
    pubchem_base_url: str,
    pubchem_timeout_seconds: float,
) -> list[dict[str, Any]]:
    """Runs the searches and returns one record per search. Nothing is written here, so no
    database transaction is held open while an external service is being contacted."""
    assert parsed.mol is not None
    records: list[dict[str, Any]] = []

    searched_at = _now()
    exact, related, total = catalogue.exact(inchikey)
    detail = None
    if related:
        names = ", ".join(r["name"] for r in related[:5])
        detail = f"{len(related)} record(s) share the connectivity (first InChIKey block) but are not identical: {names}."
    records.append(
        {
            "catalog_key": search.CATALOG_KEY,
            "catalog_title": search.CATALOG_TITLE,
            "catalog_scope": "local",
            "search_method": EXACT_LOCAL,
            "parameters": {"inchikey": inchikey, "method": search.EXACT_METHOD},
            "records_searched": total,
            "searched_at": searched_at,
            "outcome": "match" if exact else "no-match",
            "matches": [
                {"catalog": search.CATALOG_KEY, "compound_id": str(r["id"]), "name": r["name"], "inchikey": r["inchikey"], "canonical_smiles": r["canonical_smiles"]}
                for r in exact
            ],
            "detail": detail,
            "request_url": None,
            "http_status": None,
        }
    )

    searched_at = _now()
    hits, above, searched = catalogue.similarity(parsed.mol, threshold=similarity_threshold, limit=similarity_limit)
    records.append(
        {
            "catalog_key": search.CATALOG_KEY,
            "catalog_title": search.CATALOG_TITLE,
            "catalog_scope": "local",
            "search_method": SIMILARITY_LOCAL,
            "parameters": {
                "threshold": similarity_threshold,
                "limit": similarity_limit,
                "fingerprint": fingerprints.FINGERPRINT_PARAMS["morgan"],
                "method": search.SIMILARITY_METHOD,
            },
            "records_searched": searched,
            "searched_at": searched_at,
            "outcome": "match" if hits else "no-match",
            "matches": [
                {
                    "catalog": search.CATALOG_KEY,
                    "compound_id": str(entry.id),
                    "name": entry.name,
                    "inchikey": entry.inchikey,
                    "canonical_smiles": entry.canonical_smiles,
                    "similarity": score,
                }
                for entry, score in hits
            ],
            "detail": f"{above} record(s) at or above Tanimoto {similarity_threshold:g}; similarity is a structural heuristic and not an identity match.",
            "request_url": None,
            "http_status": None,
        }
    )

    if query_pubchem:
        lookup = lookup_pubchem_inchikey(pubchem_base_url, inchikey, pubchem_timeout_seconds)
        records.append(
            {
                "catalog_key": PUBCHEM_CATALOG_KEY,
                "catalog_title": PUBCHEM_CATALOG_TITLE,
                "catalog_scope": "external",
                "search_method": EXACT_PUBCHEM,
                "parameters": {"inchikey": inchikey},
                "records_searched": None,
                "searched_at": lookup["searched_at"],
                "outcome": lookup["outcome"],
                "matches": lookup["matches"],
                "detail": lookup["detail"],
                "request_url": lookup["request_url"],
                "http_status": lookup["http_status"],
            }
        )
    return records


def _search_summary(record: dict[str, Any]) -> str:
    when = record["searched_at"].isoformat(timespec="seconds").replace("+00:00", "Z")
    if record["search_method"] == EXACT_LOCAL:
        found = ", ".join(m["name"] for m in record["matches"])
        result = f"an identical structure was found: {found}" if record["matches"] else "no identical structure was found"
        return f"Exact InChIKey search of the local catalogue ({record['records_searched']} records) at {when}: {result}."
    if record["search_method"] == SIMILARITY_LOCAL:
        threshold = record["parameters"]["threshold"]
        if record["matches"]:
            best = record["matches"][0]
            result = f"{len(record['matches'])} similar record(s) returned; the most similar is {best['name']} (Tanimoto {best['similarity']:.3f})"
        else:
            result = "no record at or above the threshold"
        return f"Similarity search of the local catalogue ({record['records_searched']} records, Tanimoto >= {threshold:g}) at {when}: {result}."
    if record["outcome"] == "match":
        ids = ", ".join(m["external_id"] for m in record["matches"])
        result = f"PubChem has a record with this InChIKey ({ids})"
    elif record["outcome"] == "no-match":
        result = "PubChem has no compound with this InChIKey"
    else:
        result = f"the lookup could not be completed and is inconclusive ({record['detail']})"
    return f"External lookup of PubChem by InChIKey at {when}: {result}."


def store_searches(conn: psycopg.Connection[Any], discovery_id: UUID, records: list[dict[str, Any]]) -> None:
    for record in records:
        row = conn.execute(
            """
            INSERT INTO discovery_catalog_searches (discovery_id, catalog_key, catalog_title, catalog_scope, search_method, parameters,
                                                    records_searched, searched_at, outcome, matches, detail, request_url, http_status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                discovery_id,
                record["catalog_key"],
                record["catalog_title"],
                record["catalog_scope"],
                record["search_method"],
                Jsonb(record["parameters"]),
                record["records_searched"],
                record["searched_at"],
                record["outcome"],
                Jsonb(record["matches"]),
                record["detail"],
                record["request_url"],
                record["http_status"],
            ),
        ).fetchone()
        assert row is not None
        add_evidence(
            conn,
            discovery_id,
            kind="external-lookup" if record["catalog_scope"] == "external" else "catalog-search",
            summary=_search_summary(record),
            recorded_by="service",
            catalog_search_id=row["id"],
            details={
                "catalog_key": record["catalog_key"],
                "search_method": record["search_method"],
                "records_searched": record["records_searched"],
                "outcome": record["outcome"],
                "match_count": len(record["matches"]),
            },
        )


def identity_state(conn: psycopg.Connection[Any], discovery_id: UUID) -> tuple[bool, bool, list[str]]:
    """(identical structure found, at least one identity search completed, catalogues with a match),
    judged by the latest completed identity search of each catalogue."""
    rows = conn.execute(
        """
        SELECT DISTINCT ON (catalog_key) catalog_key, catalog_title, outcome
        FROM discovery_catalog_searches
        WHERE discovery_id = %s AND search_method = ANY(%s) AND outcome <> 'error'
        ORDER BY catalog_key, searched_at DESC, created_at DESC
        """,
        (discovery_id, list(IDENTITY_METHODS)),
    ).fetchall()
    matched = [r["catalog_title"] for r in rows if r["outcome"] == "match"]
    return bool(matched), bool(rows), matched


def apply_search_outcome(conn: psycopg.Connection[Any], discovery_id: UUID) -> None:
    """Moves the candidate to the rung its searches support."""
    row = conn.execute("SELECT status, structure_valid FROM discoveries WHERE id = %s FOR UPDATE", (discovery_id,)).fetchone()
    if row is None or not row["structure_valid"]:
        return
    current = row["status"]
    found, completed, where = identity_state(conn, discovery_id)
    if found and RANK[current] > RANK["structurally-validated"]:
        _set_status(
            conn,
            discovery_id,
            current,
            "structurally-validated",
            f"An identical structure was found in: {', '.join(where)}. The candidate is a known compound there, so it returns to 'structurally-validated'.",
            "service",
            {"catalogs_with_match": where},
        )
    elif not found and completed and current == "structurally-validated":
        _set_status(
            conn,
            discovery_id,
            current,
            "no-match-in-searched-catalogs",
            "Every catalogue search that completed found no identical structure. This describes the searched catalogues only.",
            "service",
        )


# ---------------------------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------------------------


def create(
    conn: psycopg.Connection[Any],
    *,
    title: str,
    notes: str | None,
    input_format: str,
    input_structure: str,
    parsed: ParsedStructure,
    search_records: list[dict[str, Any]],
    source_id: int,
) -> UUID:
    report = validation_report(parsed)
    validation = {key: report[key] for key in ("valid", "stage", "sanitization", "errors", "warnings", "engine")}
    if parsed.valid and parsed.mol is not None:
        ident = identity(parsed.mol)
        usable = ident["inchikey"] is not None
        if not usable:
            validation["errors"] = [
                {"type": "InchiError", "message": "; ".join(ident["inchi_messages"]) or "no InChI could be generated", "atom_indices": []}
            ]
    else:
        ident, usable = {}, False

    row = conn.execute(
        """
        INSERT INTO discoveries (title, notes, status, input_format, input_structure, structure_valid, validation, canonical_smiles,
                                 inchi, inchikey, molecular_formula, molblock, molecular_weight_g_per_mol, monoisotopic_mass_u,
                                 derived_by, source_id)
        VALUES (%s, %s, 'user-created', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
        (
            title,
            notes,
            input_format,
            input_structure,
            usable,
            Jsonb(validation),
            ident.get("canonical_smiles") if usable else None,
            ident.get("inchi") if usable else None,
            ident.get("inchikey") if usable else None,
            ident.get("molecular_formula") if usable else None,
            depiction_molblock(standard_mol(parsed.mol)) if usable and parsed.mol is not None else None,
            ident.get("molecular_weight_g_per_mol") if usable else None,
            ident.get("monoisotopic_mass_u") if usable else None,
            Jsonb(derived_by()) if usable else None,
            source_id,
        ),
    ).fetchone()
    assert row is not None
    discovery_id = row["id"]
    add_evidence(conn, discovery_id, kind="note", summary="Candidate created from a user-supplied structure.", recorded_by="user", status_after="user-created")

    if not usable:
        problems = "; ".join(e["message"] for e in validation["errors"]) or "the structure could not be interpreted"
        add_evidence(
            conn,
            discovery_id,
            kind="structure-validation",
            summary=f"RDKit did not accept the structure: {problems}. No catalogue was searched.",
            recorded_by="service",
            details={"errors": validation["errors"], "engine": validation["engine"]},
        )
        return discovery_id

    add_evidence(
        conn,
        discovery_id,
        kind="structure-validation",
        summary=f"RDKit accepted the structure: {ident['canonical_smiles']} ({ident['molecular_formula']}), InChIKey {ident['inchikey']}.",
        recorded_by="service",
        details={"warnings": validation["warnings"], "engine": validation["engine"]},
    )
    _set_status(conn, discovery_id, "user-created", "structurally-validated", "The structure passed RDKit sanitisation.", "service")
    store_searches(conn, discovery_id, search_records)
    apply_search_outcome(conn, discovery_id)
    return discovery_id


# ---------------------------------------------------------------------------------------------
# Evidence and status requested by users
# ---------------------------------------------------------------------------------------------


def calculation_evidence(conn: psycopg.Connection[Any], discovery: dict[str, Any], calculation_id: UUID) -> tuple[str, dict[str, Any]]:
    """Summary and details for attaching a job as evidence, including whether the job was run on
    the candidate's own structure."""
    job = conn.execute(
        "SELECT id, kind, status, method, converged, input, input_hash, engine, engine_version FROM calculations WHERE id = %s",
        (calculation_id,),
    ).fetchone()
    if job is None:
        raise ApiError(422, "unknown_reference", f"There is no job with id {calculation_id}.", {"field": "calculation_id", "id": str(calculation_id)})
    structure = (job["input"] or {}).get("structure") or {}
    matches: bool | None = None
    job_inchikey = None
    if structure.get("format") in ("smiles", "molblock") and structure.get("data"):
        parsed = parse_structure(structure["format"], structure["data"])
        if parsed.valid and parsed.mol is not None:
            job_inchikey = identity(parsed.mol)["inchikey"]
            matches = job_inchikey is not None and job_inchikey == discovery["inchikey"]
    relation = {True: "on the candidate's structure", False: "on a different structure", None: "on a geometry without bonding information, so the structure could not be compared"}[matches]
    converged = {True: "converged", False: "not converged", None: "no convergence reported"}[job["converged"]]
    summary = (
        f"Calculation {job['kind']} ({job['method'] or 'method not reported'}; engine {job['engine']} {job['engine_version'] or 'n/a'}) "
        f"attached: status {job['status']}, {converged}, run {relation}."
    )
    details = {
        "calculation_id": str(job["id"]),
        "kind": job["kind"],
        "status": job["status"],
        "method": job["method"],
        "converged": job["converged"],
        "input_hash": job["input_hash"],
        "engine": job["engine"],
        "engine_version": job["engine_version"],
        "calculation_inchikey": job_inchikey,
        "structure_matches_candidate": matches,
        "counts_towards_computationally_plausible": bool(job["status"] == "succeeded" and job["converged"] is True and matches is True),
    }
    return summary, details


def change_status(conn: psycopg.Connection[Any], discovery_id: UUID, target: str, justification: str) -> None:
    row = conn.execute("SELECT status, structure_valid FROM discoveries WHERE id = %s FOR UPDATE", (discovery_id,)).fetchone()
    assert row is not None
    current = row["status"]
    if target == current:
        return
    found, completed, where = identity_state(conn, discovery_id)
    base = "user-created" if not row["structure_valid"] else ("structurally-validated" if found or not completed else "no-match-in-searched-catalogs")

    def refuse(message: str, **details: Any) -> ApiError:
        return ApiError(409, "status_transition_not_allowed", message, {"current_status": current, "requested_status": target, **details})

    if RANK[target] < RANK[current]:
        if RANK[target] < RANK[base]:
            raise refuse(f"The status cannot go below '{base}', which is what validation and the catalogue searches established.", lowest_allowed=base)
        _set_status(conn, discovery_id, current, target, f"Status lowered at the user's request: {justification}", "user")
        return

    if RANK[target] != RANK[current] + 1:
        raise refuse(f"The ladder is climbed one rung at a time; the next rung after '{current}' is '{LADDER[RANK[current] + 1]}'.", next_status=LADDER[RANK[current] + 1])
    if target in ("structurally-validated", "no-match-in-searched-catalogs"):
        raise refuse(f"'{target}' is established by the service (validation and catalogue searches), not by request. Run the searches again instead.")

    evidence = conn.execute("SELECT kind, details FROM discovery_evidence WHERE discovery_id = %s", (discovery_id,)).fetchall()
    if target == "computationally-plausible":
        if found:
            raise refuse(f"An identical structure exists in: {', '.join(where)}.")
        if not any(e["kind"] == "calculation" and e["details"].get("counts_towards_computationally_plausible") for e in evidence):
            raise refuse(
                "This rung needs an attached calculation that succeeded, converged, and was run on the candidate's own structure.",
                required_evidence="calculation",
            )
    elif target == "experimentally-observed":
        if not any(e["kind"] == "experimental-observation" for e in evidence):
            raise refuse("This rung needs an attached 'experimental-observation' evidence record with a reference.", required_evidence="experimental-observation")
    elif target == "independently-validated":
        if not any(e["kind"] == "independent-validation" for e in evidence):
            raise refuse("This rung needs an attached 'independent-validation' evidence record with a reference.", required_evidence="independent-validation")
    _set_status(conn, discovery_id, current, target, f"Status raised at the user's request: {justification}", "user")


# ---------------------------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------------------------


def statement(discovery: dict[str, Any], searched: list[dict[str, Any]], found: bool, where: list[str]) -> str:
    """The plain-language reading of the candidate's state. It never claims more than the searches support."""
    if not discovery["structure_valid"]:
        return "RDKit could not validate this structure, so no catalogue was searched and nothing has been established about it."
    completed = [s for s in searched if s["identity_search_completed"]]
    if found:
        return f"An identical structure (same InChIKey) is listed in: {', '.join(where)}. In those catalogues this is a known compound."
    if not completed:
        return "The structure is valid, but no identity search of any catalogue has completed yet, so nothing can be said about whether it is listed anywhere."
    parts = []
    for s in completed:
        count = f"{s['records_searched']} records" if s["records_searched"] is not None else "record count not reported by the service"
        parts.append(f"{s['catalog_title']} ({count}, last searched {s['last_searched_at'].isoformat(timespec='seconds').replace('+00:00', 'Z')})")
    return (
        f"No identical structure was found in the searched catalogues: {'; '.join(parts)}. "
        "This describes only those catalogues at those times. It does not show that the compound is absent from other databases or from the literature."
    )


def searched_catalogs(searches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for s in sorted(searches, key=lambda item: item["searched_at"]):
        entry = grouped.setdefault(
            s["catalog_key"],
            {
                "catalog_key": s["catalog_key"],
                "catalog_title": s["catalog_title"],
                "catalog_scope": s["catalog_scope"],
                "records_searched": None,
                "first_searched_at": s["searched_at"],
                "last_searched_at": s["searched_at"],
                "search_count": 0,
                "methods": [],
                "identity_search_completed": False,
                "identical_structure_found": False,
                "last_identity_outcome": None,
            },
        )
        entry["search_count"] += 1
        entry["last_searched_at"] = s["searched_at"]
        if s["search_method"] not in entry["methods"]:
            entry["methods"].append(s["search_method"])
        if s["outcome"] != "error":
            entry["records_searched"] = s["records_searched"]
        if s["search_method"] in IDENTITY_METHODS:
            entry["last_identity_outcome"] = s["outcome"]
            if s["outcome"] != "error":
                entry["identity_search_completed"] = True
                entry["identical_structure_found"] = s["outcome"] == "match"
    return list(grouped.values())
