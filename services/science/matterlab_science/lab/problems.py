"""RFC 9457 errors for the additive lab API; legacy /v1 error contracts stay unchanged."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ProblemDetails(BaseModel):
    type: str
    title: str
    status: int
    detail: str
    instance: str
    code: str
    traceId: str
    details: dict[str, Any] | list[Any] | None = None


class LabProblem(Exception):
    def __init__(self, status: int, code: str, detail: str, details: Any = None) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.details = details


def is_lab(request: Request) -> bool:
    return request.url.path == "/api/v1/lab" or request.url.path.startswith("/api/v1/lab/")


def problem_response(request: Request, status: int, code: str, detail: str, details: Any = None) -> JSONResponse:
    trace_id = getattr(request.state, "trace_id", str(uuid4()))
    return JSONResponse(
        status_code=status,
        content={
            "type": f"urn:matterlab:problem:{code.lower().replace('_', '-')}",
            "title": code.replace("_", " ").capitalize(),
            "status": status,
            "detail": detail,
            "instance": request.url.path,
            "code": code,
            "traceId": trace_id,
            "details": details,
        },
        media_type="application/problem+json",
        headers={"X-Request-ID": trace_id, "Cache-Control": "no-store", **({"WWW-Authenticate": "Bearer"} if status == 401 else {})},
    )
