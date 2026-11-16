"""Fetch the PubChem snapshot that seeds the starter compound catalogue, solvents and catalysts.

    python -m matterlab_science.seeding.pubchem_fetch [--seed-dir seed/pubchem] [--rate 3]

Input   seed/pubchem/names.json     names only (typed by hand, no numbers)
Output  seed/pubchem/snapshot.json  every identifier and value exactly as PubChem returned it,
                                    with the request URLs, the retrieval time and attribution

How PubChem is used (PUG REST, https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest):
  1. each name is resolved to CIDs with one request      /compound/name/<name>/cids/JSON
  2. properties are fetched for all CIDs in batches      /compound/cid/property/<list>/JSON  (POST)
  3. synonyms are fetched in batches                     /compound/cid/synonyms/JSON         (POST)
Requests are sequential and spaced so that the rate stays at or below --rate requests per second
(default 3; PubChem asks for no more than 5). Only the standard library is used, so the script
runs anywhere.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
USER_AGENT = "matterlab-science/0.1 (starter-catalogue seed; sequential PUG REST client)"

# Property names as accepted by PUG REST. "SMILES" is the full (stereo and isotope aware) SMILES.
PROPERTIES = [
    "Title",
    "IUPACName",
    "MolecularFormula",
    "MolecularWeight",
    "SMILES",
    "ConnectivitySMILES",
    "InChI",
    "InChIKey",
    "ExactMass",
    "MonoisotopicMass",
    "Charge",
]

PROPERTY_BATCH = 100
SYNONYM_BATCH = 25
MAX_SYNONYMS_KEPT = 12
MAX_ATTEMPTS = 5


class RateLimiter:
    """Spaces calls so that at most `per_second` requests start in any one second."""

    def __init__(self, per_second: float) -> None:
        self.interval = 1.0 / per_second
        self._next = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        if now < self._next:
            time.sleep(self._next - now)
        self._next = max(now, self._next) + self.interval


class PubChemClient:
    def __init__(self, base_url: str, rate: float, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.limiter = RateLimiter(rate)
        self.timeout = timeout
        self.request_count = 0

    def call(self, path: str, form: dict[str, str] | None = None) -> tuple[int, Any, str]:
        """Returns (http status, parsed JSON body or None, url). 404 is a normal answer, not an error."""
        url = f"{self.base_url}{path}"
        data = urllib.parse.urlencode(form).encode("ascii") if form is not None else None
        last_error = "no attempt made"
        for attempt in range(1, MAX_ATTEMPTS + 1):
            self.limiter.wait()
            self.request_count += 1
            request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.status, json.loads(response.read().decode("utf-8")), url
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                if exc.code in (400, 404):
                    try:
                        return exc.code, json.loads(body), url
                    except json.JSONDecodeError:
                        return exc.code, {"raw": body[:500]}, url
                last_error = f"HTTP {exc.code}: {body[:200]}"
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            # Busy server or transient network problem: back off before trying again.
            time.sleep(min(2.0**attempt, 30.0))
        raise RuntimeError(f"PubChem request failed after {MAX_ATTEMPTS} attempts: {url} ({last_error})")


def chunks(items: list[int], size: int) -> list[list[int]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def fetch(seed_dir: Path, rate: float, base_url: str) -> dict[str, Any]:
    names_doc = json.loads((seed_dir / "names.json").read_text(encoding="utf-8"))
    lists = {key: list(names_doc[key]) for key in ("compounds", "solvents", "catalysts")}
    all_names: list[str] = []
    for key in ("compounds", "solvents", "catalysts"):
        for name in lists[key]:
            if name not in all_names:
                all_names.append(name)

    client = PubChemClient(base_url, rate)
    started = datetime.now(timezone.utc)

    resolution: list[dict[str, Any]] = []
    chosen: dict[str, int] = {}
    for index, name in enumerate(all_names, start=1):
        status, body, url = client.call(f"/compound/name/{urllib.parse.quote(name, safe='')}/cids/JSON")
        entry: dict[str, Any] = {"name": name, "url": url, "http_status": status}
        cids = (body or {}).get("IdentifierList", {}).get("CID", []) if status == 200 else []
        if cids:
            entry["cids"] = cids
            # PubChem lists the best match for a name first; that record is used.
            entry["chosen_cid"] = cids[0]
            chosen[name] = cids[0]
        else:
            entry["cids"] = []
            entry["chosen_cid"] = None
            entry["fault"] = (body or {}).get("Fault", body)
        resolution.append(entry)
        if index % 25 == 0 or index == len(all_names):
            print(f"  resolved {index}/{len(all_names)} names ({len(chosen)} found)", flush=True)

    cids = sorted(set(chosen.values()))
    records: dict[str, dict[str, Any]] = {}
    property_path = f"/compound/cid/property/{','.join(PROPERTIES)}/JSON"
    for batch in chunks(cids, PROPERTY_BATCH):
        status, body, url = client.call(property_path, {"cid": ",".join(map(str, batch))})
        if status != 200:
            raise RuntimeError(f"property request failed with HTTP {status}: {body}")
        for row in body["PropertyTable"]["Properties"]:
            records[str(row["CID"])] = {"properties": row, "record_url": f"https://pubchem.ncbi.nlm.nih.gov/compound/{row['CID']}"}
    print(f"  fetched properties for {len(records)}/{len(cids)} CIDs", flush=True)

    for batch in chunks(cids, SYNONYM_BATCH):
        status, body, url = client.call("/compound/cid/synonyms/JSON", {"cid": ",".join(map(str, batch))})
        if status != 200:
            raise RuntimeError(f"synonym request failed with HTTP {status}: {body}")
        for info in body["InformationList"]["Information"]:
            record = records.get(str(info["CID"]))
            if record is None:
                continue
            synonyms = info.get("Synonym", [])
            record["synonyms"] = synonyms[:MAX_SYNONYMS_KEPT]
            record["synonym_count_at_source"] = len(synonyms)
    print(f"  fetched synonyms for {sum('synonyms' in r for r in records.values())}/{len(cids)} CIDs", flush=True)

    finished = datetime.now(timezone.utc)
    return {
        "format": "matterlab-pubchem-snapshot/1",
        "source": {
            "key": "pubchem-compound",
            "title": "PubChem Compound (PUG REST)",
            "publisher": "National Center for Biotechnology Information, U.S. National Library of Medicine",
            "url": "https://pubchem.ncbi.nlm.nih.gov/",
            "service_url": base_url,
            "documentation_url": "https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest",
            "license": "U.S. Government work; see NCBI data usage policies",
            "license_url": "https://www.ncbi.nlm.nih.gov/home/about/policies/",
            "attribution": "Data retrieved from PubChem, National Center for Biotechnology Information (NCBI), U.S. National Library of Medicine.",
        },
        "retrieved_on": started.date().isoformat(),
        "retrieval_started_at": started.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "retrieval_finished_at": finished.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "request_policy": {
            "max_requests_per_second": rate,
            "requests_made": client.request_count,
            "user_agent": USER_AGENT,
            "property_batch_size": PROPERTY_BATCH,
            "synonym_batch_size": SYNONYM_BATCH,
        },
        "properties_requested": PROPERTIES,
        "synonyms_kept_per_record": MAX_SYNONYMS_KEPT,
        "notes": [
            "Names come from names.json. Each name was resolved with PUG REST; when PubChem returned several CIDs the first one (PubChem's best match) was chosen and all returned CIDs are listed under name_resolution.",
            "Values under records[cid].properties are verbatim PubChem output. MolecularWeight, ExactMass and MonoisotopicMass are values computed by PubChem and are transmitted as strings.",
            "Only the first synonyms listed by PubChem are kept per record; synonym_count_at_source gives the full count.",
        ],
        "lists": lists,
        "name_resolution": resolution,
        "records": records,
    }


def main(argv: list[str] | None = None) -> int:
    default_dir = Path(__file__).resolve().parents[2] / "seed" / "pubchem"
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed-dir", type=Path, default=default_dir, help="directory holding names.json; snapshot.json is written there")
    parser.add_argument("--rate", type=float, default=3.0, help="maximum requests per second (must not exceed 5)")
    parser.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args(argv)
    if not 0 < args.rate <= 5:
        parser.error("--rate must be in (0, 5]: PubChem allows at most 5 requests per second")

    snapshot = fetch(args.seed_dir, args.rate, args.base_url)
    out = args.seed_dir / "snapshot.json"
    out.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    unresolved = [entry["name"] for entry in snapshot["name_resolution"] if entry["chosen_cid"] is None]
    print(f"wrote {out}: {len(snapshot['records'])} records from {snapshot['request_policy']['requests_made']} requests")
    if unresolved:
        print(f"names PubChem did not resolve ({len(unresolved)}): {', '.join(unresolved)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
