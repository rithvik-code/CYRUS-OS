"""
CYRUS bridge — the optional door to the real machine.

WHAT THIS IS
------------
A tiny loopback daemon that lets the browser half of CYRUS reach files it can
actually touch. It exists because a browser page cannot: it has no filesystem,
no sensors, and no way to enumerate a disk. This is the missing half, not a new
permission model.

WHAT THIS IS NOT
----------------
It is not a shell. There is no `exec` endpoint, no `run` endpoint, and no way to
name one at runtime — not "disabled by default", *absent*. Adding one would
undo the single promise the native side already makes, so the module below has
no code path that can spawn a process with caller-supplied text.

The same boundary, enforced twice
---------------------------------
Every path is confined to `indexed_paths` in config.yaml using the same
`_is_within` check `actions.py` already uses, and the risk levels reported back
to the browser come from `permissions.evaluate`. This is a second enforcement of
an existing boundary, not a second boundary — there is one rule set, applied on
both sides, and the browser is not trusted to have applied it.

Security properties that are load-bearing
-----------------------------------------
* Binds 127.0.0.1 only. Not 0.0.0.0. A LAN-exposed CYRUS would be a remote
  filesystem server for whoever is on the network.
* A token is minted per boot into ~/.cyrus/bridge.json with mode 0600. Every
  request must carry it in X-Cyrus-Token. A token is compared with
  `hmac.compare_digest`, so a wrong guess leaks no timing information.
* No GET handler serves file content. Everything is POST, which means nothing
  lands in a browser history, a proxy log, or the OS's own request log.
* Writes are refused unless the target's parent already exists — a stray
  `write` cannot create an arbitrary directory chain.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import platform
import secrets
import shutil
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:  # optional — the daemon is useful without it, just blinder
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

try:
    import psutil
except ImportError:
    psutil = None

from .actions import load_config, _is_within
from .permissions import evaluate

VERSION = "0.1"
STATE_PATH = Path(os.path.expanduser("~")) / ".cyrus" / "bridge.json"

# The mirror stores file bodies inline. The bridge enforces the same ceiling so
# a 4 GB video does not become a 4 GB JSON response.
MAX_INLINE = 1_048_576
MAX_SCAN_FILES = 2000
MAX_SCAN_DEPTH = 12
# A listing must not become an unbounded file download. A folder inside OneDrive
# or on a network share can also make a cold first read take many seconds, so the
# total inlined body size is capped.
#
# When the cap is hit, `list` REFUSES rather than returning size-only entries.
# Returning a file whose content is null would make the browser open it as an
# empty document, and a save would then overwrite the original with nothing. A
# visible refusal is the smaller failure.
MAX_LIST_INLINE_BYTES = 8 * 1024 * 1024


class Refused(Exception):
    """Raised when a path escapes the allowed roots or a verb is not allowed."""


def allowed_roots(config: dict) -> list[Path]:
    roots = []
    for p in config.get("indexed_paths", []) or []:
        try:
            roots.append(Path(os.path.expanduser(p)).resolve())
        except OSError:
            continue
    return roots


def resolve(rel: str, roots: list[Path]) -> Path:
    """Map a bridge-relative path onto exactly one allowed root.

    `/Documents/a.txt` matches `~/Documents`, `/Projects/x` matches `~/Projects`,
    and the first path segment chooses the root. A resolved path that lands
    outside every root is refused — symlink traversal included, because the
    check runs on the *resolved* path rather than the joined one.
    """
    rel = (rel or "/").lstrip("/")
    segs = [s for s in rel.split("/") if s and s != "."]
    if any(s == ".." for s in segs):
        raise Refused("'..' is not accepted in a bridge path")

    # A root that the caller named explicitly wins. With three indexed_paths,
    # `/Projects/x` must land in ~/Projects and not in ~/Documents/Projects/x,
    # which is also "inside a root" and would otherwise win on iteration order.
    for root in roots:
        if segs and segs[0] == root.name:
            resolved = root.joinpath(*segs[1:]).resolve()
            if _is_within(resolved, root):
                return resolved

    # Otherwise treat the path as relative to each root in turn. The
    # containment check runs on the *resolved* path, so a symlink inside a root
    # that points out of it is refused rather than followed.
    for root in roots:
        candidate = root if not segs else root.joinpath(*segs)
        resolved = candidate.resolve()
        if _is_within(resolved, root):
            return resolved

    raise Refused(
        f"'{rel}' is outside every indexed_path in config.yaml. "
        f"CYRUS can only reach: {', '.join(str(r) for r in roots) or '(none configured)'}"
    )


def mount_name(root: Path, roots: list[Path]) -> str:
    return root.name or str(root)


# ---------------------------------------------------------------------------
# The verbs. There is no exec, no eval, and no subprocess import.
# ---------------------------------------------------------------------------

def op_ping(config, roots, args):
    return {
        "version": VERSION,
        "pid": os.getpid(),
        "roots": [{"name": mount_name(r, roots), "path": str(r), "exists": r.exists()} for r in roots],
        "confined": True,
        "shell": False,
    }


def op_stat(config, roots, args):
    p = resolve(args.get("path"), roots)
    if not p.exists():
        raise Refused(f"'{args.get('path')}' does not exist")
    s = p.stat()
    return {"path": str(p), "type": "dir" if p.is_dir() else "file", "size": s.st_size, "mtime": s.st_mtime}


def op_list(config, roots, args):
    """Build a mirror tree in the same shape the browser's VFS uses."""
    target = resolve(args.get("path", "/"), roots)
    if not target.exists():
        raise Refused(f"'{args.get('path')}' does not exist")
    if target.is_file():
        raise Refused("'list' needs a directory")

    tree = {"type": "dir", "name": target.name, "children": {}, "mtime": target.stat().st_mtime}
    counter = [0]
    budget = [MAX_LIST_INLINE_BYTES]

    def walk(d: Path, node: dict, depth: int):
        if depth > MAX_SCAN_DEPTH or counter[0] > MAX_SCAN_FILES:
            return
        for entry in sorted(d.iterdir(), key=lambda e: e.name):
            if counter[0] > MAX_SCAN_FILES:
                return
            counter[0] += 1
            try:
                st = entry.stat()
            except OSError:
                continue
            if entry.is_dir():
                sub = {"type": "dir", "name": entry.name, "children": {}, "mtime": st.st_mtime}
                node["children"][entry.name] = sub
                walk(entry, sub, depth + 1)
            elif entry.is_file():
                if st.st_size > MAX_INLINE:
                    node["children"][entry.name] = {
                        "type": "file", "name": entry.name, "content": None,
                        "size": st.st_size, "mtime": st.st_mtime * 1000,
                        "ext": entry.suffix.lstrip(".").lower(),
                    }
                else:
                    if st.st_size > budget[0]:
                        raise Refused(
                            f"listing '{target}' would need more than "
                            f"{MAX_LIST_INLINE_BYTES // (1024*1024)} MB of file contents, which is more "
                            "than a listing should carry. Mount a narrower folder instead of this one."
                        )
                    try:
                        body = entry.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        body = ""
                    budget[0] -= st.st_size
                    node["children"][entry.name] = {
                        "type": "file", "name": entry.name, "content": body,
                        "size": st.st_size, "mtime": st.st_mtime * 1000,
                        "ext": entry.suffix.lstrip(".").lower(),
                    }

    walk(target, tree, 0)
    # The mirror keys its children by name and strips the root's own name; the
    # browser expects a virtual "/" at the top. `truncated` tells the browser
    # that some bodies were left behind, so it can say so rather than showing a
    # file as empty and letting someone save that back over the original.
    return {
        "tree": {"type": "dir", "name": "/", "children": {target.name: tree}},
        "files": counter[0],
        "truncated": counter[0] > MAX_SCAN_FILES or budget[0] <= 0,
    }


