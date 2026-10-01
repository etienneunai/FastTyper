# FastTyper Model Eval — Prompt Presets × Thinking Mode

Date: 2026-08-14 · Daemon: `http://127.0.0.1:8808` · Model: `dyslexic-writer-qwen3-4b-q4_k_m.gguf`
Generation: `temperature: 0`, `max_tokens: 2048`, `chat_template_kwargs.enable_thinking: <true|false>`.
All 90 requests succeeded (no network errors); per-request timeout 120s. Raw per-request records are in the harness output (not committed).

Corpus (10 items): 1 `teh`→the · 2 `correctuobns`→corrections · 3 `poiint`→point · 4 `aupple`→apple ·
5 `son much betternow`→so much better now · 6 `its working`→it's working · 7 `youree`→your ·
8 `what a sahme`→what a shame · 9 full sentence (contains `correctuobns`, `poiint`) ·
10 already-correct sentence (must not be corrupted).

**Pass** = corrected output contains the expected text (whitespace-collapsed, case-insensitive); item 9 requires both `corrections` **and** `point`.

## Matrix: preset × thinking (10 items each)

| Config | Preset | Thinking | Pass | Avg (s) | Med (s) | Max (s) | Empty | Truncated |
|---|---|---|---|---|---|---|---|---|
| A (prod)  think=off | A | off | 6/10 | 0.36 | 0.24 | 1.32 | 0 | 0 |
| A (prod)  think=on  | A | on  | 6/10 | 0.51 | 0.39 | 1.48 | 0 | 0 |
| B (gram)  think=off | B | off | 6/10 | 0.38 | 0.24 | 1.40 | 0 | 0 |
| B (gram)  think=on  | B | on  | 6/10 | 0.52 | 0.38 | 1.58 | 0 | 0 |
| C (clean) think=off | C | off | 6/10 | 0.41 | 0.24 | 1.36 | 0 | 0 |
| C (clean) think=on  | C | on  | 7/10 | 22.93 | 15.34 | 91.59 | **1** | **1** |
| E (proof) think=off | E | off | 6/10 | 0.36 | 0.22 | 1.36 | 0 | 0 |
| E (proof) think=on  | E | on  | **9/10** | 12.28 | 9.69 | 29.59 | 0 | 0 |

All thinking=off configs (and A/B with thinking=on) fail the **same 4 items**: 2 (`correctuobns`), 5 (`betternow` run-together), 7 (`youree`), 9 (in-sentence `correctuobns`). They correctly fix the single-letter swaps (1, 3, 4, 8) and leave correct text alone (6, 10).

## Thinking-mode behavior

- **E (proof) + thinking is the only config that fixes the hard cases**: 6/10 → 9/10. It fixes `correctuobns`, the run-together `betternow`, and the in-sentence typo item 9 (`That is not what we want. It only makes those corrections after a bullet point. btw, still not working on new lines.`). Its only "miss" is item 7.
- **Item 7 is a corpus ambiguity, not a model failure**: every config returns `you're` (even E+thinking), but the expected key is `your`. The practical ceiling is higher than the raw pass count suggests.
- **Thinking is prompt-gated**. With the simple A/B prompts (spelling-only, "if no mistakes output unchanged"), `enable_thinking: true` produced **zero** `reasoning_content` and ~identical latency — the model short-circuits and answers directly. The C/E prompts (proofreader/cleaner) make it deliberate (10/10 with `reasoning_content`).
- **Runaway thinking is real**: C+thinking on item 2 (`correctuobns`) spent **91.6s**, exhausted all 2048 tokens, and returned **empty content** (`finish_reason: length`) — a silent no-op. E+thinking never hit this in the sample but its reasoning blocks ran 2.6k+ chars, so the risk is not E-specific.
- The daemon runs `--reasoning off` in `backend/fasttyper.service`, yet thinking still activated — the per-request `chat_template_kwargs.enable_thinking: true` overrides the server default.

## Prompt-variant hypotheses (base = E, thinking=off, items 2,3,4,5,9)

| Variant | Pass/5 | Notes |
|---|---|---|
| E plain (baseline) | 2/5 | fixes 3, 4 only |
| E + dyslexic instruction ("Watch especially for transposed, doubled, dropped letters…") | 2/5 | same failures as plain E — **no improvement** |
| E + two few-shot examples ("correctuobns → corrections; poiint → point…") | **3/5** | now fixes 2 (`correctuobns`); still misses 5 (run-together) and 9 (in-sentence) |

Two prompt-construction findings:

1. **Naive placement causes echo**: when the added instruction was appended immediately before `{text}` (same paragraph), the model echoed the instruction ("Watch especially for transposed letters, doubled letters, a…") instead of correcting. Keeping the instruction in the prompt body, with the input clearly last, avoids the echo.
2. **Few-shot > generic instruction**: a concrete example of the exact typo pattern fixed it at near-zero latency; a generic "watch for dyslexic patterns" hint did nothing. But the fix does **not generalize** — the same typo inside item 9's sentence stayed uncorrected.

## Reasoning-budget control (per-request — "lowest thinking")

The llama-server the daemon runs supports a **per-request** thinking budget (verified in source `tools/server/server-common.cpp`, request-body parsing at ~line 1332, and empirically):

| Request-body field | Effect |
|---|---|
| `chat_template_kwargs.enable_thinking` (bool) | Master on/off switch for the thinking block |
| `reasoning_budget_tokens` (int) | **Per-request cap** on reasoning tokens (alias `thinking_budget_tokens`); falls back to server `--reasoning-budget` |
| `reasoning_budget_message` (str) | Text injected right before the forced end-of-thinking tag when the budget is exhausted (e.g. "Stop reasoning and answer now.") |
| `reasoning_effort: "none"` | OAI-compat way to force `enable_thinking=false` |

