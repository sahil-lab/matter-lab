"""Bound request bytes before JSON decoding and never cache authenticated lab responses."""

from __future__ import annotations

from uuid import uuid4

from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .problems import LabProblem, problem_response
from .validation import decode_json


class LabBoundaryMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not (scope["path"] == "/api/v1/lab" or scope["path"].startswith("/api/v1/lab/")):
            await self.app(scope, receive, send)
            return
        trace = str(uuid4())
        scope.setdefault("state", {})["trace_id"] = trace
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                response = problem_response(Request(scope), 413, "PAYLOAD_TOO_LARGE", f"Laboratory JSON requests may not exceed {self.max_bytes} bytes.")
                await response(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        if body:
            try:
                decode_json(body)
            except LabProblem as exc:
                await problem_response(Request(scope), exc.status, exc.code, exc.detail)(scope, receive, send)
                return
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        async def headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                values = [(key, value) for key, value in message.get("headers", []) if key.lower() not in (b"x-request-id", b"cache-control")]
                message["headers"] = [*values, (b"x-request-id", trace.encode("ascii")), (b"cache-control", b"no-store")]
            await send(message)

        await self.app(scope, replay, headers)
