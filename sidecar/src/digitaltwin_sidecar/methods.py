"""RPC method registry. Each method takes the JSON params and returns a JSON-serialisable result."""

from __future__ import annotations

import platform
from typing import Any

from . import __version__
from .rpc import Handler


def ping(_params: Any) -> dict[str, str]:
    return {"status": "ok", "version": __version__, "python": platform.python_version()}


METHODS: dict[str, Handler] = {
    "ping": ping,
}
