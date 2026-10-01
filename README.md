# FastTyper

Fully-local, low-latency grammatical error and spelling correction running entirely on your machine. A `llama.cpp` daemon serves a purpose-built fine-tuned model on your GPU, while frontends for **Obsidian** and **Firefox** intercept completed sentences as you type and apply minimal in-place corrections without interrupting your flow. Zero data leaves your machine.

---

## Frontends

FastTyper supports two frontends powered by the same shared correction engine and local backend:

1. **Obsidian Plugin** (`obsidian-plugin/`) — CodeMirror 6 plugin with sentence/line triggers, in-flight status indicators, conflict resend, and inline revert UI.
2. **Firefox Web Extension** (`browser-extension/`) — Universal web extension correcting textareas, input fields, and contenteditable editors (GitHub, emails, web apps) across the browser.

---

## How It Works

```
User types sentence ──► Stopping punct (.?!) / newline ──► 100ms debounce
                                                                 │
                                                   Mask Markdown (<M0/> / █)
                                                                 │
┌────────────────────────── Thinking Mode ───────────────────────┴──────────────────────────┐
│                                                                                           │
│  [Fast Mode]  ────────► Flat inference (~0.4s)                                            │
│                                                                                           │
│  [Auto Mode]  ────────► Flat inference (~0.4s) ──► No-op or suspect non-dictionary word?  │
│  (Default)                                            │ No                  │ Yes         │
│                                                       ▼                     ▼             │
│                                                  Done (flat)       Escalate to Thinking   │
│                                                                    Pass E+Budget (~6-12s) │
│                                                                                           │
│  [Always Mode] ───────► Thinking Pass E+Budget (~6-12s)                                   │
│                                                                                           │
└────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │
                         Parse output & Restore Markdown
                                         │
                             Character-level LCS diff
                                         │
                                  Apply in place
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
            [Obsidian / Contenteditable]              [Plain Textarea]
        Blue wavy underline + hover tooltip         Transient pill with Undo
```

1. **Trigger** — Fires immediately upon typing stopping punctuation (`.`, `?`, `!`) or a newline, followed by a **100 ms** debounce to verify the character was not deleted.
2. **Capture & Markdown Protection** — For punctuation, captures the completed sentence (with `.?!`-cluster, abbreviation, and decimal heuristics); for newline, captures the completed line. Structural Markdown markers (`#`, `*`, `>`, `[[wiki]]`, math `$..$`, code blocks, inline code) are masked before sending to the model and restored afterwards to protect formatting. Units consisting purely of markdown formatting or exceeding 800 characters are skipped.
3. **Thinking Mode & Escalation**:
   - **Fast**: Flat inference only (~0.4s).
   - **Auto** (default): Runs flat inference first. If the output is unchanged (a no-op) or contains suspect non-dictionary tokens (checked against the bundled ~275k `wordlist.json` with suffix stemming), it escalates **once** to Preset E with Qwen3 thinking enabled (`reasoning_budget_tokens: 256`, ~6–12s).
   - **Always**: Runs every request with thinking enabled.
   - In-flight requests are highlighted amber (`.ft-processing`, pulsing while thinking via `.ft-processing-thinking` in Obsidian; status pill in browser).
4. **Minimal LCS Diff** — The model returns the full corrected text. FastTyper computes a character-level Longest Common Subsequence (LCS) diff to apply only the exact modified spans in place.
5. **Revert UI**:
   - **Obsidian & Contenteditable**: Changes receive a blue wavy underline. Hovering displays a context snippet (`…before[original]after…`); clicking reverts that specific diff.
   - **Plain `<textarea>`**: Displays a transient status pill below the field showing `struck-original → now` with a one-click Undo button.
6. **Conflict & Caret Handling**:
   - In Obsidian, span positions are mapped through subsequent user transactions. If typing modified the sent span before the daemon responded, FastTyper re-sends the updated text (up to 3 retries) instead of inserting stale text.
   - In the browser extension, caret positions are mapped smoothly through diff hunks, and in-flight conflicts are safely abandoned.
7. **Deterministic Capitalization** — Sentence-initial lowercase letters are capitalized deterministically in the plugin/extension (toggleable in settings).
8. **Logging** — Request/response exchanges can be logged locally (`FastTyper-LLM-Log.md` in Obsidian vault root, or `storage.local` ring buffer in browser extension).

---

## Models

**Models are not stored in this repository.** Download them to `~/.local/share/models/`:

