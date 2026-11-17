"""Evidence labelling and provenance records for the titration engine.

This package labels every result with the evidence vocabulary defined by
`00_SHARED_INTEGRATION_CONTRACT.md` section 3 (binding for all ten agents of the MATTER LAB
Astra expansion):

    REFERENCE_MEASURED | MODEL_CALCULATED | ILLUSTRATIVE | UNVERIFIED | UNSUPPORTED

This is a different (coarser, uppercase) vocabulary from the one the rest of the existing science
service already uses (`matterlab_science.provenance.EvidenceLevel`: `reference`, `computed`,
`rule-based`, `illustrative`, `user-input`, `unsupported`, documented in `docs/architecture.md`).
The two are not interchangeable: this package's outputs are consumed by the new Astra lab/runs
pipeline (Agent 07's reducer, Agent 09's API, Agent 10's QA harness), which is specified against
the shared contract's enum. `evidence_from_legacy`/`evidence_to_legacy` below give an explicit,
documented mapping for anything that must cross between the two, so Agent 10 can reconcile the
vocabularies without guessing. Flagged for the human orchestrator: the two should probably be
unified in one place before the Astra expansion ships.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

EvidenceLevel = Literal["REFERENCE_MEASURED", "MODEL_CALCULATED", "ILLUSTRATIVE", "UNVERIFIED", "UNSUPPORTED"]

EVIDENCE_LEVELS: tuple[EvidenceLevel, ...] = ("REFERENCE_MEASURED", "MODEL_CALCULATED", "ILLUSTRATIVE", "UNVERIFIED", "UNSUPPORTED")

#: Rank used to combine evidence labels (e.g. the weakest evidence among several reference values
#: used in one calculation): higher is weaker evidence.
_RANK: dict[EvidenceLevel, int] = {
    "REFERENCE_MEASURED": 0,
    "MODEL_CALCULATED": 1,
    "ILLUSTRATIVE": 2,
    "UNVERIFIED": 3,
    "UNSUPPORTED": 4,
}


def weakest(levels: list[EvidenceLevel]) -> EvidenceLevel:
    """The weakest (least certain) evidence level among several; `MODEL_CALCULATED` for an empty list."""
    if not levels:
        return "MODEL_CALCULATED"
    return max(levels, key=lambda level: _RANK[level])


# Mapping to/from the legacy lowercase vocabulary of `matterlab_science.provenance.EvidenceLevel`,
# for any code that must bridge the two (e.g. a future shared explanation panel).
_TO_LEGACY: dict[EvidenceLevel, str] = {
    "REFERENCE_MEASURED": "reference",
    "MODEL_CALCULATED": "computed",
    "ILLUSTRATIVE": "illustrative",
    "UNVERIFIED": "rule-based",
    "UNSUPPORTED": "unsupported",
}
_FROM_LEGACY: dict[str, EvidenceLevel] = {v: k for k, v in _TO_LEGACY.items()}
_FROM_LEGACY["user-input"] = "UNVERIFIED"


def evidence_to_legacy(level: EvidenceLevel) -> str:
    return _TO_LEGACY[level]


def evidence_from_legacy(level: str) -> EvidenceLevel:
    try:
        return _FROM_LEGACY[level]
    except KeyError as exc:
        raise ValueError(f"Unknown legacy evidence level {level!r}.") from exc


@dataclass(frozen=True)
class Citation:
    title: str
    authors: str | None = None
    source: str | None = None
    year: int | None = None
    doi: str | None = None
    url: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "title": self.title,
            "authors": self.authors,
            "source": self.source,
            "year": self.year,
            "doi": self.doi,
            "url": self.url,
        }


@dataclass(frozen=True)
class Provenance:
    """Where a value or model parameter came from."""

    source: str
    """Human-readable name of the dataset, evaluation or derivation."""

    evidence: EvidenceLevel
    citations: tuple[Citation, ...] = ()
    retrieved: str | None = None
    """ISO date the source was consulted, when applicable (reference lookups only)."""

    notes: str | None = None
    """Conventions, assumptions or derivation steps a reader needs to use the value correctly."""

    def as_dict(self) -> dict[str, object]:
        return {
            "source": self.source,
            "evidence": self.evidence,
            "citations": [c.as_dict() for c in self.citations],
            "retrieved": self.retrieved,
            "notes": self.notes,
        }


#: Provenance of a number produced purely by this package's own derivation/numerics (e.g. a
#: root-finder's convergence figures), as opposed to a value read from a cited external source.
def derived_provenance(notes: str) -> Provenance:
    return Provenance(source="MATTER LAB titration engine (derived)", evidence="MODEL_CALCULATED", notes=notes)