def op_read(config, roots, args):
    p = resolve(args.get("path"), roots)
    if not p.exists() or p.is_dir():
        raise Refused(f"'{args.get('path')}' is not a readable file")
    if p.stat().st_size > MAX_INLINE:
        raise Refused(f"that file is {p.stat().st_size} bytes — larger than the {MAX_INLINE} byte mirror limit")
    return {"content": p.read_text(encoding="utf-8", errors="replace"), "size": p.stat().st_size}


def op_write(config, roots, args):
    p = resolve(args.get("path"), roots)
    if p.is_dir():
        raise Refused(f"'{args.get('path')}' is a directory")
    if not p.parent.is_dir():
        raise Refused("the parent directory does not exist — use `mkdir` first")
    content = args.get("content", "")
    p.write_text(content, encoding="utf-8")
    # The browser's risk table is the authority on how dangerous this was, so it
    # is read from the same module the palette uses rather than restated here.
    decision = evaluate("move_file", {"source": str(p), "destination": str(p)})
    return {"written": str(p), "bytes": len(content), "risk": decision.risk_level}


def op_delete(config, roots, args):
    p = resolve(args.get("path"), roots)
    if p.is_dir():
        shutil.rmtree(p)
        return {"deleted": str(p), "type": "dir"}
    p.unlink()
    return {"deleted": str(p), "type": "file"}


