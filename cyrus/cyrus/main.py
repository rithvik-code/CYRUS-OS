"""
CYRUS entry point.

Flow for every request:

    hotkey -> palette opens -> user types text
        -> intent.parse_intent()       [LLM: text -> structured intent]
        -> permissions.evaluate()      [static risk table]
        -> if risky: palette.confirm() [blocking user confirmation]
        -> actions.dispatch()          [whitelisted execution only]
        -> memory.Log.record()         [always logged, success or failure]

Nothing skips a step. If intent parsing fails, we stop there and tell the
user, we do not retry with a "looser" interpretation.
"""

import threading

from pynput import keyboard

from . import actions, intent, permissions
from .indexer import FileIndex
from .memory import Log
from .palette_ui import Palette

_config = actions.load_config()
_log = Log()
_index = FileIndex(_config.get("indexed_paths", []))

_palette = None  # set in main()


def handle_request(user_text: str) -> str:
    try:
        intent_name, fields = intent.parse_intent(user_text, _config)
    except intent.IntentParseError as e:
        _log.record(user_text, "unknown", {}, "n/a", False, False, str(e))
        return f"Couldn't understand that: {e}"

    decision = permissions.evaluate(intent_name, fields)

    if decision.requires_confirmation:
        confirm_msg = f"About to run: {intent_name}({fields})\n\nRisk: {decision.risk_level.upper()}\n{decision.reason}"
        approved = _palette.confirm(confirm_msg) if _palette else False
        if not approved:
            _log.record(user_text, intent_name, fields, decision.risk_level, False, False, "User declined confirmation.")
            return "Cancelled."

    result = actions.dispatch(intent_name, fields, _config, _index)
    _log.record(
        user_text, intent_name, fields, decision.risk_level,
        decision.requires_confirmation, result.ok, result.message,
    )
    return result.message


def _build_index_if_needed():
    count = _index.rebuild()
    print(f"[CYRUS] Indexed {count} files across {_config.get('indexed_paths')}")


def main():
    global _palette

    print("[CYRUS] Building file index (this happens once at startup)...")
    threading.Thread(target=_build_index_if_needed, daemon=True).start()

    _palette = Palette(on_submit=handle_request)

    hotkey_str = _config.get("hotkey", "<ctrl>+<space>")
    print(f"[CYRUS] Listening for hotkey: {hotkey_str}")

    def on_activate():
        # Palette runs its own Tk mainloop; call show() on the main thread via after-style trick.
        _palette.show()

    hk = keyboard.GlobalHotKeys({hotkey_str: on_activate}) if hasattr(keyboard, "GlobalHotKeys") else None
    if hk:
        hk.start()
    else:
        # pynput API fallback for older versions
        with keyboard.GlobalHotKeys({hotkey_str: on_activate}) as h:
            h.join()


if __name__ == "__main__":
    main()
