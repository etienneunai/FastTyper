# FastTyper — Model Quality: Thinking Modes + In-flight Indicator

## Context

**What happened:** The newline trigger was instrumented and traced (v1.1.2/v1.1.3). The trigger fires correctly — the real gap was that **flat inference returns the user's test typos unchanged** (`correctuobns`, `poiint`, `aupple`, `son much betternow`), so no visible correction occurs. A background agent ran a full eval matrix (`model-eval-results.md`, `backend/eval-corpus.sh`) that found:

- Every thinking=off config scores **6/10**, failing the same 4 hard dyslexic items.
- **E (proof) + thinking = 9/10**, fixing `correctuobns`, run-together words, and in-sentence typos — but at ~6–12.5s/sentence vs ~0.4s flat.
- The runaway/no-op failure (C+thinking: 91.6s → empty) is **fully preventable** with the per-request `reasoning_budget_tokens: 256` cap. Budget 0 is broken; 256 is the sweet spot. `max_tokens` must be **2048** (current `len/3+256` ≈ 300 truncates thinking).
- Thinking at `temperature: 0` is **not deterministic** (~2/3 on the hardest case) → never loop-retry; accept a thinking no-op.
- Thinking is prompt-gated (A/B ignore it; only E/C deliberate), so the thinking path always uses the **E (proof)** system/user.

**User's decisions:**
1. Thinking is a **standalone 3-state control** (`Fast / Auto / Always`, default **Auto**), separate from the Prompt dropdown.
2. **Auto** = flat attempt first (~0.4s); only if flat changes *nothing* does it escalate to E+thinking (~6–12s). Simple typos stay fast; hard typos **and** clean sentences take the slow pass (clean text is indistinguishable from a missed typo pre-model).
3. **Always** = E+thinking on every trigger, no fast attempt. **Fast** = current flat-only behavior.
4. **When processing, underline the entire unit being corrected** (with a subtle animation while thinking — CSS pulse, cheap).

## Changes

### 1. Obsidian plugin — `obsidian-plugin/src/main.ts`

**Setting `thinkingMode: "fast" | "auto" | "always"`** (default `"auto"`, persisted like the existing pause/capitalize state):
- Module-level `let thinkingMode: "fast"|"auto"|"always" = "auto";`, loaded in `onload()` (~line 792–797) and saved on change via `saveData`.
- New command `fasttyper:cycle-thinking-mode` (hotkey-able): cycles fast→auto→always→fast with a `Notice` showing the new mode (mirrors `toggle-corrections`).
- `FastTyperSettingTab`: a **dropdown** "Thinking mode" (Fast / Auto / Always) **separate from the Prompt dropdown**; helper text noting Auto ≈ "flat first, think only if unchanged".

**`request()` — pick payload by mode** (~line 651–666). Add a `thinking: boolean` param:
```ts
private async request(text: string, signal: AbortSignal, thinking: boolean): Promise<string | null> {
  const prompt = thinking ? PROMPT_PRESETS.find(p => p.id === "E")! : activePrompt();
  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user.split("{text}").join(text) },
    ],
    temperature: 0,
    max_tokens: thinking ? 2048 : Math.min(2048, Math.ceil(text.length / 3) + 256),
    chat_template_kwargs: { enable_thinking: thinking },
    ...(thinking ? { reasoning_budget_tokens: 256 } : {}),
  };
  ...
}
```

**`fire()` — mode dispatch + in-flight span** (~line 591–640):
- Add a local `let thinking = thinkingMode === "always";` before the retry loop. Inside the loop, the current `if (corrected === text) return;` (line 621) becomes:
  ```ts
  if (corrected === text) {
    if (thinkingMode === "auto" && !thinking) { thinking = true; continue; } // escalate once
    return; // no change — accept (thinking is non-deterministic, don't loop)
  }
  ```
