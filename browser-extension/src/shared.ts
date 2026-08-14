/**
 * FastTyper shared engine + message types.
 *
 * The string-only pieces here are ported verbatim from the Obsidian plugin
 * (`obsidian-plugin/src/main.ts`) so both consumers behave identically: same
 * trigger heuristics, same LCS diff, same capitalization, same model call.
 */

export const LLM_URL = "http://127.0.0.1:8808/v1/chat/completions";
export const LLM_BASE = "http://127.0.0.1:8808";
export const MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf";

/** Wait after a trigger char insertion to make sure the user didn't delete it. */
export const TRIGGER_VERIFY_MS = 100;
/** Skip units longer than this (sentences are short; keeps the 4B model's latency sane). */
export const MAX_UNIT_CHARS = 800;
export const MIN_UNIT_CHARS = 3;

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

const MAX_CHAR_DIFF_CELLS = 4_000_000;

/**
 * Char-level LCS diff of two strings → minimal, ordered hunks `{from,to,replacement}`
 * relative to `a`. Cells are capped; oversized inputs fall back to one whole-region replace.
 */
export function charDiff(a: string, b: string): DiffHunk[] {
  const n = a.length, m = b.length;
  if (n * m > MAX_CHAR_DIFF_CELLS) return a === b ? [] : [{ from: 0, to: n, replacement: b }];

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
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
    if (orig === h.replacement) return false;                       // identity
    if (orig.trim() === "" && h.replacement.trim() === "") return false; // whitespace churn
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
// LLM payload (ported from main.ts request())
// ---------------------------------------------------------------------------

/** The body sent to the daemon. `text` is the bare sentence/line, already trimmed. */
export function buildPayload(text: string): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a spelling correction assistant." },
      { role: "user", content: "Fix any spelling mistakes in this text. If there are no mistakes, output the text unchanged.\n\n" + text },
    ],
    temperature: 0,
    max_tokens: Math.min(2048, Math.ceil(text.length / 3) + 256),
    // Force-disable Qwen3 thinking mode (template enable_thinking=false).
    // Keep in sync with obsidian-plugin/src/main.ts request().
    chat_template_kwargs: { enable_thinking: false },
  };
}

// ---------------------------------------------------------------------------
// Content ⇄ background ⇄ popup message protocol
// ---------------------------------------------------------------------------

export type Request =
  | { type: "correct"; text: string }
  | { type: "acceptAll" }
  | { type: "getState" }
  | { type: "setPaused"; paused: boolean }
  | { type: "setCapitalize"; value: boolean }
  | { type: "setBlacklist"; blacklist: string[] }
  | { type: "getLog" };

export type Response =
  | { type: "correctResult"; corrected: string | null }
  | { type: "state"; paused: boolean; capitalize: boolean; blacklist: string[]; daemonUp: boolean | null }
  | { type: "log"; entries: string[] };

export interface LogEntry {
  ts: string;
  url?: string;
  sent: string;
  received: string;
}

/** Push-to-content-script settings/command messages (not request/response). */
export type PushMsg =
  | { type: "settings"; paused: boolean; capitalize: boolean; blacklist: string[] }
  | { type: "acceptAll" };
