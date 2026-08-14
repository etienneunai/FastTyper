# FastTyper — Real-Time Local Grammar Correction

FastTyper is a low-latency, AI-driven grammatical error correction (GEC) daemon running entirely locally. It intercepts and corrects text in real-time without interrupting the active typing flow.

## Project Structure

The repository is broken into three main components:

### 1. `backend/` (Llama.cpp Daemon)
The inference engine serving a purpose-built spelling/grammar correction model (`dyslexic-writer-qwen3-4b-q4_k_m.gguf`, a Qwen3-4B fine-tune; the old `qwen2.5-0.5b-instruct-q8_0.gguf` is kept on disk as a fallback) over a local HTTP API.
* **`fasttyper.service`**: A systemd user service that manages the `llama-server` process. It is configured to explicitly bind to the 780M integrated graphics (Vulkan offload) using `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json` and `AMD_VULKAN_ASYNC_COMPUTE` to save discrete GPU thermals and battery life.
* **`setup.fish`**: Downloads the model and builds llama.cpp with Vulkan (`GGML_VULKAN=1`). Installs via `cmake --install` so the binary **and** its shared libs land in `/usr/local` (do not copy only the thin launcher — its code lives in the `.so` files).
* **API**: Listens on `http://127.0.0.1:8808/v1/chat/completions`.

### 2. `obsidian-plugin/` (CodeMirror 6 Frontend)
An Obsidian plugin providing real-time text replacement and visual indicators.
* **`src/main.ts`**: The core plugin file containing:
  * **Sentence Trigger**: Fires on insertion of a stopping punctuation (`.`, `?`, `!`) or a newline — not a typing-pause debounce. A 100ms `TRIGGER_VERIFY_MS` wait confirms the char wasn't deleted before the unit is captured. For punctuation the unit is the sentence ending at the trigger (with `.?!` cluster + abbreviation/decimal heuristics); for newline it's the completed line. Units over `MAX_UNIT_CHARS` (800) or containing inline/fenced code or frontmatter (Lezer `syntaxTree`) are skipped.
  * **Full-Text Corrections (diff-based)**: The model returns the corrected text as a plain string (system prompt: "You are a spelling correction assistant.", `temperature: 0`, no JSON schema). `parseResponse` strips any `<think>` blocks. `diffWords` computes a char-level LCS diff → minimal hunks, which are applied in place. Replaces the old JSON-span approach (whose no-op/near-miss spans never applied).
  * **Resend-on-conflict**: The sent span is mapped forward through every transaction (`mapSpan` with `mapPos(from, 1)` / `mapPos(to, -1)`). If the text at that span changed by response time, the plugin does NOT insert stale text — it re-sends the current text (up to `MAX_RETRIES`=3), then applies. Only one request is in flight (`isPending`); later triggers queue in a single slot. AbortController is only used on unload.
  * **Auto-Applier**: Builds a CodeMirror `ChangeSet` and maps decoration positions with `mapPos(..., -1)` so replacements get a mark, insertions start at the insertion point, and deletions (zero-width) get a widget marker — all revertible.
  * **Revert UI**: A `StateField` marks applied corrections with a blue wavy line (`styles.css`), and a `hoverTooltip` provides a clickable button to instantly revert the change back to the original typo. The tooltip shows a context snippet `…before[original]after…` (the removed/replaced text bracketed, ~10 chars either side; insertions show the added text with an `(added)` tag) — no "Revert to:" preface — with a muted "click to revert" hint.
  * **Accept all / Pause**: Two Obsidian commands (hotkey-bindable in Settings → Hotkeys): `fasttyper:accept-all-corrections` (commits every applied correction and clears the underlines via a `clearCorrections` StateEffect → `Decoration.none`) and `fasttyper:toggle-corrections` (pause/resume). Pause blocks new triggers (`this.paused` checked in `update()`/`confirmTrigger()`/`maybeFire()`/`fire()`), clears the verify timer + queued span, and aborts the in-flight request. The pause state persists to plugin data (`loadData`/`saveData`) and is pushed to every open editor's corrector via `view.plugin(grammarCheckerPlugin)?.setPaused(...)`. Toggling shows an Obsidian `Notice`. A `FastTyperSettingTab` mirrors these controls (pause toggle + "Accept all" button).
  * **Sentence-initial capitalization**: Deterministic in the plugin (`capitalizeInitial`, called on the corrected text before the identity check in `fire()`) — the model is spelling-only and won't capitalize even when the prompt asks (verified empirically). Capitalizes the first char only if it's a lowercase `a-z` letter, so quote/number/list-marker starts are left alone. Gated by a `capitalizeInitials` setting (default on, persisted with the pause state) and shown as a normal revertible diff hunk.
* **Build**: `npm run build` uses `esbuild` to compile the TypeScript. `tsc --noEmit` must also pass (see `skipLibCheck` in `tsconfig.json`).
* **Plugin id**: `fasttyper` (folder + manifest id; update `community-plugins.json` accordingly).
* **LLM Request Log**: Every exchange is appended to `/home/etienne/Projects/FastTyper/llm-log.txt` as `--- <ISO timestamp> ---\nsent:\n…\nreceived:\n…\n\n` blocks (the full JSON payload sent and the raw response body). Implemented in `logExchange()` in `src/main.ts`, which uses a lazy `require("fs")` — Obsidian's Electron renderer has Node integration and the esbuild config externalizes Node builtins, so the plugin can write outside the vault. The path is hardcoded via `LLM_LOG_PATH` (adjust if the repo moves). Non-abort fetch errors are also logged with the sent body.

### 3. `fcitx5-proxy/` (System-Wide Wayland Fallback)
*(Not implemented — scaffolding only. Do not rely on it.)*
A Python file (`fasttyper-proxy.py`) that sketches a DBus proxy for Fcitx5. It makes no DBus calls and its design premise (globally intercepting typed text over Fcitx5's DBus API) is not achievable — Wayland text interception requires the input-method protocol (`zwp_input_method_v2`). Treat as an idea, not a component.

## Development Workflow

* **Restarting the Backend Engine**:
  ```bash
  systemctl --user daemon-reload
  systemctl --user restart fasttyper
  journalctl --user -u fasttyper -f
  ```
  Verify Vulkan actually engaged (no `no usable GPU found` warning, and `/dev/dri/renderD*` is open by the process).
* **Building the Obsidian Plugin**:
  ```bash
  cd obsidian-plugin
  # (Initial setup: npm install --legacy-peer-deps)
  npm run build
  # Copy to the active vault:
  cp -r {main.js,manifest.json,styles.css} ~/gdrive/Obsidian/Main/.obsidian/plugins/fasttyper/
  ```
  Reload Obsidian (or restart) to pick up the plugin.

* **Viewing the LLM exchange log**: `tail -f llm-log.txt` in the repo root. Each request appears once the response returns; aborted/stale requests are skipped.

## AI & Prompt Details
The model (`dyslexic-writer-qwen3-4b`) outputs **full corrected text**, not JSON. The plugin sends:
- **System**: "You are a spelling correction assistant."
- **User**: "Fix any spelling mistakes in this text. If there are no mistakes, output the text unchanged.\n\n" + `<the sentence/line>`

Generation params: `temperature: 0`, `max_tokens: min(2048, text.length/3 + 256)`. No `response_format`. The model is ~2.5 GB Q4_K_M; on the 780M iGPU it runs roughly 15–30 tok/s, so `MAX_UNIT_CHARS` is kept at 800 and a sentence typically resolves in ~1–3 s. (The 1.7B `dyslexic-writer` variant, ~82.2% exact match, is a faster drop-in fallback if latency is too high.)
