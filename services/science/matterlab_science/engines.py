"""Engine registry: which scientific engines this service instance can actually run.

RDKit is required and is checked in-process. The optional engines (tblite/xTB and PySCF) are
probed in child processes at start-up (see engine_probe.py); an engine is reported as available
only if it imports and completes a small real calculation.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from importlib import metadata
from typing import Any

from .config import Settings

log = logging.getLogger("matterlab.engines")

_PROBE_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class Engine:
    id: str
    name: str
    description: str
    available: bool
    version: str | None
    unavailable_reason: str | None
    components: dict[str, str]
    capabilities: tuple[str, ...]
    license: str | None
    url: str | None
    self_test: dict[str, Any] | None
    detected_at: float = field(default_factory=time.time)

    def software(self) -> dict[str, str]:
        return dict(self.components)


def _rdkit_engine() -> Engine:
    from rdkit import Chem, rdBase
    from rdkit.Chem import inchi, rdDistGeom, rdForceFieldHelpers

    started = time.monotonic()
    detail = None
    try:
        mol = Chem.AddHs(Chem.MolFromSmiles("CCO"))
        params = rdDistGeom.ETKDGv3()
        params.randomSeed = 1
        embedded = rdDistGeom.EmbedMolecule(mol, params) == 0
        converged = embedded and rdForceFieldHelpers.MMFFOptimizeMolecule(mol, maxIters=500) == 0
        passed = bool(embedded and converged and Chem.MolFromSmiles("c1ccccc1") is not None)
        if not passed:
            detail = "the RDKit test calculation did not complete as expected"
    except Exception as exc:  # pragma: no cover - would mean a broken RDKit build
        passed, detail = False, f"{type(exc).__name__}: {exc}"
    try:
        license_text = metadata.metadata("rdkit").get("License")
    except metadata.PackageNotFoundError:
        license_text = None
    components = {"rdkit": rdBase.rdkitVersion, "boost": rdBase.boostVersion.replace("_", ".")}
    if inchi.INCHI_AVAILABLE:
        components["inchi"] = inchi.GetInchiVersion()
    return Engine(
        id="rdkit",
        name="RDKit",
        description="Cheminformatics toolkit: structure perception, identifiers, descriptors, fingerprints, ETKDG embedding, MMFF94 and UFF force fields.",
        available=passed,
        version=rdBase.rdkitVersion,
        unavailable_reason=None if passed else f"RDKit self-test failed: {detail}",
        components=components,
        capabilities=(
            "structure-validation",
            "identifiers",
            "descriptors",
            "fingerprints",
            "substructure-search",
            "similarity-search",
            "3d-embedding-etkdg",
            "force-field-mmff94",
            "force-field-uff",
            "conformer-search",
        ),
        license=license_text if license_text and len(license_text) < 80 else None,
        url="https://www.rdkit.org",
        self_test={
            "description": "Parse benzene, embed ethanol with ETKDGv3 and minimise it with MMFF94 to convergence",
            "passed": passed,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "detail": detail,
        },
    )


_OPTIONAL = {
    "xtb": {
        "name": "xTB (tblite)",
        "description": "Semi-empirical extended tight binding (GFN1-xTB, GFN2-xTB) through the tblite library; geometry optimisation uses ASE's LBFGS optimiser.",
        "capabilities": ("gfn2-xtb-single-point", "gfn1-xtb-single-point"),
    },
    "pyscf": {
        "name": "PySCF",
        "description": "Ab initio Hartree-Fock and Kohn-Sham DFT single-point SCF calculations with Gaussian basis sets.",
        "capabilities": ("hartree-fock-scf", "kohn-sham-dft-scf"),
    },
}


def _probe(engine_id: str, threads: int) -> dict[str, Any]:
    env = dict(os.environ)
    env.update(OMP_NUM_THREADS=str(threads), OPENBLAS_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads), PYTHONUNBUFFERED="1")
    try:
        done = subprocess.run(
            [sys.executable, "-m", "matterlab_science.engine_probe", engine_id],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": f"the engine probe did not finish within {_PROBE_TIMEOUT_SECONDS} s"}
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    if done.returncode != 0 or not lines:
        tail = (done.stderr or "").strip().splitlines()[-3:]
        return {"available": False, "reason": f"the engine probe exited with code {done.returncode}: {' | '.join(tail) or 'no output'}"}
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return {"available": False, "reason": "the engine probe produced unreadable output"}


def _optional_engine(engine_id: str, settings: Settings) -> Engine:
    spec = _OPTIONAL[engine_id]
    if engine_id in settings.disabled_engines:
        report: dict[str, Any] = {"available": False, "reason": "Disabled by configuration (MATTERLAB_DISABLED_ENGINES)."}
    else:
        report = _probe(engine_id, threads=1)
    capabilities = list(spec["capabilities"])
    components = dict(report.get("components") or {})
    if engine_id == "xtb" and report.get("available") and "ase" in components:
        capabilities.append("gfn-xtb-geometry-optimization")
    return Engine(
        id=engine_id,
        name=spec["name"],
        description=spec["description"],
        available=bool(report.get("available")),
        version=report.get("version") if report.get("available") else None,
        unavailable_reason=None if report.get("available") else str(report.get("reason") or "unavailable"),
        components=components if report.get("available") else {},
        capabilities=tuple(capabilities) if report.get("available") else (),
        license=report.get("license"),
        url=report.get("url"),
        self_test=report.get("self_test"),
    )


class EngineRegistry:
    def __init__(self, engines: list[Engine]) -> None:
        self._engines = {engine.id: engine for engine in engines}

    @classmethod
    def detect(cls, settings: Settings) -> "EngineRegistry":
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=len(_OPTIONAL)) as pool:
            futures = {engine_id: pool.submit(_optional_engine, engine_id, settings) for engine_id in _OPTIONAL}
            rdkit_engine = _rdkit_engine()
            optional = [futures[engine_id].result() for engine_id in _OPTIONAL]
        registry = cls([rdkit_engine, *optional])
        for engine in registry.all():
            if engine.available:
                log.info("engine %s %s available", engine.id, engine.version)
            else:
                log.warning("engine %s unavailable: %s", engine.id, engine.unavailable_reason)
        log.info("engine detection took %.1f s", time.monotonic() - started)
        return registry

    def all(self) -> list[Engine]:
        return list(self._engines.values())

    def get(self, engine_id: str) -> Engine | None:
        return self._engines.get(engine_id)

    def versions(self) -> dict[str, str]:
        return {engine.id: engine.version for engine in self._engines.values() if engine.available and engine.version}