| Model | Size | Notes |
|---|---|---|
| `dyslexic-writer-qwen3-4b-q4_k_m.gguf` | ~2.5 GB | **Primary.** Qwen3-4B fine-tune purpose-built for spelling/grammar correction: ~85.6% exact match, ~99.3% leaves correct text untouched. Flat inference ~0.2–0.4 s on a 780M iGPU. Use this unless latency is a problem. |
| `dyslexic-writer-1.7b-q4_k_m.gguf` | ~1.1 GB | **Lighter fallback.** Qwen-1.7B fine-tune (`q4_k_m`): ~82.2% exact match, noticeably faster. Choose this on lower-powered hardware or if the 4B model's thinking passes (~6–12 s) are too slow. Swap by setting `MODEL` in `~/.config/fasttyper/config` and the **Model Name** setting in the plugin/extension. |

### System Prerequisites

Building the backend requires standard C++ and GPU acceleration toolchains:
- **Ubuntu/Debian**: `sudo apt update && sudo apt install -y build-essential cmake git curl libvulkan-dev glslc`
- **Fedora/RHEL**: `sudo dnf install -y gcc-c++ make cmake git curl vulkan-headers vulkan-loader-devel glslc`
- **Arch Linux**: `sudo pacman -S --needed base-devel cmake git curl vulkan-headers vulkan-icd-loader shaderc`

### Download Model & Build llama.cpp

Run the backend setup script from the root of the repository:

```bash
# Downloads the 4B model by default and compiles llama-server with Vulkan
./backend/setup.sh

# Or to download the 1.7B fallback model:
./backend/setup.sh 1.7b
```

`setup.sh` downloads the chosen model to `~/.local/share/models/`, builds `llama.cpp` scoped to `llama-server` (`~/.local/src/llama.cpp`), and installs it rootlessly to `~/.local/bin` with `$ORIGIN`-relative library RPATH.

Or download the model manually:

```bash
mkdir -p ~/.local/share/models/
wget -c -O ~/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf \
  "https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"
```

---

## Backend Daemon

The backend listens on `http://127.0.0.1:8808/v1/chat/completions`.

### Option A: Systemd User Service (Linux)

```bash
# Symlink service file to systemd user directory (run from the repository root)
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/backend/fasttyper.service" ~/.config/systemd/user/fasttyper.service

# Reload and start service
systemctl --user daemon-reload
systemctl --user enable --now fasttyper

# Inspect daemon logs
journalctl --user -u fasttyper -f
```

### Option B: Standalone Runner (Non-Systemd / Containers / macOS)

Run the standalone runner script directly:

```bash
./backend/run-daemon.sh
```

Or run `llama-server` directly with your preferred flags:

```bash
llama-server \
  -m ~/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf \
  --port 8808 \
  --host 127.0.0.1 \
  -ngl 99 \
  -cb \
  -c 2048 \
  --threads 4 \
  --reasoning off
```

### Configuration

Copy the example configuration to customize ports, paths, or GPU device selection without modifying tracked files:

```bash
mkdir -p ~/.config/fasttyper
cp backend/config.example ~/.config/fasttyper/config
```

### Regression & Corpus Evaluation

Run the evaluation test suite against the live daemon:

```bash
./backend/eval-corpus.sh -p E -t on -b 256 backend/corpus.txt
```

---

## Obsidian Plugin

### Build & Installation

Prerequisites: Node.js & npm.

```bash
cd obsidian-plugin
npm install
npm run build
```

Copy the build output to your Obsidian vault:

```bash
mkdir -p "~/path/to/Your Vault/.obsidian/plugins/fasttyper/"
cp -r main.js manifest.json styles.css "~/path/to/Your Vault/.obsidian/plugins/fasttyper/"
```

> [!NOTE]
> The dictionary wordlist is pre-compressed and bundled directly into `main.js`, ensuring 100% offline functionality without extra file copies.

Reload Obsidian (`Ctrl+R`) and enable **FastTyper** in **Settings → Community plugins**.

### Commands (Hotkey-Bindable)

Search "FastTyper" in **Settings → Hotkeys**:
- **Accept all corrections** — Commits all active corrections and clears underlines.
- **Pause/resume corrections** — Toggles sentence triggers on/off.
- **Cycle thinking mode** — Rotates Fast $\rightarrow$ Auto $\rightarrow$ Always.
- **Halt current correction** — Discards the in-flight request, aborts pending triggers, and clears processing markers.

### Settings Tab

