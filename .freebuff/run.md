# Run doc — CYRUS OS preview

## What this project is

Two things live in this checkout:

1. **`cyrus/`** — the original Python/Tkinter CYRUS app (hotkey palette + Ollama intent parsing +
   whitelisted actions). Not previewable in a browser; run it with the commands at the bottom.
2. **`.freebuff/cyrus-os.html`** — a fully working **single-file browser port of CYRUS OS**: boot
   sequence, lock screen, desktop, window manager, macOS-style bubble dock + traffic-light window
   buttons, Windows-style Start-menu home layout, AI command palette, terminal with AI shell,
   Files app on a persistent virtual filesystem, editor, notes, assistant chat, intent-based
   workspaces, AI-filtered notifications, settings (privacy modes, accent, wallpaper, LLM endpoint),
   audit log, and the intent → policy → action pipeline from the Python code, ported to JS.
   Shell look: **royal dark theme** (deep plum surfaces, gold `#d4a53f` default accent, violet/wine
   wallpapers). All chrome is clickable: topbar CYRUS logo opens the Start menu, the search pill
   opens the palette, desktop icons launch on single click. Window caption buttons are **Windows 11
   style** (— ▢ ✕ right-aligned, red close hover). The wallpaper is **pointer-interactive**:
   `initWallFx()` adds parallax orbs + a cursor-following glow (`#wall-fx`); `#winlayer` is
   `pointer-events:none` (windows opt back in) so desktop icons stay clickable underneath.

### Watermelon-style interaction layer
Watermelon UI is a React library, so its design DNA (not code) is ported to vanilla CSS/JS: press
ripples on `.btn/.tb-btn/.dock-item/.sm-app/.achip/.sug` (`initRipples()`), spring `cubic-bezier
(.34,1.56,.64,1)` pop on window/modal open and button presses, gold focus rings on inputs,
staggered Start-menu app entrance, hover lifts on files/notification cards. Respects the
"Animations off" setting (ripples + transitions disabled via `body.no-anim`).

### CYRUS brain (multi-AI reasoning)
- Persona: `CYRUS_PERSONA` (~1.8k-char system prompt: builder context, reasoning style, whitelisted
  capability hints) + `liveContext()` injects real OS state (folders, open windows, recent actions).
- Memory: `AssistantHistory` rolling window (last 12 turns) sent with every chat; capped at 24.
- Astra lane: reasoning tasks go **Puter-first** with Claude Sonnet 4 / GPT-4o class models
  (keyless), then **Pollinations (keyless community API — no key, no sign-in,
  `https://text.pollinations.ai/openai`, OpenAI-compatible POST; verified live 2026-09)** /
  OpenRouter 70B / Gemini / Groq. `Settings → CYRUS Brain` switches Astra ⇄ Fast
  and shows the live chain. "Unlock full IQ" sets privacy=cloud + Astra in one click.
- Privacy defaults migrate once to `cloud` (`brainUnlocked` flag) so the brain is actually usable;
  users can re-lock to Local in Settings.
- **Puter sign-in quirk**: Puter needs a one-time free sign-in; its popup is blocked inside the
  embedded preview webview. The Assistant detects this (`needsSignin`) and shows a one-click
  "Connect my brain" button that opens CYRUS OS in a real browser tab — after signing in there
  once, the keyless Claude/GPT-4o lane works everywhere. (2026-09-18: owner's Puter auth token is
  pasted into Settings → CYRUS Brain → verified live — chat streams from `gpt-5.6-luna`, agents
  plan/synthesize via Puter, no sign-in needed. Token lives only in localStorage; rotate anytime
  from puter.com and re-paste.)
- **Agents crash fix**: `win.run` in `openAgents` declared `const topic` shadowing the outer
  `openAgents(topic)` parameter — TDZ ReferenceError on EVERY agent run. Renamed inner var to
  `task`. Agents now: plan (AI) → execute whitelisted steps (policy-gated) → synthesize report
  → save to ~/Documents → notification.

## How to reproduce the preview artifacts

No build step, no dependencies, no env files. The whole OS is one self-contained HTML file:

- Source: `.freebuff/cyrus-os.html` (inline CSS+JS, zero network calls).
- State (virtual filesystem, audit log, settings) persists in `localStorage` under `cyrus_os_v2`.
  To reseed the demo filesystem: Settings → System → Reset CYRUS OS (or delete that localStorage key).
- The older `.freebuff/preview.html` static overview page still exists; the OS port is the artifact
  worth previewing.

## Phase 1 — AI-native layer (latest)

