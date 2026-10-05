"""Line-delimited JSON-RPC 2.0 over stdio.

stdout is reserved for protocol messages - log to stderr only.
"""

from __future__ import annotations

import json
import sys
import traceback
from collections.abc import Callable
from typing import Any, TextIO

Handler = Callable[[Any], Any]

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def _error(id_: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def handle_line(line: str, methods: dict[str, Handler]) -> dict[str, Any] | None:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return _error(None, PARSE_ERROR, str(e))
    if not isinstance(req, dict) or "method" not in req:
        return _error(None, INVALID_REQUEST, "invalid request")

    id_ = req.get("id")
    handler = methods.get(req["method"])
    if handler is None:
        return _error(id_, METHOD_NOT_FOUND, f"unknown method: {req['method']}")
    try:
        result = handler(req.get("params"))
    except Exception as e:  # noqa: BLE001 - report every failure to the caller
        traceback.print_exc(file=sys.stderr)
        return _error(id_, INTERNAL_ERROR, f"{type(e).__name__}: {e}")
    if id_ is None:  # notification
        return None
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def serve(methods: dict[str, Handler], stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout):
    for line in stdin:
        if not line.strip():
            continue
        resp = handle_line(line, methods)
        if resp is not None:
            stdout.write(json.dumps(resp) + "\n")
            stdout.flush()
