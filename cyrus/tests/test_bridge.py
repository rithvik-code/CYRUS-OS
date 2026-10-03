"""
Safety tests for the CYRUS bridge — the daemon that lets the browser reach
files on this machine.

These are aimed only at the properties that would be catastrophic to get
wrong. Everything the bridge does exists to *refuse* something, so the tests
are mostly about what it turns down:

  * a path outside config.yaml's indexed_paths is never served,
  * `..` cannot walk out of a root, including via a symlink,
  * a request without the token gets nothing, not even an error that helps,
  * there is no endpoint that runs a command, by any name,
  * nothing is served over GET, so a URL in a history cannot read a file.

Run with:  python -m pytest cyrus/tests/
"""

import json
import os
import tempfile
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from cyrus import bridge


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def roots(tmp_path):
    """Two allowed roots, one outside folder, and a symlink that tries to escape."""
    inside = tmp_path / "Documents"
    inside.mkdir()
    (inside / "note.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("do not serve me", encoding="utf-8")

    outside = tmp_path.parent / "outside_bridge_test"
    outside.mkdir(exist_ok=True)
    (outside / "private.txt").write_text("private", encoding="utf-8")

    escape = inside / "escape"
    try:
        escape.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        escape = None  # symlinks unavailable on this platform

    cfg = {"indexed_paths": [str(inside)]}
    return cfg, [inside.resolve()], outside.resolve(), escape


@pytest.fixture()
def server(roots):
    cfg, allowed, outside, escape = roots
    token = "test-token-not-a-real-secret"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), bridge.make_handler("http://localhost:8791"))
    httpd.config = cfg
    httpd.roots = allowed
    httpd.token = token
    port = httpd.server_address[1]
    t = __import__("threading").Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", token, outside
    finally:
        httpd.shutdown()
        httpd.server_close()