def op_mkdir(config, roots, args):
    p = resolve(args.get("path"), roots)
    p.mkdir(parents=True, exist_ok=True)
    return {"created": str(p)}


def op_move(config, roots, args):
    src = resolve(args.get("from"), roots)
    dst = resolve(args.get("to"), roots)
    if not src.exists():
        raise Refused(f"'{args.get('from')}' does not exist")
    if dst.exists():
        raise Refused(f"'{args.get('to')}' already exists — move refuses to overwrite")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return {"moved": [str(src), str(dst)]}


def op_sensors(config, roots, args):
    """Real hardware readings, or an explicit statement that there are none.

    Returning empty lists is a valid answer. Guessing would not be.
    """
    out = {"version": VERSION, "psutil": psutil is not None, "memory": [], "disks": [], "cpu": None}
    if psutil is None:
        out["note"] = "psutil is not installed, so physical memory and disks are unavailable. pip install psutil"
        return out
    try:
        out["cpu"] = {"physical": psutil.cpu_count(logical=False), "logical": psutil.cpu_count()}
    except Exception:
        pass
    try:
        for part in psutil.disk_partitions(all=False):
            try:
                u = psutil.disk_usage(part.mountpoint)
            except (PermissionError, OSError):
                continue
            out["disks"].append({"mount": part.mountpoint, "total": u.total, "used": u.used, "free": u.free})
    except Exception:
        pass
    try:
        vm = psutil.virtual_memory()
        out["memory"].append({"mount": "system", "total": vm.total, "used": vm.total - vm.available,
                              "available": vm.available, "percent": vm.percent})
    except Exception:
        pass
    return out


# The whole surface. Adding a name here is the only way to expose a verb.
OPS = {
    "ping": op_ping, "stat": op_stat, "list": op_list, "read": op_read,
    "write": op_write, "delete": op_delete, "mkdir": op_mkdir, "move": op_move,
    "sensors": op_sensors,
}


