"""Opaque bearer credentials are configured as hashes, never accepted as client-selected owners."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .problems import LabProblem

SCOPES = frozenset({"lab:read", "lab:write", "lab:run", "lab:export"})
bearer = HTTPBearer(auto_error=False, scheme_name="LabBearer", description="A configured bearer principal; tokens are not saved by the browser.")


@dataclass(frozen=True)
class Principal:
    owner_id: UUID
    scopes: frozenset[str]


def configured_principals(raw: str) -> tuple[tuple[str, Principal], ...]:
    try:
        records = json.loads(raw)
        if not isinstance(records, list) or len(records) > 1000:
            raise ValueError("expected a bounded array")
        principals = []
        for record in records:
            if not isinstance(record, dict) or set(record) != {"sha256", "ownerId", "scopes"}:
                raise ValueError("expected sha256, ownerId and scopes")
            digest = record["sha256"]
            scopes = record["scopes"]
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("invalid token hash")
            if not isinstance(scopes, list) or any(not isinstance(scope, str) or scope not in SCOPES for scope in scopes):
                raise ValueError("invalid scope")
            principal = Principal(UUID(record["ownerId"]), frozenset(scopes))
            if any(existing == digest for existing, _ in principals):
                raise ValueError("duplicate token hash")
            principals.append((digest, principal))
        return tuple(principals)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise LabProblem(503, "AUTH_CONFIGURATION_ERROR", "Laboratory authentication configuration is invalid; contact the administrator.") from exc


def authenticate(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> Principal:
    principals = configured_principals(request.app.state.ctx.settings.lab_auth_tokens_json)
    if not principals:
        raise LabProblem(503, "AUTH_NOT_CONFIGURED", "Laboratory access is disabled until an administrator configures bearer principals.")
    if credentials is None or credentials.scheme.lower() != "bearer" or len(credentials.credentials) > 4096:
        raise LabProblem(401, "AUTH_REQUIRED", "A laboratory bearer credential is required.")
    digest = hashlib.sha256(credentials.credentials.encode("utf-8")).hexdigest()
    for expected, principal in principals:
        if hmac.compare_digest(digest, expected):
            return principal
    raise LabProblem(401, "AUTH_INVALID", "The laboratory bearer credential is not valid.")


def require_scope(scope: str):
    def check(principal: Annotated[Principal, Depends(authenticate)]) -> Principal:
        if scope not in principal.scopes:
            raise LabProblem(403, "SCOPE_REQUIRED", f"The {scope} scope is required.")
        return principal

    return check


Reader = Annotated[Principal, Depends(require_scope("lab:read"))]
Writer = Annotated[Principal, Depends(require_scope("lab:write"))]
Runner = Annotated[Principal, Depends(require_scope("lab:run"))]
Exporter = Annotated[Principal, Depends(require_scope("lab:export"))]
