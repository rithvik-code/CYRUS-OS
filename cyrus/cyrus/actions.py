"""
The whitelist. This file is the actual security boundary of CYRUS.

The LLM never gets shell access. It only ever produces one of the
INTENT_SCHEMAS below (as JSON), which this module validates and dispatches.
If the model hallucinates an action name or invalid fields, we reject it
before anything runs — we do NOT try to "fix" or reinterpret it.
"""

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yaml

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r") as f:
        return yaml.safe_load(f)


@dataclass
class ActionResult:
    ok: bool
    message: str


# ---------------------------------------------------------------------------
# The five MVP actions. Each function takes ONLY the fields defined in its
# schema below. No action here calls a generic shell(cmd) — that pattern is
# explicitly banned, because it collapses the whitelist back into "AI has a
# terminal", which is exactly what we're avoiding.
# ---------------------------------------------------------------------------


def action_search_files(query: str, index) -> ActionResult:
    results = index.search(query, top_k=8)
    if not results:
        return ActionResult(True, f"No files matched '{query}'.")
    listing = "\n".join(f"- {r}" for r in results)
    return ActionResult(True, f"Found {len(results)} matches:\n{listing}")


def action_open_app(app_name: str, config: dict) -> ActionResult:
    apps = config.get("apps", {})
    key = app_name.strip().lower()
    if key not in apps:
        return ActionResult(False, f"'{app_name}' is not a registered app. Add it to config.yaml first.")
    cmd = apps[key]
    try:
        subprocess.Popen(cmd.split(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return ActionResult(True, f"Opened {app_name}.")
    except Exception as e:
        return ActionResult(False, f"Failed to open {app_name}: {e}")


def action_open_workspace(workspace_name: str, config: dict) -> ActionResult:
    workspaces = config.get("workspaces", {})
    key = workspace_name.strip().lower()
    if key not in workspaces:
        return ActionResult(False, f"'{workspace_name}' is not a registered workspace.")
    ws = workspaces[key]
    opened = []
    for app in ws.get("apps", []):
        r = action_open_app(app, config)
        if r.ok:
            opened.append(app)
    folder = ws.get("open_folder")
    if folder:
        folder = os.path.expanduser(folder)
        try:
            subprocess.Popen(["xdg-open", folder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    return ActionResult(True, f"Started '{workspace_name}' workspace: {', '.join(opened) or 'no apps opened'}.")


def action_move_file(source: str, destination: str) -> ActionResult:
    src = Path(os.path.expanduser(source)).resolve()
    dst_dir = Path(os.path.expanduser(destination)).resolve()

    allowed_roots = [Path(os.path.expanduser(p)).resolve() for p in load_config().get("indexed_paths", [])]
    if not any(_is_within(src, root) for root in allowed_roots):
        return ActionResult(False, f"Refused: '{source}' is outside the indexed/allowed paths.")
    if not any(_is_within(dst_dir, root) for root in allowed_roots):
        return ActionResult(False, f"Refused: destination '{destination}' is outside the indexed/allowed paths.")
    if not src.exists():
        return ActionResult(False, f"'{source}' does not exist.")

    dst_dir.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dst_dir / src.name))
        return ActionResult(True, f"Moved {src.name} -> {dst_dir}")
    except Exception as e:
        return ActionResult(False, f"Move failed: {e}")


def action_run_script(script_name: str, config: dict) -> ActionResult:
    scripts = config.get("scripts", {})
    key = script_name.strip().lower()
    if key not in scripts:
        return ActionResult(False, f"'{script_name}' is not a registered script.")
    script_path = Path(scripts[key]["path"]).resolve()
    if not script_path.exists():
        return ActionResult(False, f"Registered script not found on disk: {script_path}")
    try:
        subprocess.Popen(["bash", str(script_path)])
        return ActionResult(True, f"Running '{script_name}'.")
    except Exception as e:
        return ActionResult(False, f"Failed to run script: {e}")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Schema: name -> (required fields, risk level, human description)
# `risk` drives permissions.py. Nothing here is inferred at runtime.
# ---------------------------------------------------------------------------

INTENT_SCHEMAS: dict[str, dict[str, Any]] = {
    "search_files": {"fields": ["query"], "risk": "low"},
    "open_app": {"fields": ["app_name"], "risk": "low"},
    "open_workspace": {"fields": ["workspace_name"], "risk": "low"},
    "move_file": {"fields": ["source", "destination"], "risk": "medium"},
    "run_script": {"fields": ["script_name"], "risk": "medium"},
}


def dispatch(intent_name: str, fields: dict, config: dict, index) -> ActionResult:
    if intent_name not in INTENT_SCHEMAS:
        return ActionResult(False, f"Unknown intent '{intent_name}' — rejected before execution.")

    required = INTENT_SCHEMAS[intent_name]["fields"]
    missing = [f for f in required if f not in fields]
    if missing:
        return ActionResult(False, f"Intent '{intent_name}' missing required field(s): {missing}")

    if intent_name == "search_files":
        return action_search_files(fields["query"], index)
    if intent_name == "open_app":
        return action_open_app(fields["app_name"], config)
    if intent_name == "open_workspace":
        return action_open_workspace(fields["workspace_name"], config)
    if intent_name == "move_file":
        return action_move_file(fields["source"], fields["destination"])
    if intent_name == "run_script":
        return action_run_script(fields["script_name"], config)

    return ActionResult(False, "Intent matched schema but no handler wired up — this is a bug, not a model error.")
