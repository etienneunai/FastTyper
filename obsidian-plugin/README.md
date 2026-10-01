# FastTyper Obsidian Plugin

Real-time, local grammatical error correction and spelling correction for Obsidian powered by a local `llama.cpp` daemon.

## Features

- **Real-Time Trigger**: Intercepts completed sentences as you type (`.`, `?`, `!`) or completed lines (Enter).
- **In-Place Corrections**: Uses character-level LCS diffing to underline and replace only the affected words.
- **Markdown Protection**: Automatically masks markdown headings, bullets, code blocks, and LaTeX math so formatting is never destroyed.
- **Thinking Mode**:
  - `Fast`: Flat inference (~0.4s).
  - `Auto`: Flat inference first, escalating to Qwen3 thinking only when no-op or suspect non-dictionary words are detected.
  - `Always`: Full reasoning on every sentence.
- **Offline Wordlist**: Uses a compressed bundled dictionary (~275k words) with English inflection suffix stemming.
- **Revert & Accept UI**: Click the hover tooltip on any corrected word to revert it, or use hotkey commands to Accept All.

## Installation

1. Make sure the FastTyper backend is running (`http://127.0.0.1:8808`). See the repository root `README.md`.
2. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
3. Copy `main.js`, `manifest.json`, and `styles.css` to your Obsidian vault at `.obsidian/plugins/fasttyper/`.
4. Enable **FastTyper** in Obsidian Community Plugins.

## Hotkey Commands

- `fasttyper:accept-all-corrections` — Commit all corrections and remove underlines.
- `fasttyper:toggle-corrections` — Pause or resume correction triggers.
- `fasttyper:cycle-thinking-mode` — Cycle between Fast, Auto, and Always thinking modes.
- `fasttyper:halt-corrections` — Discard in-flight requests and clear processing indicators.