`--reasoning-budget N` on the daemon is the global default (0 = immediate end, -1 = unrestricted, N>0 = cap); the per-request field overrides it. When the budget is exhausted the sampling layer **force-emits the end-of-thinking tag**, so the model cannot burn the whole `max_tokens` budget on reasoning and return an empty answer.

Empirical budget sweep (E preset, `enable_thinking: true`, on the hard items 2/5/9):

| Budget | Latency (items 2/5/9) | Fixes? | Notes |
|---|---|---|---|
| 0 | 0.2–0.7s | no | **Broken** — emits junk `<think></think>` tags |
| 16 | 1.1–2.2s | no | too low to catch `correctuobns` |
| 64 | 3.3–4.3s | item 5 only | |
| **256** | **6.0–12.5s** | **all three** | sweet spot; caps item 9's runaway (29.6s → 12.5s) |
| 512 | 8.2–16.4s | all three | no better than 256, just slower |

The budget is a cap, not a target — the model stops reasoning early when it's satisfied (e.g. item 2 used only ~205 of 512). And the cap **eliminates the no-op failure mode**: C+thinking on `correctuobns` went from 91.6s / empty content / `finish_reason=length` (unbudgeted) to 6–12s / real content / `stop` at budget 128–256 — though C still returns `correctuobns` unchanged, i.e. the budget saves the request but not C's prompt weakness.

So "lowest thinking, only when needed" is fully achievable today, per request: keep `enable_thinking: false` as the default and, on a no-op/missed correction, retry once with `enable_thinking: true` + `reasoning_budget_tokens: 256`. No daemon restart or config change required.

**Thinking-mode outputs are not deterministic at `temperature: 0`.** The same request (`correctuobns`, E, thinking on, budget 256) returned `corrections` 2/3 times and `correctuobns` 1/3, with differing reasoning blocks (606 vs 497 chars). Non-thinking requests were fully deterministic in the matrix (every config failed the identical 4 items). Practical consequence: a single thinking retry is a *probabilistic* rescue (~2/3 here), so a "no-op → retry with thinking" path may occasionally need a second attempt, or should fall back to leaving the text untouched rather than looping forever.

## Recommendation

**Permit thinking, but gate it — do not turn it on for every correction.** E+thinking is the only configuration that fixes the hard dyslexic cases (6/10 → 9/10), but at 10–30s per correction it is a non-starter for real-time keystroke corrections. Use it as an explicit fallback path: on a missed correction (identity/no-op result from the fast path) or a manual "recheck", retry once with the E preset + thinking on.

The three facts that drive the ranking: (1) thinking quality is **prompt-gated** — it only helps when the prompt induces deliberation (E 6→9, C 6→7; A/B get nothing); (2) thinking's failure mode (empty no-op) is fully preventable with a per-request `reasoning_budget_tokens` cap; (3) the fast path's real weaknesses are a few specific dyslexic patterns, and few-shot examples fix the exact illustrated pattern at zero latency cost.

## Ranked approaches (strengths / weaknesses)

### 1. Gated E + budget-capped thinking — BEST quality, low risk
Default fast path (E, thinking off) + retry *only* a no-op/missed correction once with `enable_thinking: true` + `reasoning_budget_tokens: 256`.
- **Strengths**: highest measured quality (9/10, only "miss" is the ambiguous `youree`→`you're`); catches transposed/dropped letters, run-together words, and in-sentence typos that nothing else fixes; budget cap makes the retry safe (no runaway, no empty output; caps worst-case to ~12s); gating keeps the typing path at ~0.2–0.4s.
- **Weaknesses**: retry path still 6–13s (only hits when the fast path no-ops, so rare); requires the request to carry `reasoning_budget_tokens` and the plugin to detect a no-op and issue a second request (neither exists in the current plugin/extension code); a thinking retry is probabilistic (~2/3 on the hardest case), so the retry logic must cap attempts rather than assume a single retry always fixes it.

### 2. E + few-shot examples, thinking off — best fast-path win
- **Strengths**: ~0.4s, recovered the transposed-letter `correctuobns` case (2/5 → 3/5 on the hard subset) with zero latency cost; deterministic and safe; tiny prompt change.
- **Weaknesses**: pattern-specific — does not generalize to run-together words or in-sentence typos; the example typo still goes unfixed inside a sentence (item 9).

### 3. Status quo (A/B/C/E, thinking off, no few-shot) — baseline
- **Strengths**: ~0.2–0.4s; never corrupts correct text (item 10 clean in every config).
- **Weaknesses**: all presets fail the identical 4 hard items; item 7 shows it can "correct" to the wrong homophone (`youree`→`you're`). 6/10 ceiling.

### 4. Global E + thinking (unbudgeted)
- **Strengths**: 9/10 quality on every item; zero logic changes.
- **Weaknesses**: 10–30s per correction (item 9: 29.6s) — untenable for real-time typing; unbudgeted reasoning risks empty no-ops on harder inputs. Only viable if latency is irrelevant.

### 5. C + thinking, or budget=0 — not recommended
- **Strengths**: the budget still rescues the runaway (91.6s/empty → 6–12s/content).
- **Weaknesses**: C is the weakest prompt — even with 256-token thinking it returns `correctuobns` unchanged (7/10 ceiling); it produced the only empty/truncated output in the matrix. budget=0 is broken (junk `<think></think>`). A/B + thinking is safe but useless (0 reasoning emitted, no quality gain).

**Bottom line**: enable thinking per-request, gated and budget-capped (approach 1) for the last-mile quality, with the few-shot E prompt (approach 2) as the cheap immediate win on the default path. Do not enable thinking globally, do not use C as a thinking prompt, and never set the budget to 0.
