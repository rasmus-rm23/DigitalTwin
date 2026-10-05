import io
import json

from digitaltwin_sidecar.methods import METHODS
from digitaltwin_sidecar.rpc import (
    INTERNAL_ERROR,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    handle_line,
    serve,
)


def call(method, params=None, id_=1):
    return handle_line(
        json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params}), METHODS
    )


def test_ping():
    resp = call("ping")
    assert resp["id"] == 1
    assert resp["result"]["status"] == "ok"


def test_unknown_method():
    assert call("nope")["error"]["code"] == METHOD_NOT_FOUND


def test_parse_error():
    assert handle_line("{not json", METHODS)["error"]["code"] == PARSE_ERROR


def test_handler_exception_is_reported():
    def boom(_):
        raise ValueError("bad")

    resp = handle_line(json.dumps({"id": 7, "method": "boom"}), {"boom": boom})
    assert resp["id"] == 7
    assert resp["error"]["code"] == INTERNAL_ERROR
    assert "bad" in resp["error"]["message"]


def test_serve_roundtrip():
    stdin = io.StringIO('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n')
    stdout = io.StringIO()
    serve(METHODS, stdin, stdout)
    lines = stdout.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["result"]["status"] == "ok"
