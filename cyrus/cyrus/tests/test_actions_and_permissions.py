"""
These tests target the two files that actually matter for safety:
actions.py (whitelist + dispatch) and permissions.py (risk gating).
No LLM, no GUI, no network — run these with plain `pytest`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cyrus import actions, permissions


def test_unknown_intent_is_rejected():
    result = actions.dispatch("delete_everything", {}, {"apps": {}}, index=None)
    assert result.ok is False
    assert "Unknown intent" in result.message


def test_missing_required_field_is_rejected():
    result = actions.dispatch("open_app", {}, {"apps": {}}, index=None)
    assert result.ok is False
    assert "missing required field" in result.message


def test_open_app_rejects_unregistered_app():
    result = actions.dispatch("open_app", {"app_name": "totally-fake-app"}, {"apps": {}}, index=None)
    assert result.ok is False
    assert "not a registered app" in result.message


def test_move_file_refuses_outside_allowed_paths(tmp_path):
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("data")

    config = {"indexed_paths": ["/some/other/allowed/dir"]}
    result = actions.action_move_file(str(outside_file), "/some/other/allowed/dir", config)
    assert result.ok is False
    assert "outside the indexed" in result.message


def test_move_file_succeeds_within_allowed_paths(tmp_path):
    src_dir = tmp_path / "src"
    dst_dir = tmp_path / "dst"
    src_dir.mkdir()
    dst_dir.mkdir()
    f = src_dir / "report.pdf"
    f.write_text("data")

    config = {"indexed_paths": [str(tmp_path)]}
    result = actions.action_move_file(str(f), str(dst_dir), config)
    assert result.ok is True
    assert (dst_dir / "report.pdf").exists()


def test_low_risk_action_does_not_require_confirmation():
    decision = permissions.evaluate("search_files", {"query": "x"})
    assert decision.requires_confirmation is False
    assert decision.risk_level == "low"


def test_medium_risk_action_requires_confirmation():
    decision = permissions.evaluate("move_file", {"source": "a", "destination": "b"})
    assert decision.requires_confirmation is True
    assert decision.risk_level == "medium"


def test_unregistered_intent_defaults_to_high_and_blocked():
    decision = permissions.evaluate("some_future_intent_nobody_registered", {})
    assert decision.requires_confirmation is True
    assert decision.risk_level == "high"