def make_handler(allowed_origin: str | None):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"CYRUS-bridge/{VERSION}"
        protocol_version = "HTTP/1.1"

        def _cors(self):
            origin = self.headers.get("Origin")
            # Echo the caller's origin back only when it matches, or when the
            # operator deliberately allowed everything with --allow-origin '*'.
            if allowed_origin == "*":
                self.send_header("Access-Control-Allow-Origin", "*")
            elif origin and allowed_origin and origin == allowed_origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            else:
                self.send_header("Access-Control-Allow-Origin", "null")

        def _reply(self, code: int, payload: dict):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            # The browser sends this because X-Cyrus-Token is not a simple header.
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Cyrus-Token")
            self.send_header("Access-Control-Max-Age", "600")
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            # Nothing is served over GET — not even a health page — so a bridge
            # URL that leaks into a history cannot be used to read a file.
            self._reply(405, {"ok": False, "error": "the bridge speaks POST only"})

        def do_POST(self):
            path = self.path.lstrip("/")
            if path not in OPS:
                self._reply(404, {"ok": False, "error": f"no verb '{path}'. Available: {', '.join(sorted(OPS))}"})

            token = self.headers.get("X-Cyrus-Token", "")
            if not hmac.compare_digest(token, self.server.token):  # type: ignore[attr-defined]
                self._reply(401, {"ok": False, "error": "bad or missing X-Cyrus-Token"})
                return

            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > 64 * 1024 * 1024:
                    self._reply(413, {"ok": False, "error": "request body too large"})
                    return
                args = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(args, dict):
                    raise Refused("body must be a JSON object")
            except Refused as e:
                self._reply(400, {"ok": False, "error": str(e)})
                return
            except json.JSONDecodeError:
                self._reply(400, {"ok": False, "error": "body was not valid JSON"})
                return

            try:
                result = OPS[path](self.server.config, self.server.roots, args)  # type: ignore[attr-defined]
                self._reply(200, {"ok": True, "result": result})
            except Refused as e:
                self._reply(403, {"ok": False, "error": str(e)})
            except FileNotFoundError:
                self._reply(404, {"ok": False, "error": "not found"})
            except PermissionError as e:
                self._reply(403, {"ok": False, "error": f"permission denied: {e}"})
            except Exception as e:  # a crash must not be a silent success
                self._reply(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

        def log_message(self, fmt, *a):
            # Verb and status only. Paths are the user's file names and do not
            # belong in a terminal that may be pasted into a bug report.
            sys.stderr.write("[bridge] %s %s\n" % (self.command, a[0] if a else ""))

    return Handler


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m cyrus.bridge",
                                 description="Let CYRUS OS in the browser reach files on this machine, confined to config.yaml.")
    ap.add_argument("--port", type=int, default=8787, help="default 8787")
    ap.add_argument("--allow-origin", default="http://localhost:8791",
                    help="browser origin permitted to call (default matches serve.js). Use '*' only on a machine you trust alone.")
    ap.add_argument("--no-token-file", action="store_true", help="print the token instead of writing it to disk")
    args = ap.parse_args(argv)

    if yaml is None:
        print("PyYAML is required to read config.yaml: pip install pyyaml", file=sys.stderr)
        return 2

    config = load_config()
    roots = allowed_roots(config)
    if not roots:
        print("config.yaml has no indexed_paths, so the bridge has nothing it is allowed to serve.", file=sys.stderr)
        return 2

    missing = [str(r) for r in roots if not r.exists()]
    if missing:
        print("Warning: these indexed_paths do not exist and will be refused: " + ", ".join(missing), file=sys.stderr)

    token = secrets.token_urlsafe(32)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.allow_origin))
    httpd.config = config
    httpd.roots = roots
    httpd.token = token

    if args.no_token_file:
        print("token:", token, flush=True)
    else:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps({
            "url": f"http://127.0.0.1:{args.port}",
            "token": token, "pid": os.getpid(), "allow_origin": args.allow_origin,
        }, indent=2))
        # Windows' os.chmod cannot express 0600 — it only toggles the read-only
        # bit, so a silent except would leave the token readable by anyone with
        # access to the profile directory and the code would claim 0600 anyway.
        # Try, then verify what was actually achieved and report that instead.
        protection = "unknown"
        try:
            os.chmod(STATE_PATH, 0o600)
        except OSError:
            pass
        try:
            mode = os.stat(STATE_PATH).st_mode
            if os.name == "nt":
                protection = "Windows ACL of the user profile (chmod is not meaningful here)"
            elif mode & 0o077:
                protection = f"WARNING: mode {oct(mode & 0o777)} is readable by other users"
            else:
                protection = f"{oct(mode & 0o777)} (owner only)"
        except OSError:
            protection = "could not be determined"

    # flush=True because stdout is block-buffered when it is not a terminal —
    # without it a user piping the output sees nothing until the server exits,
    # which looks exactly like a bridge that failed to start.
    print(f"CYRUS bridge {VERSION} on http://127.0.0.1:{args.port}", flush=True)
    print(f"  roots     {', '.join(str(r) for r in roots)}", flush=True)
    print(f"  origin    {args.allow_origin}", flush=True)
    print(f"  token     {'written to ' + str(STATE_PATH) + ' — ' + protection if not args.no_token_file else 'printed above'}", flush=True)
    print(f"  shell     none — {len(OPS)} verbs, no exec", flush=True)
    print("  stop      ctrl-c", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        httpd.server_close()
        try:
            STATE_PATH.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())