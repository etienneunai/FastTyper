# FastTyper

Fully-local, low-latency grammar correction. A `llama.cpp` daemon runs a purpose-built spelling/grammar-correction LLM on your GPU, and an Obsidian plugin (CodeMirror 6) intercepts completed sentences as you type, sends them to the local daemon, and applies minimal in-place corrections. Everything runs on your machine — nothing leaves it.

## How it works

1. **Trigger** — The plugin fires the moment you insert a stopping punctuation (`.`, `?`, `!`) or a newline, then waits **100 ms** to confirm the character wasn't deleted.
2. **Capture** — For punctuation, the completed sentence (with `.?!`-cluster, abbreviation, and decimal heuristics); for a newline, the completed line. Units over 800 chars or containing code/frontmatter are skipped.
3. **Correct** — The unit is POSTed to `http://127.0.0.1:8808/v1/chat/completions`. The model returns the **full corrected text** (`temperature: 0`), and the plugin computes a character-level LCS diff so only the minimal changed spans are applied in place.
4. **Revert** — Each correction gets a wavy underline. Hovering shows the original typo with surrounding context; click to revert.
5. **Resend-on-conflict** — If you keep typing while a request is in flight, the plugin detects the span changed and **re-sends the current text** (up to 3 retries) instead of inserting stale text. Only one request is in flight at a time; later triggers queue.
6. **Capitalization** — Sentence-initial letters are capitalized deterministically in the plugin (the model is spelling-only and won't do it). Toggleable in settings.
7. **Log** — Every exchange is appended to `llm-log.txt` (gitignored) for debugging.

## Models

**Models are not stored in this repository.** They are downloaded to `~/.local/share/models/` by the setup script (several GB — never committed).

| Model | Size | Notes |
|-------|------|-------|
| `dyslexic-writer-qwen3-4b-q4_k_m.gguf` | ~2.5 GB | **Primary.** Qwen3-4B fine-tune purpose-built for spelling/grammar correction: ~85.6% exact match, ~99.3% leaves correct text untouched. |
| `qwen2.5-0.5b-instruct-q8_0.gguf` | ~645 MB | Old fallback (weak — kept on disk). |
| dyslexic-writer 1.7B variant | — | Faster drop-in fallback (~82.2% exact match) if latency on the 4B is too high. |

### Download the models

```fish
cd backend
fish setup.fish
```

`setup.fish` downloads the primary model to `~/.local/share/models/` and builds `llama.cpp` with Vulkan support, installing `llama-server` (binary **and** shared libs) into `/usr/local`.

Or download manually:

```bash
mkdir -p ~/.local/share/models/
wget -O ~/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf \
  "https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"
```

## Backend (llama.cpp daemon)

The backend runs as a systemd user service, offloading inference to the integrated GPU via Vulkan (configured to spare the discrete GPU's thermals and battery).

```bash
systemctl --user daemon-reload
systemctl --user enable --now fasttyper
journalctl --user -u fasttyper -f   # watch the logs
```

Verify Vulkan actually engaged (no `no usable GPU found` warning; `/dev/dri/renderD*` is open by the process). The API listens on `http://127.0.0.1:8808`.

## Build & install the Obsidian plugin

Prerequisites: `node` / `npm`.

```bash
cd obsidian-plugin
npm install --legacy-peer-deps   # first time only
npm run build                    # esbuild → main.js (tsc must also pass)
```

Copy the output into your vault:

```bash
cp -r {main.js,manifest.json,styles.css} ~/path/to/YourVault/.obsidian/plugins/fasttyper/
```

Then reload Obsidian (Ctrl-R) and enable the plugin under **Settings → Community plugins**.

Once enabled you get:
- **Two hotkey-bindable commands** (Settings → Hotkeys, search "FastTyper"):
  - *FastTyper: Accept all corrections* — commit every applied correction and clear the underlines.
  - *FastTyper: Pause/resume corrections* — stop/start triggering new corrections (with a notification).
- **A settings tab** (Settings → FastTyper) with the pause toggle, a *Capitalize sentence-initial letters* toggle, and an *Accept all* button.

## Project layout

```
backend/              Llama.cpp daemon: systemd unit + setup.fish (model download, Vulkan build)
obsidian-plugin/      CodeMirror 6 Obsidian plugin (src/main.ts is the core)
browser-extension/    Firefox extension: local grammar correction in web text fields
CLAUDE.md             Detailed development notes and architecture
```

### Browser extension (universal correction for the web)

Corrects typos in any web text field by reusing the same engine as the Obsidian
plugin (same sentence trigger, same minimal LCS diff, same model call). It talks
to the same `127.0.0.1:8808` daemon, so **no backend changes are needed**.

- **Where it works**: plain `<textarea>`s, `input[type=text]`, and
  contenteditable editors (e.g. GitHub comments, email composers, CMS editors).
- **Where it's disabled**: password/login/username fields, Google Docs
  (canvas-rendered), and mirrored-hidden-textarea editors (CodeMirror, Monaco,
  Notion-style) — their visible text isn't DOM text. You can also blacklist
  whole sites (exact hostname or any subdomain) from the popup.
- **Revert**: in contenteditable editors, corrections get a wavy underline and a
  hover → click-to-revert tooltip (and Ctrl+Z works, since edits go through
  `execCommand`). Plain textareas can't show inline markup, so each correction
  shows a transient pill with the corrected sentence, every changed word shown
  as `was → now`, and one Undo button that reverts all of them.
- **Controls**: toolbar popup (pause, capitalize-sentence-initials, accept-all,
  site blacklist, daemon status, recent-exchange log) plus a `Ctrl+Shift+F`
  pause shortcut. If you edit a corrected sentence again, it isn't re-corrected
  over your typing.
- **Logging**: browser extensions have no filesystem access, so the exchange log
  lives in `storage.local` (last 50) and is viewable in the popup, rather than
  `llm-log.txt`.

**Build & load (development):**

```bash
cd browser-extension
npm install          # first time only
npm run build        # esbuild → dist/ + tsc --noEmit must pass
```

Load in Firefox via `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → select `browser-extension/dist/manifest.json`. Reload after each
build. (For a permanent install, sign it on addons.mozilla.org or use
`about:config` → `xpinstall.signatures.required=false` for a local build.)

## Privacy

Fully local — no data leaves your machine. Note that `llm-log.txt` (in the repo root when running) records every sentence sent and the raw model response; it is gitignored.