Under **Settings → FastTyper**:
- **Daemon status**: Live connectivity check (🟢 Connected / 🔴 Disconnected).
- **LLM Base URL**: Default `http://127.0.0.1:8808`.
- **Model Name**: Model identifier loaded in the daemon.
- **Pause corrections**: Toggle active correction interception.
- **Capitalize sentence-initial letters**: Deterministic first-letter capitalization.
- **Log LLM exchanges**: Append requests/responses to `FastTyper-LLM-Log.md` in vault root.
- **Correction prompt**: Preset selector (`A — prod`, `B — gram`, `E — proof`, `C — clean`, `Custom` with editable System & User templates).
- **Thinking mode**: `Fast` (flat only), `Auto` (flat with thinking escalation), `Always` (full thinking).
- **Accept all** & **Halt** buttons.

---

## Browser Extension (Firefox)

Universal real-time grammar correction across web text fields, communicating with the same local daemon.

### Features

- **Supported Fields**: `<textarea>`, `<input type="text">`, and `contenteditable` elements (GitHub comment boxes, email clients, rich text editors).
- **Protected Fields**: Password/credential fields, Google Docs (canvas), and hidden-textarea mirrored editors (CodeMirror, Monaco, Notion) are automatically bypassed.
- **Domain Blacklist**: Block specific hostnames or subdomains from the popup.
- **Revert UX**: Contenteditable fields get inline wavy underlines and hover tooltips; plain textareas get transient diff pills with one-click sentence undo.
- **Shortcuts**: `Alt+Shift+F` (Pause/Resume), `Alt+Shift+H` (Halt in-flight request), `Alt+Shift+Y` (Cycle thinking mode), `Alt+Shift+A` (Accept all active corrections).

### Build & Load in Firefox

```bash
cd browser-extension
npm install
npm run build
```

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select `browser-extension/dist/manifest.json`.

> [!TIP]
> **Session Persistence**: Extensions loaded via `about:debugging` are temporary and unload when Firefox closes. For persistent local development and testing, you can use the Mozilla `web-ext` CLI tool:
> ```bash
> npx web-ext run --source-dir browser-extension/dist
> ```
> Or install as a signed/self-hosted XPI in Firefox Developer Edition / Nightly.

---

## Prompt Presets & Generation Details

FastTyper uses purpose-crafted system and user prompt presets:

- **`A — prod`** *(Default)*: Fast, spelling-only. Safest baseline — never alters correct text or triggers reasoning loops.
- **`B — gram`**: Spelling + missing spaces + *a/an* article agreement.
- **`E — proof`**: Comprehensive proofreader fixing misspellings, run-together words, missing apostrophes, and *a/an* agreement. Used for Thinking Mode passes.
- **`C — clean`**: Experimental text cleaner (missing spaces between run-together words).
- **`Custom`**: User-defined System and User prompt templates (`{text}` placeholder).

**Inference Parameters**:
- `temperature: 0`
- Flat requests: `max_tokens: min(2048, text.length/3 + 256)`, `chat_template_kwargs.enable_thinking: false`.
- Thinking requests: `max_tokens: 2048`, `chat_template_kwargs.enable_thinking: true`, `reasoning_budget_tokens: 256`, `reasoning_budget_message: "Stop reasoning and answer now."` (prevents Qwen3 runaway reasoning frenzies).

---

## Project Structure

```
FastTyper/
├── backend/
│   ├── fasttyper.service    # Systemd user service unit (parameterized)
│   ├── run-daemon.sh        # Standalone daemon runner for non-systemd setups
│   ├── config.example       # Example daemon configuration template
│   ├── setup.sh             # Scoped llama-server build & model download
│   ├── eval-corpus.sh       # Streamlined regression & latency evaluation script
│   ├── eval_worker.py       # Standalone evaluation worker
│   └── corpus.txt           # Eval benchmark dataset
├── obsidian-plugin/
│   ├── src/main.ts          # Core CM6 plugin logic & settings
│   ├── styles.css           # Applied & processing underlines
│   └── esbuild.config.mjs   # Bundler embedding compressed offline dictionary
├── browser-extension/
│   ├── src/shared.ts        # Shared diff, mask, and prompt engine
│   ├── src/background.ts    # Background script & localhost HTTP bridge
│   ├── src/content.ts       # DOM input watcher, caret mapper & Shadow DOM UI
│   ├── src/popup.ts         # Toolbar popup controls & settings
│   ├── build.mjs            # esbuild build script
│   └── manifest.json        # Manifest V3 extension configuration
└── AGENTS.md                # Architecture, engine rules, & developer notes
```

---

## License

This project is licensed under the [MIT License](LICENSE).