- **Answer-anything chatbot**: `CYRUS 💬` persona is now world-knowledge FIRST (any topic), OS expert second. Multi-part AI bubbles (paragraph → bubble), streaming, 12-turn memory, 🎙️ Talk (mic dictation via SpeechRecognition; right-click the button to enable spoken replies via Puter TTS), 🧠 Memory viewer.
- **ChatGPT add-on (OpenAI)**: Settings → CYRUS Brain → paste an OpenAI key (gpt-4o/4o-mini/4.1/o4-mini) → tested live → `Router.order()` unshifts `openai` to the front of EVERY lane. No key → free chain unchanged. Keys live only in localStorage (`cyrus_os_v2.settings.apiKeys`).
- **CYRUS Memory**: `MemoryC` — say "remember that …" in any CYRUS chat (or terminal Ask-CYRUS); fact saves to `~/Memory/cyrus-memory.json` (VFS → localStorage, survives reboots), last 20 facts injected into every persona via `MemoryC.block()`. Manage/forget in the 🧠 Memory window.
- **Daily briefing**: `Briefing.show()` — once per calendar day, "Good morning/afternoon/evening" window; AI writes 3 lines from `liveContext()`, honest fallback text if the router is offline.
- **Voice loop**: `Voice` — mic dictation (SpeechRecognition, Chrome/Edge) into the chat input; optional spoken replies via Puter TTS (chunked ≤420 chars).
- **AI App Maker**: `AppMaker` + `app-maker` app — describe an app → single-file HTML generated via the router → saved to `~/Apps/` with `CYRUS-META` comment → runs in a sandboxed iframe (`allow-scripts` only) → pinned under Start → **My Apps** (`buildStartMenu` renders it).
- **Generative themes**: `Themes` + `Router.generativeTheme(vibe)` — model returns strict JSON palette; `applyWallpaper()` supports `wallpaper="gen:<name>"` via injected `#genwall` style + recolored orbs + accent override. Manage in Settings → Appearance (click apply, right-click delete).
- **Smart Organizer**: `IOrganizer` + terminal `organize <folder>` → AI proposes folders+moves → `organize <folder> --apply` (review-before-apply) → `organize --undo`.
- **Puter resilience**: Puter model lanes occasionally return transient errors ("missing model",
  402 on premium lanes). `callPuter`/`streamPuter` now retry through a workhorse chain
  (chosen model → gpt-4o-mini → gpt-4o); streaming never restarts after chunks were emitted
  (prevents duplicated answers), and the router's Pollinations lane still catches anything Puter drops.
- Implementation note: the `app-maker` Apps.register block sits AFTER `const Apps = {...}` (line ~2680) — registering before the declaration is a TDZ crash.

## Things to try (Phase 1 additions)

- Chat with **CYRUS 💬** about anything ("explain black holes like I'm 12") — then say **"remember that my sister's birthday is March 3"** and check 🧠 Memory.
- Settings → CYRUS Brain → paste an **OpenAI key** → Save & test → chat badge shows `ChatGPT (your key)`.
- Settings → Appearance → **Generate a theme** → "a candlelit library at midnight" → wallpaper + accent recompose.
- App Maker 🪄 → "a pomodoro timer" → app opens from Start → My Apps.
- Terminal → `organize Downloads` → review the plan → `organize Downloads --apply` → `organize --undo`.

## How to serve it

Serve the HTML file directly with `register_preview` using `htmlPath`:

```
register_preview { htmlPath: "C:\\Users\\Rithvik\\OneDrive\\Documents\\CYRUS OS\\.freebuff\\cyrus-os.html" }
```

- No process, no port choice, no detached server, no log file — the app serves the file itself.
- The port is assigned fresh by the app on each registration (`http://127.0.0.1:<port>/cyrus-os.html`).
- A Freebuff restart clears the registration but leaves files intact — just `register_preview` again.
- If the browser sandbox blocks `window.prompt`, that's expected: the OS avoids it deliberately.

## Things to try in the preview

