"""
Turns a free-text request into ONE structured intent from actions.INTENT_SCHEMAS.

Design choice: the model is instructed to output JSON only, and we validate
that JSON against the schema before anything touches actions.dispatch().
If parsing fails or the model returns something outside the schema, we
surface that as "I couldn't understand that" rather than guessing.

Local-first: default backend is Ollama (free, offline, no key).
Cloud fallback is a single conditional, not a "router" — add real routing
logic only once you have evidence local models fail specific intent types.
"""

import json
import os
import re

import requests

from .actions import INTENT_SCHEMAS

SYSTEM_PROMPT = """You are the intent parser for CYRUS, a locked-down AI command layer.

You may ONLY respond with a single JSON object of this exact shape:
{"intent": "<one of the allowed intent names>", "fields": {...}}

Allowed intents and their required fields:
- search_files: {"query": string}
- open_app: {"app_name": string}
- open_workspace: {"workspace_name": string}
- move_file: {"source": string, "destination": string}
- run_script: {"script_name": string}

Rules:
- Output ONLY the JSON object. No prose, no markdown fences, no explanation.
- If the request doesn't clearly map to one of these intents, respond with:
  {"intent": "unknown", "fields": {}}
- Never invent an intent name that isn't in the list above.
- For file paths, use the literal text the user gave (e.g. "~/Documents/report.pdf"),
  don't resolve or guess absolute paths yourself.
"""


class IntentParseError(Exception):
    pass


def _extract_json(text: str) -> dict:
    # Models sometimes wrap JSON in ```json fences despite instructions — strip defensively.
    text = text.strip()
    text = re.sub(r"^```(json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise IntentParseError(f"No JSON object found in model output: {text[:200]!r}")
    return json.loads(match.group(0))


def _call_ollama(user_text: str, config: dict) -> str:
    host = config["llm"]["ollama_host"]
    model = config["llm"]["ollama_model"]
    resp = requests.post(
        f"{host}/api/chat",
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ],
            "stream": False,
            "options": {"temperature": 0},
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def _call_cloud(user_text: str, config: dict) -> str:
    api_key = os.environ.get("CYRUS_CLOUD_KEY")
    if not api_key:
        raise IntentParseError("CYRUS_CLOUD_KEY not set; cannot use cloud backend.")
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": config["llm"]["cloud_model"],
            "max_tokens": 300,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_text}],
        },
        timeout=30,
    )
    resp.raise_for_status()
    content = resp.json()["content"]
    return "".join(block.get("text", "") for block in content)


def parse_intent(user_text: str, config: dict) -> tuple[str, dict]:
    backend = config["llm"].get("backend", "ollama")
    raw = _call_cloud(user_text, config) if backend == "cloud" else _call_ollama(user_text, config)

    try:
        parsed = _extract_json(raw)
    except (IntentParseError, json.JSONDecodeError) as e:
        raise IntentParseError(f"Model output wasn't valid JSON: {e}")

    intent_name = parsed.get("intent")
    fields = parsed.get("fields", {})

    if intent_name == "unknown" or intent_name not in INTENT_SCHEMAS:
        raise IntentParseError(f"Request didn't map to a known action (model said: {intent_name!r}).")

    return intent_name, fields
