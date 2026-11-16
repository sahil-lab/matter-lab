"""External catalogue lookups. Every call is explicit, rate limited and fully recorded by the caller."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from . import __version__

PUBCHEM_CATALOG_KEY = "pubchem-compound"
PUBCHEM_CATALOG_TITLE = "PubChem Compound (PUG REST lookup by InChIKey)"
_USER_AGENT = f"matterlab-science/{__version__} (discovery candidate lookup)"

# PubChem asks for no more than 5 requests per second; this process stays at 4.
_MIN_INTERVAL_SECONDS = 0.25
_lock = threading.Lock()
_last_request = 0.0


def lookup_pubchem_inchikey(base_url: str, inchikey: str, timeout_seconds: float) -> dict[str, Any]:
    """Asks PubChem whether it has a compound with this InChIKey.

    Returns a record of the lookup: `outcome` is `match`, `no-match` (PubChem answered and has no
    such compound) or `error` (no answer could be obtained, which is not a negative result).
    """
    global _last_request
    url = f"{base_url.rstrip('/')}/compound/inchikey/{urllib.parse.quote(inchikey, safe='')}/cids/JSON"
    record: dict[str, Any] = {"request_url": url, "http_status": None, "matches": [], "detail": None}
    with _lock:
        wait = _MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        record["searched_at"] = datetime.now(timezone.utc)
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                record["http_status"] = response.status
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            record["http_status"] = exc.code
            try:
                fault = json.loads(exc.read().decode("utf-8", errors="replace")).get("Fault", {})
            except Exception:
                fault = {}
            if exc.code == 404 and fault.get("Code") == "PUGREST.NotFound":
                record["outcome"] = "no-match"
                record["detail"] = "PubChem answered that it has no compound with this InChIKey. PubChem does not report how many records it searched."
            else:
                record["outcome"] = "error"
                record["detail"] = f"PubChem answered with HTTP {exc.code}" + (f" ({fault.get('Code')}: {fault.get('Message')})" if fault else "") + "; the lookup is inconclusive."
            return record
        except Exception as exc:  # network failure, timeout, unreadable answer
            record["outcome"] = "error"
            record["detail"] = f"PubChem could not be reached ({type(exc).__name__}: {exc}); the lookup is inconclusive."
            return record

    cids = body.get("IdentifierList", {}).get("CID", []) if isinstance(body, dict) else []
    if not cids:
        record["outcome"] = "error"
        record["detail"] = "PubChem returned an answer without compound identifiers; the lookup is inconclusive."
        return record
    record["outcome"] = "match"
    record["matches"] = [
        {"catalog": PUBCHEM_CATALOG_KEY, "external_id": f"CID {cid}", "pubchem_cid": int(cid), "inchikey": inchikey, "url": f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"}
        for cid in cids
    ]
    record["detail"] = f"PubChem lists {len(cids)} compound record(s) with this InChIKey. PubChem does not report how many records it searched."
    return record
