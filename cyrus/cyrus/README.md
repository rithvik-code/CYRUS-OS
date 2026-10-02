# CYRUS

An AI command layer that sits on top of your existing OS — not a new OS.

## What this is

A background service + global-hotkey palette that:
1. Understands a typed natural-language request ("intent parsing"),
2. Maps it to a **small, explicitly whitelisted** set of actions,
3. Confirms anything risky before executing,
4. Uses a **local semantic index** of your files/apps so it can find things by meaning, not just filename.

## What this deliberately is NOT (yet)

- Not a kernel, not a distro, not a desktop environment replacement.
- Not multi-provider "AI router" — one local model (Ollama) is the default path. Cloud is opt-in per the `CYRUS_CLOUD_KEY` env var, never required.
- Not unrestricted shell access for the AI. The model never executes raw commands — it can only emit one of the intents defined in `actions.py`, and every intent has a declared risk level.

## Why this scope

The prior version of this idea ("NOVA OS") tried to spec a kernel, an app format, Android/Windows compatibility layers, and a multi-model router before writing a single line of code. That's a five-year roadmap disguised as a starting point. This is the smallest thing that can feel "magical" in a week: a palette, a brain, and a locked-down hand.

## Stack (all free, no required API key)

| Layer | Tool | Why |
|---|---|---|
| Local LLM (intent parsing) | [Ollama](https://ollama.com) running `llama3.2` or `qwen2.5:3b` | Free, local, no rate limits, works offline |
| Semantic search | `sentence-transformers` (`all-MiniLM-L6-v2`) | Free, local, small (~80MB), fast enough for a personal file index |
| Storage | SQLite | Zero-config, no server, built into Python |
| UI | Tkinter | Ships with Python, no extra install, good enough for a palette |
| Hotkey | `pynput` | Free, cross-platform global hotkey listener |

Cloud LLM fallback (optional): if `CYRUS_CLOUD_KEY` is set, requests route to Anthropic's API instead of Ollama. This is a single `if` branch, not a "router" — don't build the router until you have a concrete reason (e.g. local model consistently fails a specific intent type).

## Install

```bash
pip install -r requirements.txt
ollama pull qwen2.5:3b   # or llama3.2 — pick whichever runs acceptably on your hardware
python -m cyrus.main
```

Press the configured hotkey (default: `Ctrl+Space`) to open the palette.

## The five MVP actions (on purpose, only five)

| Action | Example phrase | Risk |
|---|---|---|
| `search_files` | "find my java assignments" | LOW |
| `open_app` | "open vs code" | LOW |
| `open_workspace` | "start my college workspace" | LOW |
| `move_file` | "move report.pdf to Documents/Work" | MEDIUM (confirm) |
| `run_script` | "set up my python data science environment" | MEDIUM (confirm, and only pre-registered scripts — never arbitrary shell text from the model) |

Nothing else exists yet. Adding a sixth action is the wrong next step until these five feel reliable.

## Honest limitations right now

- `search_files` indexes filenames + a config-defined set of folders, not full file *contents*, in v1 — content indexing is a real scope decision, not a checkbox (embedding every PDF/code file has cost and staleness implications).
- `run_script` only runs scripts you've explicitly registered in `config.yaml` — the model picks *which* registered script, it never generates or edits shell commands.
- Risk classification in `permissions.py` is a static table, not a learned classifier. That's correct for v1 — a "risk model" is a project of its own, and a static table you can read top-to-bottom is more trustworthy than a black box for something with filesystem access.