- Log in (click **Log in**), then press **Ctrl+Space** and type:
  - `find my java assignments` → ranked search, opens Files with results
  - `show me the presentation about AI last month` → semantic + date-filtered universal search
  - `start my college workspace` → restores Files + Editor + Notes windows
  - `move project.zip to Downloads` → MEDIUM risk → confirmation dialog (try both buttons)
  - `delete everything in C:\` → 🔴 CRITICAL → blocked outright, no dialog
  - `create a python project for predicting house prices` → scaffolds a project tree
  - `clean up my desktop` → registered script, archives Desktop files
  - `what did I work on yesterday?` → recent-activity context query
- Terminal: the **full Linux/CMD/dev command set lives here** — ~110 commands covering:
  - navigation & files (`ls dir cd pwd tree mkdir rm cp mv touch cat less head tail nl wc file stat`)
  - search (`grep findstr find locate which whereis type`), permissions (`chmod chown chgrp umask`)
  - system & processes (`whoami uname uptime cal env history ps top tasklist df du free systeminfo ver`)
  - network (`ip ipconfig ss netstat ping tracert dig nslookup curl wget ssh`)
  - packages (`apt dnf pacman pip npm`), archives (`tar zip unzip gzip gunzip`)
  - dev toolchains (`python pip java javac gcc g++ node` — small safe sandbox interpreters)
  - **mini-git** (per-folder repos in `.cyrus-git/`: `init add commit log status branch switch diff stash tag`)
  - **docker sim** (`images ps pull run stop start rm rmi logs exec compose build`, state in `~/Containers/`)
  - Windows aliases (`dir cls ver where findstr tasklist taskkill ipconfig tracert netstat systeminfo`)
  - **shell operators**: `;` `&&` `||` `|` `>` `>>` `<` `$( )` `*` `?`, plus `alias`, `export`, `source`, `!n` history recall, ↑/↓ history
  - discovery: `man <cmd>`, `apropos <kw>`, `whatis <cmd>`, `cheat [category]` — the whole master list, live
  - **command assistant**: `ask <describe the task>` (alias `??`) — the AI writes the exact command(s) into
    your input line; you review/edit, then press Enter to run (human approval = the permission gate).
    Cloud path: multi-AI router constrained to cyrus-sh builtins; local path: ~20 task rules; final
    fallback: `ai <request>`. `explain <command>` does the reverse — describes what a command does,
    adds safety warnings, and stages it in the input line.
  - and the AI shell: `ai <anything>` — natural language → intent → policy → action
- Memory app: every request, intent, risk level, confirmation and result is logged.

## Dynamic suggestions (latest)

Static template chips are gone from the CYRUS chatbot, Command Assistant, Terminal Ask-CYRUS and
AI App Maker. `Suggest.wire(input, chipRow, {local, model, onPick})` replaces them:
- **Local layer (instant)**: pattern suggestions from what's typed — "what is X" → related
  questions; "rem…" → memory phrasing; VFS files whose names match the words (`find my Rockfall
  dataset.csv`); MAN commands (`explain tar`).
- **Model layer (800ms debounce)**: the router (fast lane) returns 4 JSON follow-ups related to
  the partial input; stale responses are discarded via a token counter.
- Chatbot chips auto-send on click; Command Assistant chips stage into the input (Enter runs) —
  both still pass through the policy gate.

## CYRUS Video, CYRUS Avatar & the CYRUS image engine (latest)

- **CYRUS Video 🎬** (`cyrus-video` app, dock + Start + AI Lab): describe a topic → Router writes a
  storyboard (title + N scenes: image prompt + narration) → scenes painted **sequentially with a
  3.5s stagger** by the keyless **CYRUS image engine** (`image.pollinations.ai`, 1280×720, one
  auto-retry + manual ↻ retry chip per scene — parallel bursts trip its fair-use) → ▶️ Play with
  narration (per-scene Puter TTS, caption highlight sync).
- **CYRUS Avatar 🗣️** (`cyrus-avatar` app): a talking presenter. Keyless show = AI portrait
  (same engine, 3 looks) + synced voice + caption. **D-ID lane**: paste a D-ID API key in
  Settings → CYRUS Brain (`apiKeys.did`) → portrait is sent to `api.d-id.com/talks` and the
  rendered talking-head video plays in-OS (Basic auth, 3s polling up to 2 min).
- **CYRUS image engine**: `Router.imgUrl(prompt,w,h)` + `CyrusVideo.loadImage(prompt)` — free,
  keyless, no account; also powers AI Studio's Image tab (Puter txt2img is the fallback).
  Cold wide-size renders can take ~20s; warm ones are sub-second.
- Branding: all engines present as **CYRUS** own tools; third-party names appear only in
  Settings (for the optional key) and in code comments.

## CYRUS Studio, chatbot role split & free-AI toolkit (latest)

- **CYRUS Studio** (the Editor app): VS Code/Cursor-style IDE — file explorer (Projects/Documents/Desktop),
  tabs with dirty dots, line-number gutter, Ctrl+S save / Ctrl+Enter run, status bar. Runs **JS for real**
  (captured console), **Python** via the sandbox, **live HTML preview** in an iframe, JSON validation.
  **Copilot panel**: Explain / Find bugs / Comment / Tests / Optimize quick actions + freeform chat,
  file content auto-attached, answered via the AI Router.
- **Role split**: `CYRUS` 💬 (dock + Start menu + desktop) = the friendly ChatGPT-style chatbot —
  clarifies ANY doubt, knows the whole OS cold via `CYRUS_OS_KNOWLEDGE` fact sheet, remembers the chat
  (`CyrusChatHistory`). `Command Assistant` 🛠️ = the executor (whitelisted intents, policy-gated).
  Terminal has an **💬 Ask CYRUS tab** — same chatbot, answers where you work.
- **Free AI Toolkit** (Settings): one-click key links — Groq, Google AI Studio, OpenRouter (:free),
  Puter (keyless) — plus deep links to standalone coding agents: Freebuff, OpenAI Codex, Google
  Antigravity, Cursor. Manual Puter token connect also lives here (Settings → CYRUS Brain).

## Running the actual Python CYRUS app (not part of the preview)

```bash
pip install -r cyrus/requirements.txt     # sentence-transformers, pynput, pyyaml, requests
ollama pull qwen2.5:3b                    # local model, free and offline
python -m cyrus.main                      # from inside the cyrus/ folder
# press Ctrl+Space to open the palette
```

Tests: `python -m pytest cyrus/tests/` (covers `actions.py` and `permissions.py`).
