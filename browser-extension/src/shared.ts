/**
 * FastTyper shared engine + message types.
 *
 * The string-only pieces here are ported verbatim from the Obsidian plugin
 * (`obsidian-plugin/src/main.ts`) so both consumers behave identically: same
 * trigger heuristics, same LCS diff, same capitalization, same model call.
 */

// Default fallbacks used by background/popup settings
export const DEFAULT_LLM_BASE = "http://127.0.0.1:8808";
export const DEFAULT_MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf";

/** Wait after a trigger char insertion to make sure the user didn't delete it. */
export const TRIGGER_VERIFY_MS = 100;
/** Skip units longer than this (sentences are short; keeps the 4B model's latency sane). */
export const MAX_UNIT_CHARS = 800;
export const MIN_UNIT_CHARS = 3;

/**
 * Thinking mode: "fast" = flat inference only; "auto" = flat first, escalate
 * once to E + thinking only if flat changes nothing; "always" = E + thinking
 * on every request. Mirrors the Obsidian plugin's `thinkingMode`.
 */
export type ThinkingMode = "fast" | "auto" | "always";

/** Per-request reasoning-budget cap (tokens) — the eval's runaway-prevention fix. */
export const THINKING_BUDGET = 256;

/** Common abbreviations whose trailing period is not a sentence end. */
export const ABBREVIATIONS = new Set([
  "e.g.", "i.e.", "etc.", "Mr.", "Mrs.", "Ms.", "Dr.", "St.", "vs.", "no.",
]);

/** One edit produced by the diff: [from, to) in the sent text, replaced with `replacement`. */
export interface DiffHunk {
  from: number;
  to: number;
  replacement: string;
}

/** One applied correction: offsets into the current field text. */
export interface AppliedCorrection {
  from: number;
  to: number;
  originalText: string;
  replacement: string;
}

// ---------------------------------------------------------------------------
// Response parsing + diff (dependency-free, ported from main.ts)
// ---------------------------------------------------------------------------

/** Strip Qwen3 `<think>` blocks (and any unclosed tail) and tidy the reply. */
export function parseResponse(content: string): string | null {
  let s = content.replace(/<think[\s\S]*?<\/think>/g, "");
  const openIdx = s.indexOf("<think");
  if (openIdx !== -1) s = s.slice(0, openIdx);
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  const fenced = s.match(/^```[\s\S]*?```$/);
  if (fenced) s = s.slice(3, -3).trim();
  return s.length > 0 ? s : null;
}

// Maximum real usage: (MAX_UNIT_CHARS + 1) × (MAX_UNIT_CHARS * 2 + 201) = 801 × 1801 = 1,442,601
const MAX_CHAR_DIFF_CELLS = 1_443_000;
const diffBuffer = new Int32Array(MAX_CHAR_DIFF_CELLS);

/**
 * Char-level LCS diff of two strings → minimal, ordered hunks `{from,to,replacement}`
 * relative to `a`. Cells are capped; oversized inputs fall back to one whole-region replace.
 */
export function charDiff(a: string, b: string): DiffHunk[] {
  const n = a.length, m = b.length;
  // Guard uses (n+1)*(m+1) — the actual cell count including boundary rows/columns.
  if ((n + 1) * (m + 1) > MAX_CHAR_DIFF_CELLS) return a === b ? [] : [{ from: 0, to: n, replacement: b }];

  const width = m + 1;
  const dp = diffBuffer;
  for (let j = 0; j <= m; j++) dp[n * width + j] = 0;
  for (let i = 0; i <= n; i++) dp[i * width + m] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a.charCodeAt(i) === b.charCodeAt(j)
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0, j = 0;
  let hStart: number | null = null;
  let hRepl = "";
  const flush = () => {
    if (hStart !== null) {
      hunks.push({ from: hStart, to: i, replacement: hRepl });
      hStart = null;
      hRepl = "";
    }
  };
  while (i < n && j < m) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) {
      flush();
      i++; j++;
    } else {
      if (hStart === null) hStart = i;
      if (dp[i * width + j + 1] >= dp[(i + 1) * width + j]) { hRepl += b[j]; j++; }
      else { i++; }
    }
  }
  if (i < n || j < m) {
    if (hStart === null) hStart = i;
    hRepl += b.slice(j);
    i = n; j = m;
  }
  flush();
  return hunks;
}