- **In-flight indicator:** dispatch a StateEffect at the top of `fire()` marking `this.pending`'s mapped span `{from, to}` as processing, and clear it in `finally` (line 634–638). While the thinking pass is active the decoration is styled to pulse.

**In-flight underline (new StateField):**
- `export const setProcessing = StateEffect.define<{from:number;to:number} | null>();`
- A `processingField` StateField holding `{from,to} | null`, mapping the stored span through each `tr.changes` in its `update()` (same mapping as `this.pending` at line 387), producing a `Decoration.mark` over `[from, to)` — a distinct **orange/amber wavy or dashed underline** (CSS `.ft-processing`), with a gentle opacity pulse animation while active. Provide via `EditorView.decorations.from`.
- `update()` must skip re-triggering while this effect is present (add `isProcessing` to the existing `isAutoApply`-style guard so the processing effect's own dispatch doesn't retrigger) — simplest: extend the effect check in `update()` (line 395) to include `setProcessing`.
- `styles.css`: `.ft-processing` (amber underline) — visually distinct from the blue wavy `.ft-correction` applied mark; include the pulse keyframes.

### 2. Browser extension — keep in sync

- `shared.ts` `buildPayload(text, prompt, thinking: boolean)` → same payload logic (E prompt + budget 256 + 2048 when thinking). No `PromptPreset` change needed.
- `background.ts` `Settings`: add **`thinkingMode: "fast"|"auto"|"always"`** (default `"auto"`). New `setThinkingMode` handler. `correct()` computes `thinking` per mode and passes it to `buildPayload`.
- `content.ts` `fire()`-equivalent: mirror the flat→thinking escalation (only `auto`), and show a **transient "FastTyper…" pill** while a request is in flight (textareas can't inline-underline; contenteditable already has span machinery — reuse `ft-correction` styling for an amber processing span if cheap, else just the pill).

### 3. Regression harness + docs

- Add `backend/corpus.txt` (the 10-item corpus) so `./backend/eval-corpus.sh -p E -t on -b 256 backend/corpus.txt` is a one-line check → expect **9/10** (item 7 `youree`→`you're` is a known corpus ambiguity, not a real failure).
- `CLAUDE.md`: document the Thinking mode control (Fast/Auto/Always + latency), the E+thinking config, and the eval-corpus command.

## Verification

1. **Build & deploy:** `npm run build` + `npx tsc --noEmit` in `obsidian-plugin/`, bump `manifest.json` → **1.1.4**, deploy to `~/gdrive/Obsidian/Main/.obsidian/plugins/fasttyper/`. Mirror build in `browser-extension/`.
2. **Daemon config check:** curl with `enable_thinking: true` + `reasoning_budget_tokens: 256` on `correctuobns` → must return `corrections` with real `reasoning_content`, `finish_reason: stop`, not empty.
3. **Eval regression:** `./backend/eval-corpus.sh -p E -t on -b 256 backend/corpus.txt` → 9/10.
4. **Manual (Obsidian):** reload, confirm v1.1.4 + Thinking mode = Auto.
   - **Auto**: type `…correctuobns after a bullet poiint…` + Enter → the unit shows the amber underline, correction (incl. `correctuobns`→`corrections`) lands after ~6–12s. Type a *simple* typo (`teh`) + Enter → fixed in <1s (no thinking pass, underline brief). Type a clean sentence + Enter → underline persists ~6–12s then clears with no change.
   - **Always**: repeat the simple typo → now also ~6–12s.
   - **Fast**: typos remain unfixed; everything ~0.4s.
   - Check `llm-log.txt`: thinking requests carry `"reasoning_budget_tokens":256`, `"enable_thinking":true`, and the E prompt; auto-mode flat requests carry the selected prompt with `enable_thinking:false`.
5. **Trigger regression:** re-test v1.1.3 newline fix — a bullet line ending with Enter (no period) must now fire (`trigger-debug.log` shows `confirm FIRE ch=\n` after a `x\n- ` insertion). Then remove the `trigger-debug.log` instrumentation once confirmed.
