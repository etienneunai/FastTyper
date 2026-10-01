# Contributing to FastTyper

Thank you for your interest in contributing to FastTyper! FastTyper is an open-source, local-first real-time grammar and spell-checking ecosystem supporting Obsidian and web browsers via a lightweight local daemon.

## Code of Conduct

Please be respectful, constructive, and collaborative in discussions, issues, and code reviews.

## Getting Started

1. **Fork and Clone** the repository:
   ```bash
   git clone https://github.com/etienneunai/FastTyper.git
   cd FastTyper
   ```
2. **Review Architecture**: Read `AGENTS.md` and component READMEs to understand the trigger detection, LCS diffing, and LLM orchestration.
3. **Set Up the Backend**:
   - See `backend/README.md` or the main `README.md` for prerequisites (CMake, C++ compiler, Vulkan or CUDA).
   - Run `backend/setup.sh` to download the default model and compile `llama-server`.
4. **Build Frontends**:
   - Obsidian plugin: `cd obsidian-plugin && npm install && npm run build`
   - Browser extension: `cd browser-extension && npm install && npm run build`

## Development Guidelines

- **Keep it fast and lightweight**: FastTyper is designed to correct text in real-time without interrupting typing flow. Avoid introducing blocking synchronous calls or heavy dependencies.
- **Privacy First**: FastTyper operates 100% locally. Never add external network telemetry or unapproved third-party API calls.
- **Engine Parity**: The diffing, sentence trigger heuristics, and prompt templates are shared between the Obsidian plugin (`obsidian-plugin/src/main.ts`) and the browser extension (`browser-extension/src/shared.ts`). Always keep core engine logic aligned.
- **Maintain `AGENTS.md`**: Whenever architecture, UI/UX behavior, service configurations, or internal rules change, update `AGENTS.md`.

## Submitting Pull Requests

1. Create a descriptive branch: `git checkout -b feature/my-enhancement`.
2. Ensure all builds pass:
   - `npm run build` in `obsidian-plugin/`
   - `npm run build` in `browser-extension/`
   - Typechecks with `tsc --noEmit`
3. Commit with concise, descriptive commit messages.
4. Submit a Pull Request targeting `main`.