/** Diff `a` → `b`, dropping identity and whitespace-only noise hunks. */
export function diffWords(a: string, b: string): DiffHunk[] {
  return charDiff(a, b).filter((h) => {
    const orig = a.slice(h.from, h.to);
    if (orig === h.replacement) return false;
    if (orig.trim() === "" && h.replacement.trim() === "" && orig.length === h.replacement.length) return false;
    return true;
  });
}

/** Capitalize the sentence-initial letter (lowercase a-z first char only), if enabled. */
export function capitalizeInitial(corrected: string, enabled: boolean): string {
  if (!enabled || corrected.length === 0) return corrected;
  const c0 = corrected[0];
  if (c0 >= "a" && c0 <= "z") return c0.toUpperCase() + corrected.slice(1);
  return corrected;
}

const CONTEXT_CHARS = 10;

/** `…before[original]after…` — the typo/removed text bracketed, with a little context. */
export function contextSnippet(text: string, from: number, to: number, original: string, replacement: string): string {
  const before = text.slice(Math.max(0, from - CONTEXT_CHARS), from);
  const after = text.slice(to, Math.min(text.length, to + CONTEXT_CHARS));
  const core = original || replacement; // insertions have no original; show the added text
  const leftWs = before.match(/\s*$/)?.[0] ?? "";
  const rightWs = after.match(/^\s*/)?.[0] ?? "";
  const bText = before.slice(0, before.length - leftWs.length);
  const aText = after.slice(rightWs.length);
  const lead = leftWs.length > 0 || from === 0 ? "" : "…";
  const trail = rightWs.length > 0 || to >= text.length ? "" : "…";
  const tag = original === "" ? " (added)" : "";
  return lead + bText + "[" + core + "]" + aText + trail + tag;
}

// ---------------------------------------------------------------------------
// Selectable prompt presets (ported from main.ts PROMPT_PRESETS + activePrompt)
// ---------------------------------------------------------------------------

export interface PromptPreset {
  id: string;
  name: string;
  system: string;
  user: string;
}

/** id used to select the Custom prompt (editable system/user templates). */
export const CUSTOM_PROMPT_ID = "custom";

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "A",
    name: "A — prod",
    system: "You are a spelling correction assistant.",
    user: "Fix any spelling mistakes in this text. If there are no mistakes, output the text unchanged.\n\n{text}",
  },
  {
    id: "B",
    name: "B — gram",
    system: "You are a spelling and grammar correction assistant.",
    user: "Fix any spelling mistakes, missing spaces, and a/an errors in this text. If there are no mistakes, output the text unchanged.\n\n{text}",
  },
  {
    id: "E",
    name: "E — proof",
    system: "You are a careful proofreader.",
    user: "Fix only clear errors: misspellings, run-together words, missing apostrophes, and a/an agreement. Never reword, restyle, or alter correct text. Reply with only the corrected text.\n\n{text}",
  },
  {
    id: "C",
    name: "C — clean",
    system: "You are an English text cleaner.",
    user: "Insert missing spaces between run-together words, fix spelling and a/an errors. Return only the corrected text.\n\n{text}",
  },
];

/** A resolved system message + user template pair, ready for the payload. */
export interface ActivePrompt {
  system: string;
  user: string;
}

/** The active pair for a stored `promptId` + custom fields (mirrors obsidian `activePrompt()`). */
export function resolvePrompt(promptId: string, customSystem: string, customUser: string): ActivePrompt {
  if (promptId === CUSTOM_PROMPT_ID) return { system: customSystem, user: customUser };
  return PROMPT_PRESETS.find((p) => p.id === promptId) ?? PROMPT_PRESETS[0];
}

