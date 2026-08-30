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
   - **Auto** (default): Runs flat inference first. If the output is unchanged (a no-op) or contains suspect non-dictionary tokens (checked against the bundled ~275k `wordlist.json`), it escalates **once** to Preset E with Qwen3 thinking enabled (`reasoning_budget_tokens: 256`, ~6–12s).
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
| `dyslexic-writer-qwen3-4b-q4_k_m.gguf` | ~2.5 GB | **Primary.** Qwen3-4B fine-tune purpose-built for spelling/grammar correction: ~85.6% exact match, ~99.3% leaves correct text untouched. |
| `qwen2.5-0.5b-instruct-q8_0.gguf` | ~645 MB | Legacy fallback model. |
| `dyslexic-writer` 1.7B variant | ~1.1 GB | Faster fallback (~82.2% exact match) if latency on 4B is too high. |

### Download Model & Build llama.cpp

Run the backend setup script:

```bash
cd backend
bash setup.sh
```

`setup.sh` downloads the primary model to `~/.local/share/models/`, builds `llama.cpp` with Vulkan support (`~/.local/src/llama.cpp`), and installs `llama-server` and its shared libraries to `/usr/local`.

Or download the model manually:

```bash
mkdir -p ~/.local/share/models/
wget -c -O ~/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf \
  "https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"
```

---

## Backend (llama.cpp Daemon)

The backend runs as a systemd user service listening on `http://127.0.0.1:8808/v1/chat/completions`.

### 1. Enable & Start the Service

```bash
# Symlink service file to systemd user directory
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/backend/fasttyper.service" ~/.config/systemd/user/fasttyper.service

# Reload and start service
systemctl --user daemon-reload
systemctl --user enable --now fasttyper

# Inspect daemon logs
journalctl --user -u fasttyper -f
```

Verify Vulkan offload engaged (check for `/dev/dri/renderD*` usage and no `no usable GPU found` warnings).

> [!NOTE]
> `backend/fasttyper.service` is preconfigured to bind to AMD Vulkan drivers (`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json`) to run on integrated GPUs (e.g. Radeon 780M) to save discrete GPU battery and thermals. If running on Intel or Nvidia hardware, modify or remove `VK_ICD_FILENAMES` in `fasttyper.service` or override via `~/.config/fasttyper/config`.

### 2. Regression & Corpus Evaluation

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
npm install --legacy-peer-deps
npm run build
```

Copy the build output and **runtime wordlist** to your Obsidian vault:

```bash
mkdir -p ~/path/to/YourVault/.obsidian/plugins/fasttyper/
cp -r {main.js,manifest.json,styles.css,wordlist.json} ~/path/to/YourVault/.obsidian/plugins/fasttyper/
```

> [!IMPORTANT]
> `wordlist.json` is a **required runtime asset** (~275k English words). It is loaded asynchronously at plugin startup and powers the suspect-token dictionary check for Auto Thinking Mode escalation. Always copy `wordlist.json` alongside `main.js`.

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
- **Shortcuts**: `Ctrl+Shift+F` (Pause/Resume), `Ctrl+Shift+E` (Halt in-flight request and abort daemon connection).

### Build & Load in Firefox

```bash
cd browser-extension
npm install
npm run build
```

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select `browser-extension/dist/manifest.json`.

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
│   ├── fasttyper.service    # Systemd user service unit
│   ├── setup.sh             # Model download & Vulkan llama.cpp build
│   ├── eval-corpus.sh       # Regression & latency evaluation script
│   └── corpus.txt           # Eval benchmark dataset
├── obsidian-plugin/
│   ├── src/main.ts          # Core CM6 plugin logic & settings
│   ├── styles.css           # Applied & processing underlines
│   └── wordlist.json        # Bundled ~275k dictionary for Auto mode
├── browser-extension/
│   ├── src/shared.ts        # Shared diff, mask, and prompt engine
│   ├── src/background.ts    # Service worker & daemon HTTP bridge
│   ├── src/content.ts       # DOM input watcher, caret mapper & UI
│   ├── src/popup.ts         # Toolbar popup controls & settings
│   └── wordlist.json        # Bundled dictionary for extension Auto mode
└── AGENTS.md                # Architecture, engine rules, & developer notes
```

---

## Privacy

FastTyper is 100% local. No telemetry, no cloud APIs, no external network requests. All inference is processed directly on your local GPU daemon.