def post(base, verb, body=None, token="test-token-not-a-real-secret", headers=None):
    req = urllib.request.Request(
        base + "/" + verb,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json", **({"X-Cyrus-Token": token} if token else {}), **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


# ---------------------------------------------------------------------------
# path confinement — the property that matters most
# ---------------------------------------------------------------------------

def test_serves_a_file_inside_an_allowed_root(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/note.txt"}, token)
    assert status == 200 and body["ok"]
    assert body["result"]["content"] == "hello"


def test_refuses_a_path_outside_every_root(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/../secret.txt"}, token)
    assert status == 403 and not body["ok"]
    assert "not accepted" in body["error"] or "outside every indexed_path" in body["error"]


def test_refuses_parent_traversal(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/../../etc/passwd"}, token)
    assert status == 403 and not body["ok"]


def test_refuses_traversal_hidden_in_the_middle(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/a/../../secret.txt"}, token)
    assert status == 403 and not body["ok"]


def test_refuses_to_follow_a_symlink_out_of_a_root(server):
    """A symlink inside an allowed root must not become a way out of it."""
    base, token, _ = server
    # If symlinks could not be created the fixture made no escape link.
    status, body = post(base, "read", {"path": "/escape/private.txt"}, token)
    assert not body["ok"], "a symlink must not grant access outside indexed_paths"
    assert status in (403, 404)


def test_list_never_leaves_the_root(server):
    base, token, _ = server
    status, body = post(base, "list", {"path": "/"}, token)
    assert status == 200 and body["ok"]

    seen = []

    def walk(node):
        for name, child in node.get("children", {}).items():
            seen.append(name)
            walk(child)

    walk(body["result"]["tree"])
    assert "note.txt" in seen, "list returns what is inside the root"
    assert "secret.txt" not in seen, "list leaked a file outside the root"
    assert "outside_bridge_test" not in seen, "list leaked a directory outside the root"


# ---------------------------------------------------------------------------
# authentication
# ---------------------------------------------------------------------------

def test_missing_token_is_refused(server):
    base, _, _ = server
    status, body = post(base, "read", {"path": "/note.txt"}, token=None)
    assert status == 401 and not body["ok"]


def test_wrong_token_is_refused(server):
    base, _, _ = server
    status, body = post(base, "read", {"path": "/note.txt"}, token="wrong")
    assert status == 401 and not body["ok"]
    assert "note.txt" not in json.dumps(body), "a rejected request must not echo what it asked for"


def test_ping_requires_a_token_too(server):
    base, _, _ = server
    status, _ = post(base, "ping", {}, token=None)
    assert status == 401


# ---------------------------------------------------------------------------
# there is no shell
# ---------------------------------------------------------------------------

def test_no_exec_surface_exists():
    """The single most important assertion in this file."""
    forbidden = {"exec", "run", "shell", "eval", "cmd", "command", "system", "spawn", "popen"}
    assert not (forbidden & set(bridge.OPS)), "the bridge must expose no process-spawning verb"
    assert set(bridge.OPS) == {"ping", "stat", "list", "read", "write", "delete", "mkdir", "move", "sensors"}


def test_an_unknown_verb_is_a_404_not_a_fallthrough(server):
    base, token, _ = server
    for verb in ["exec", "shell", "run"]:
        status, body = post(base, verb, {"cmd": "id"}, token)
        assert status == 404 and not body["ok"], verb + " must not exist"


def test_nothing_is_served_over_get(server):
    base, _, _ = server
    req = urllib.request.Request(base + "/read?path=/note.txt", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.status != 200
    except urllib.error.HTTPError as e:
        assert e.code == 405
        assert "POST" in json.loads(e.read())["error"]


# ---------------------------------------------------------------------------
# malformed input
# ---------------------------------------------------------------------------

def test_non_json_body_is_refused(server):
    base, token, _ = server
    req = urllib.request.Request(base + "/read", data=b"{not json",
                                 headers={"Content-Type": "application/json", "X-Cyrus-Token": token}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5)
        assert False, "a malformed body must not be accepted"
    except urllib.error.HTTPError as e:
        assert e.code == 400


def test_a_list_body_is_refused(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/note.txt"}, token)
    assert status == 200
    status, body = post(base, "read", ["not", "an", "object"], token)
    assert status == 400 and not body["ok"]


# ---------------------------------------------------------------------------
# write safety
# ---------------------------------------------------------------------------

def test_write_refuses_to_create_a_directory_chain(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "here.txt").write_text("x", encoding="utf-8")
    cfg = {"indexed_paths": [str(root)]}
    with pytest.raises(bridge.Refused):
        bridge.op_write(cfg, [root.resolve()], {"path": "/deep/nested/new.txt", "content": "x"})


def test_write_refuses_to_clobber_a_directory(tmp_path):
    root = tmp_path / "root"
    (root / "sub").mkdir(parents=True)
    cfg = {"indexed_paths": [str(root)]}
    with pytest.raises(bridge.Refused):
        bridge.op_write(cfg, [root.resolve()], {"path": "/sub", "content": "x"})


def test_move_refuses_to_overwrite(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "a.txt").write_text("a", encoding="utf-8")
    (root / "b.txt").write_text("b", encoding="utf-8")
    cfg = {"indexed_paths": [str(root)]}
    with pytest.raises(bridge.Refused):
        bridge.op_move(cfg, [root.resolve()], {"from": "/a.txt", "to": "/b.txt"})


def test_read_refuses_a_directory(server):
    base, token, _ = server
    status, body = post(base, "read", {"path": "/"}, token)
    assert not body["ok"]


# ---------------------------------------------------------------------------
# resolve() in isolation — cheaper than going over HTTP
# ---------------------------------------------------------------------------

def test_resolve_maps_the_first_segment_onto_a_root(tmp_path):
    docs = tmp_path / "Documents"
    docs.mkdir()
    roots = [docs.resolve()]
    assert bridge.resolve("/a.txt", roots) == (docs / "a.txt").resolve()
    assert bridge.resolve("/", roots) == docs.resolve()


def test_an_explicitly_named_root_wins_over_another_root(tmp_path):
    """`/Projects/x` must land in ~/Projects, not ~/Documents/Projects/x.

    Both are "inside an allowed root", so iteration order alone would decide
    which — and Documents comes first in config.yaml.
    """
    docs = tmp_path / "Documents"
    proj = tmp_path / "Projects"
    docs.mkdir()
    proj.mkdir()
    roots = [docs.resolve(), proj.resolve()]
    assert bridge.resolve("/Projects/a.txt", roots) == (proj / "a.txt").resolve()
    assert bridge.resolve("/Documents/a.txt", roots) == (docs / "a.txt").resolve()
    # With no root named, the path is relative to the first one and stays inside it.
    assert bridge.resolve("/a.txt", roots) == (docs / "a.txt").resolve()


def test_resolve_with_no_roots_refuses_everything():
    with pytest.raises(bridge.Refused):
        bridge.resolve("/anything", [])


def test_ping_advertises_that_there_is_no_shell(server):
    base, token, _ = server
    status, body = post(base, "ping", {}, token)
    assert status == 200
    assert body["result"]["shell"] is False
    assert body["result"]["confined"] is True
    assert len(body["result"]["roots"]) == 1


def test_sensors_returns_a_struct_even_without_psutil():
    """No psutil means empty lists and a note — never a made-up number."""
    out = bridge.op_sensors({"indexed_paths": []}, [], {})
    assert isinstance(out["memory"], list) and isinstance(out["disks"], list)
    assert "memory" in out and "disks" in out
    if not out["psutil"]:
        assert "note" in out and "psutil" in out["note"]

# ---------------------------------------------------------------------------
# listing bounds — a listing must not become a file download
# ---------------------------------------------------------------------------

def test_list_refuses_rather_than_returning_contentless_files(tmp_path):
    """Silently returning content:null would open as an empty document, and a
    save would then overwrite the original with nothing. Refuse instead."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "big.txt").write_text("x" * 4096, encoding="utf-8")
    cfg = {"indexed_paths": [str(root)]}
    real = bridge.MAX_LIST_INLINE_BYTES
    try:
        bridge.MAX_LIST_INLINE_BYTES = 1024
        with pytest.raises(bridge.Refused):
            bridge.op_list(cfg, [root.resolve()], {"path": "/"})
    finally:
        bridge.MAX_LIST_INLINE_BYTES = real


def test_list_reports_how_many_files_it_walked(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    for n in ("a.txt", "b.txt", "c.txt"):
        (root / n).write_text(n, encoding="utf-8")
    out = bridge.op_list({"indexed_paths": [str(root)]}, [root.resolve()], {"path": "/"})
    assert out["files"] == 3
    assert out["truncated"] is False
    leaf = out["tree"]["children"]["root"]["children"]["a.txt"]
    assert leaf["content"] == "a.txt", "a small file must still arrive inline"


def test_a_file_over_the_per_file_cap_is_listed_without_a_body(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    real = bridge.MAX_INLINE
    try:
        bridge.MAX_INLINE = 10
        (root / "big.txt").write_text("y" * 500, encoding="utf-8")
        out = bridge.op_list({"indexed_paths": [str(root)]}, [root.resolve()], {"path": "/"})
    finally:
        bridge.MAX_INLINE = real
    leaf = out["tree"]["children"]["root"]["children"]["big.txt"]
    assert leaf["content"] is None
    assert leaf["size"] == 500, "but the size is still reported, so the file is visible"


def test_reading_an_oversized_file_is_refused(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "big.bin").write_bytes(b"z" * 5000)
    real = bridge.MAX_INLINE
    try:
        bridge.MAX_INLINE = 100
        with pytest.raises(bridge.Refused):
            bridge.op_read({"indexed_paths": [str(root)]}, [root.resolve()], {"path": "/big.bin"})
    finally:
        bridge.MAX_INLINE = real