// ---------------------------------------------------------------------------
// LLM payload (ported from main.ts request())
// ---------------------------------------------------------------------------

/**
 * The body sent to the daemon. `text` is the bare sentence/line, already trimmed.
 * When `thinking` is true the request uses the E (proof) preset with Qwen3
 * thinking enabled and a reasoning_budget_tokens cap — the config the eval
 * matrix proved fixes the hard dyslexic cases that flat inference leaves
 * unchanged. Keep in sync with obsidian-plugin/src/main.ts request().
 */
export function buildPayload(model: string, text: string, prompt: ActivePrompt, thinking: boolean): Record<string, unknown> {
  return {
    model: model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user.split("{text}").join(text) },
    ],
    temperature: 0,
    max_tokens: thinking ? 2048 : Math.min(2048, Math.ceil(text.length / 3) + 256),
    chat_template_kwargs: { enable_thinking: thinking },
    ...(thinking ? { reasoning_budget_tokens: THINKING_BUDGET } : {}),
  };
}

// ---------------------------------------------------------------------------
// Content ⇄ background ⇄ popup message protocol
// ---------------------------------------------------------------------------

export type Request =
  | { type: "correct"; text: string; thinking: boolean }
  | { type: "acceptAll" }
  | { type: "halt" }
  | { type: "checkSuspects"; text: string }
  | { type: "getState" }
  | { type: "setPaused"; paused: boolean }
  | { type: "setCapitalize"; value: boolean }
  | { type: "setPrompt"; promptId: string }
  | { type: "setCustomSystem"; value: string }
  | { type: "setCustomUser"; value: string }
  | { type: "setBlacklist"; blacklist: string[] }
  | { type: "setThinkingMode"; thinkingMode: ThinkingMode }
  | { type: "setLlmBase"; value: string }
  | { type: "setModel"; value: string }
  | { type: "getLog" };

export type Response =
  | { type: "correctResult"; corrected: string | null }
  | { type: "checkSuspectsResult"; suspects: boolean }
  | { type: "state"; paused: boolean; capitalize: boolean; blacklist: string[]; daemonUp: boolean | null; promptId: string; customSystem: string; customUser: string; thinkingMode: ThinkingMode; llmBase: string; model: string }
  | { type: "log"; entries: string[] };

export interface LogEntry {
  ts: string;
  url?: string;
  sent: string;
  received: string;
}

/** Push-to-content-script settings/command messages (not request/response). */
export type PushMsg =
  | { type: "settings"; paused: boolean; capitalize: boolean; blacklist: string[]; thinkingMode: ThinkingMode }
  | { type: "acceptAll" }
  | { type: "halt" };

// ---------------------------------------------------------------------------
// Markdown Masking
// ---------------------------------------------------------------------------

export const MARKDOWN_REGEX = /```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|^---\n[\s\S]*?\n---|!\[\[.*?\]\]|\[\[.*?\]\]|\]\(.*?\)|^[ \t]*#{1,6}\s|^[ \t]*>\s|^[ \t]*[-*+]\s|^[ \t]*\d+\.\s|\*\*|__|==|~~|\*|_|\[|\]/gm;

export function maskMarkdown(text: string): { masked: string, maskChars: string[] } {
  const maskChars: string[] = [];
  const masked = text.replace(MARKDOWN_REGEX, (match) => {
    for (const char of match) maskChars.push(char);
    return '█'.repeat(match.length);
  });
  return { masked, maskChars };
}

export function restoreMarkdown(corrected: string, maskChars: string[]): string | null {
  let out = "";
  let maskIdx = 0;
  for (let i = 0; i < corrected.length; i++) {
    if (corrected[i] === '█') {
      if (maskIdx >= maskChars.length) return null;
      out += maskChars[maskIdx++];
    } else {
      out += corrected[i];
    }
  }
  if (maskIdx !== maskChars.length) return null;
  return out;
}
