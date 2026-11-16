"""One error shape for every failure: {"error": {"code", "message", "details"}}."""

from __future__ import annotations

import logging
from typing import Any

import psycopg
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from .db import DatabaseUnavailable

log = logging.getLogger("matterlab.api")


class ErrorBody(BaseModel):
    code: str = Field(description="Stable machine-readable error code, e.g. `invalid_structure` or `not_found`.")
    message: str = Field(description="Human-readable explanation.")
    details: Any | None = Field(default=None, description="Structured context for the error; shape depends on `code`.")


class ErrorResponse(BaseModel):
    """Body of every non-2xx response."""

    error: ErrorBody


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def not_found(what: str, identifier: Any) -> ApiError:
    return ApiError(404, "not_found", f"{what} {identifier} does not exist.", {"resource": what, "id": str(identifier)})


def error_payload(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": jsonable_encoder(details)}}


# Reusable OpenAPI declarations so that the documented error responses match what is sent.
def error_responses(*status_codes: int) -> dict[int | str, dict[str, Any]]:
    descriptions = {
        400: "Bad request",
        404: "Resource not found",
        409: "Conflict with the current state of the resource",
        413: "Payload too large",
        422: "Request validation failed, or the structure could not be interpreted",
        502: "An external service could not be reached",
        503: "PostgreSQL cannot be reached (code `database_unavailable`) or could not complete the request (code `database_error`)",
    }
    return {code: {"model": ErrorResponse, "description": descriptions.get(code, "Error")} for code in status_codes}


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    406: "not_acceptable",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "too_many_requests",
    500: "internal_error",
    503: "service_unavailable",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=error_payload(exc.code, exc.message, exc.details))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        problems = []
        for err in exc.errors():
            problems.append(
                {
                    "location": [str(part) for part in err.get("loc", ())],
                    "message": err.get("msg", ""),
                    "type": err.get("type", ""),
                }
            )
        summary = "; ".join(f"{'.'.join(p['location'])}: {p['message']}" for p in problems[:5])
        return JSONResponse(
            status_code=422,
            content=error_payload("validation_error", f"Request validation failed: {summary}" if summary else "Request validation failed.", problems),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "http_error")
        message = exc.detail if isinstance(exc.detail, str) else code.replace("_", " ")
        details = None if isinstance(exc.detail, str) else exc.detail
        return JSONResponse(status_code=exc.status_code, content=error_payload(code, message, details), headers=exc.headers)

    async def _database_unavailable(request: Request, exc: Exception) -> JSONResponse:
        # PostgreSQL is unreachable, went away during the request or could not complete it
        # (deadlock, cancelled statement): say so, instead of a generic 500.
        reason = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
        sqlstate = getattr(exc, "sqlstate", None)
        unreachable = sqlstate is None or sqlstate.startswith(("08", "57P")) or sqlstate == "3D000"
        log.error("database %s on %s %s: %s", "unavailable" if unreachable else "error", request.method, request.url.path, reason)
        return JSONResponse(
            status_code=503,
            content=error_payload(
                "database_unavailable" if unreachable else "database_error",
                (
                    "The service cannot reach its PostgreSQL database, so the request was not completed. Try again once the database is back."
                    if unreachable
                    else "PostgreSQL could not complete the request, so it was rolled back. It is safe to try again."
                ),
                {"reason": reason, "sqlstate": sqlstate},
            ),
            headers={"Retry-After": "5"},
        )

    app.add_exception_handler(DatabaseUnavailable, _database_unavailable)
    app.add_exception_handler(psycopg.OperationalError, _database_unavailable)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=error_payload("internal_error", "The service hit an unexpected error. It has been logged.", {"type": type(exc).__name__}),
        )
