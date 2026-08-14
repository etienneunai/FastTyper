/**
 * FastTyper content script.
 *
 * Ports the Obsidian plugin's trigger → correct → diff → apply → revert engine
 * (obsidian-plugin/src/main.ts) onto the DOM. Runs in every frame; only the
 * focused editable field is active at a time.
 *
 * Design notes / v1 simplifications:
 * - Textareas can't render inline decorations, so corrections there surface as
 *   a transient pill near the field with an explicit Undo button (programmatic
 *   value changes are NOT in the browser's native undo stack).
 * - Contenteditable corrections go through execCommand('insertText') (native
 *   undo works) and the changed text is wrapped in an `ft-correction` span with
 *   a hover → click-to-revert tooltip.
 * - Plain deletions (zero-width hunks) apply but get no marker in v1.
 * - Spans are not mapped through subsequent edits; if the unit changed while
 *   the request was in flight the correction is abandoned — stale text is never
 *   inserted. Units overlapping an already-applied correction are skipped too,
 *   so editing a corrected sentence again won't re-trigger a substitution.
 * - Google Docs (and similar canvas/mirrored-textarea editors: CodeMirror,
 *   Monaco, Notion-style) are skipped — their visible text isn't DOM text.
 */
import {
  TRIGGER_VERIFY_MS, MAX_UNIT_CHARS, MIN_UNIT_CHARS, ABBREVIATIONS,
  diffWords, capitalizeInitial, contextSnippet,
  type DiffHunk, type PushMsg,
} from "./shared";

// Google Docs is canvas-rendered; the visible text isn't DOM text nodes.
if (/(^|\.)docs\.google\.com$/.test(location.hostname)) {
  throw new Error("FastTyper: Google Docs uses canvas rendering — disabled.");
}

// ---------------------------------------------------------------------------
// Settings (mirrors the key background.ts uses)
// ---------------------------------------------------------------------------
let paused = false;
let capitalize = true;
/** Hostnames (or subdomains of them) where FastTyper is disabled. */
let blacklist: string[] = [];
/** True when the current page's hostname is blacklisted. */
let siteDisabled = false;

function matchesBlacklist(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return blacklist.some((e) => {
    const entry = e.trim().toLowerCase();
    return h === entry || h.endsWith("." + entry);
  });
}

/** Enable/disable the script on this page based on the blacklist. */
function applySiteState(): void {
  const disabled = matchesBlacklist(location.hostname);
  if (disabled && !siteDisabled) {
    siteDisabled = true;
    corrector.reset();
    active = null;
    dismissAllPills();
  } else if (!disabled) {
    siteDisabled = false;
  }
}

browser.storage.local.get("settings").then((got) => {
  const s = got.settings as { paused?: boolean; capitalize?: boolean; blacklist?: string[] } | undefined;
  if (s) {
    paused = !!s.paused;
    capitalize = s.capitalize !== false;
    if (Array.isArray(s.blacklist)) blacklist = s.blacklist;
  }
  applySiteState();
});

browser.runtime.onMessage.addListener((msg: PushMsg) => {
  if (msg.type === "settings") {
    paused = msg.paused;
    capitalize = msg.capitalize;
    if (Array.isArray(msg.blacklist)) blacklist = msg.blacklist;
    if (paused) corrector.reset();
    applySiteState();
  } else if (msg.type === "acceptAll") {
    acceptAll();
  }
});

// ---------------------------------------------------------------------------
// Editable-field abstraction
// ---------------------------------------------------------------------------

interface Field {
  el: HTMLElement;
  kind: "textarea" | "contenteditable";
  readText(): string;
  caret(): number;
  setCaret(pos: number): void;
  /** Paragraph/block containing `pos`, as text() offsets. */
  blockStart(pos: number): number;
  blockEnd(pos: number): number;
  /** Replace [from,to) with `insert`, returning the post-replacement caret. */
  replace(from: number, to: number, insert: string): number;
  /** Set the whole value (textarea path), firing an (untrusted) input event. */
  setValue(v: string): void;
}

/** Blank-line-delimited paragraph start for textarea-style text. */
function paraStart(text: string, pos: number): number {
  let i = pos - 1;
  while (i >= 0) {
    if (text[i] === "\n") {
      let j = i;
      while (j >= 0 && text[j] === "\n") j--;
      if (i - j >= 2) return i + 1;
    }
    i--;
  }
  return 0;
}

/** Blank-line-delimited paragraph end. */
function paraEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length) {
    if (text[i] === "\n") {
      let j = i;
      while (j < text.length && text[j] === "\n") j++;
      if (j - i >= 2) return i;
    }
    i++;
  }
  return text.length;
}

/** Native value setter so React/framework-controlled inputs pick up the change. */
const textValueSetter =
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const inputValueSetter =
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

function dispatchInput(el: HTMLElement): void {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: null }));
}

class SimpleField implements Field {
  el: HTMLElement;
  kind: "textarea" = "textarea";
  constructor(el: HTMLElement) { this.el = el; }

  readText(): string { return (this.el as HTMLTextAreaElement | HTMLInputElement).value; }
  caret(): number { return (this.el as HTMLTextAreaElement | HTMLInputElement).selectionStart ?? 0; }
  setCaret(pos: number): void {
    const el = this.el as HTMLTextAreaElement | HTMLInputElement;
    try { el.setSelectionRange(pos, pos); } catch { /* readonly-safe */ }
  }
  blockStart(pos: number): number { return paraStart(this.readText(), pos); }
  blockEnd(pos: number): number { return paraEnd(this.readText(), pos); }

  replace(from: number, to: number, insert: string) {
    const v = this.readText();
    const next = v.slice(0, from) + insert + v.slice(to);
    this.setValue(next);
    const caretAfter = from + insert.length;
    this.setCaret(caretAfter);
    return caretAfter;
  }

  setValue(v: string): void {
    const el = this.el as HTMLTextAreaElement | HTMLInputElement;
    const setter = el instanceof HTMLTextAreaElement ? textValueSetter : inputValueSetter;
    setter.call(el, v);
    dispatchInput(el);
  }
}

// ---------------------------------------------------------------------------
// Contenteditable: text model = concatenated text nodes + synthesized '\n'
// at block boundaries, plus node offsets so we can map offsets ↔ DOM.
// ---------------------------------------------------------------------------

interface ContentModel {
  text: string;
  texts: Text[];
  starts: number[];
}

const BLOCK_TAGS = /^(DIV|P|PRE|LI|H[1-6]|BLOCKQUOTE|UL|OL|TABLE|HEADER|FOOTER|SECTION|ARTICLE|TR)$/;

function buildModel(root: HTMLElement): ContentModel {
  const texts: Text[] = [];
  const starts: number[] = [];
  let out = "";
  const walk = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child as Text;
        texts.push(t);
        starts.push(out.length);
        out += t.data;
      } else if (child instanceof HTMLBRElement) {
        out += "\n";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as HTMLElement;
        const isBlock = BLOCK_TAGS.test(c.tagName);
        if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
        walk(c);
        if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
      }
    }
  };
  walk(root);
  return { text: out, texts, starts };
}

/** First index in sorted `arr` whose value is > `x`. */
function upperBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function modelCaret(root: HTMLElement, model: ContentModel): number {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.focusNode)) return model.text.length;
  const focus = sel.focusNode;
  if (!focus) return model.text.length;
  if (focus.nodeType === Node.TEXT_NODE) {
    const idx = model.texts.indexOf(focus as Text);
    if (idx !== -1) return model.starts[idx] + sel.focusOffset;
    return model.text.length;
  }
  // Element focus: approximate with the text length preceding the focused element.
  let len = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === focus || focus.contains(n)) break;
    len += (n as Text).data.length;
  }
  return len;
}

function setModelCaret(root: HTMLElement, model: ContentModel, pos: number): void {
  const idx = upperBound(model.starts, pos) - 1;
  let node: Text;
  let off: number;
  if (idx < 0 || !model.texts[idx]) {
    if (model.texts.length === 0) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    node = model.texts[0];
    off = 0;
  } else {
    node = model.texts[idx];
    off = Math.min(pos - model.starts[idx], node.data.length);
  }
  const range = document.createRange();
  range.setStart(node, off);
  range.collapse(true);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function modelRange(model: ContentModel, from: number, to: number): Range {
  const range = document.createRange();
  const i = upperBound(model.starts, from) - 1;
  const j = upperBound(model.starts, to) - 1;
  if (i < 0 || !model.texts[i]) {
    range.setStart(model.texts[0] ?? document.body, 0);
  } else {
    const n = model.texts[i];
    range.setStart(n, Math.min(from - model.starts[i], n.data.length));
  }
  if (j < 0 || !model.texts[j]) {
    range.setEnd(range.startContainer, range.startOffset);
  } else {
    const n = model.texts[j];
    range.setEnd(n, Math.min(to - model.starts[j], n.data.length));
  }
  return range;
}

class ContentEditableField implements Field {
  el: HTMLElement;
  kind: "contenteditable" = "contenteditable";
  constructor(el: HTMLElement) { this.el = el; }
  private model(): ContentModel { return buildModel(this.el); }
  readText(): string { return this.model().text; }
  caret(): number { return modelCaret(this.el, this.model()); }
  setCaret(pos: number): void { setModelCaret(this.el, this.model(), pos); }
  blockStart(pos: number): number {
    const i = this.readText().lastIndexOf("\n", pos - 1);
    return i + 1;
  }
  blockEnd(pos: number): number {
    const i = this.readText().indexOf("\n", pos);
    return i === -1 ? this.readText().length : i;
  }

  replace(from: number, to: number, insert: string) {
    const model = this.model();
    const range = modelRange(model, from, to);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    let ok = false;
    try { ok = document.execCommand("insertText", false, insert); } catch { ok = false; }
    if (!ok) {
      range.deleteContents();
      if (insert) range.insertNode(document.createTextNode(insert));
    }
    // NOTE: the caret is NOT set here — execCommand parked it at the inserted
    // text, and applyHunks() restores the user's real position afterwards.
    return from + insert.length;
  }

  setValue(v: string): void {
    // Not used for contenteditable (corrections are applied per-range).
    void v;
  }
}

// ---------------------------------------------------------------------------
// Skip rules (password / login / complex editors, etc.)
// ---------------------------------------------------------------------------

function isEditableElement(el: unknown): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return (el.type || "text").toLowerCase() === "text";
  return el.isContentEditable;
}

function shouldSkip(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) {
    if ((el.type || "text").toLowerCase() !== "text") return true; // password/email/number/…
    if (el.readOnly || el.disabled) return true;
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.readOnly || el.disabled) return true;
    // Mirrored/hidden textareas (Google Docs kix, CodeMirror, Monaco) are
    // invisible and their value isn't the text you see.
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.opacity === "0" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return true;
  }
  if (el.isContentEditable && el.closest(".cm-editor, .monaco-editor, .CodeMirror, [class*='kix-']")) return true;

  // Login / username / password field heuristics — never correct these.
  const elName = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.name : "";
  const hint = [el.id, elName, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("class")]
    .filter(Boolean).join(" ").toLowerCase();
  if (/(password|passwd|login|log[ -]?in|sign[ -]?in|username|user[_-]?(name|id)|credential)/.test(hint)) return true;

  return false;
}

function makeField(el: HTMLElement): Field | null {
  if (shouldSkip(el)) return null;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return new SimpleField(el);
  if (el.isContentEditable) return new ContentEditableField(el);
  return null;
}

// ---------------------------------------------------------------------------
// Span heuristics (ported from main.ts confirmTrigger/sentenceSpan/lineSpan)
// ---------------------------------------------------------------------------

function prevToken(text: string, pos: number): string {
  if (pos < 0) return "";
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return text.slice(start, pos + 1);
}

function sentenceSpan(text: string, blockStart: number, blockEnd: number, triggerPos: number): { from: number; to: number } {
  let clusterStart = triggerPos;
  while (clusterStart > blockStart) {
    const c = text[clusterStart - 1];
    if (c !== "." && c !== "?" && c !== "!") break;
    clusterStart--;
  }
  let from = blockStart;
  for (let i = clusterStart - 1; i >= blockStart; i--) {
    const c = text[i];
    if (c === "." || c === "?" || c === "!") { from = i + 1; break; }
  }
  let to = triggerPos + 1;
  while (to < blockEnd) {
    const c = text[to];
    if (c !== '"' && c !== "'" && c !== ")" && c !== "]" && c !== "}") break;
    to++;
  }
  return { from, to };
}

/** Skip units that look like markdown fenced code or indented code. */
function looksLikeCode(text: string): boolean {
  return /```/.test(text) || /(^|\n) {4}/.test(text) || /(^|\n)\t/.test(text);
}

// ---------------------------------------------------------------------------
// Corrector pipeline (ported from main.ts Corrector + fire())
// ---------------------------------------------------------------------------

interface QueuedUnit { field: Field; from: number; to: number; }

class Corrector {
  private isPending = false;
  private gen = 0;
  private queued: QueuedUnit | null = null;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private verifyPos: number | null = null;
  private verifyChar = "";
  private verifyField: Field | null = null;

  /** Drop in-flight/queued/verify work (pause, field switch). */
  reset(): void {
    this.gen++;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    this.verifyPos = null;
    this.verifyChar = "";
    this.verifyField = null;
    this.queued = null;
    this.isPending = false;
  }

  /** A trigger char (`.`, `?`, `!`, `\n`) was just inserted at `pos`. */
  verify(field: Field, pos: number, ch: string): void {
    if (paused) return;
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
      // A new trigger landed before the old one confirmed. The old trigger char
      // is still present (this input inserted, didn't delete), so confirm it NOW
      // instead of dropping the completed unit — otherwise Enter Enter in a
      // textarea loses the first line.
      this.confirm();
    }
    this.verifyPos = pos;
    this.verifyChar = ch;
    this.verifyField = field;
    this.verifyTimer = setTimeout(() => this.confirm(), TRIGGER_VERIFY_MS);
  }

  private confirm(): void {
    this.verifyTimer = null;
    const pos = this.verifyPos;
    const ch = this.verifyChar;
    const field = this.verifyField;
    this.verifyPos = null;
    this.verifyChar = "";
    this.verifyField = null;
    if (paused || !field || pos === null) return;

    const text = field.readText();
    if (pos >= text.length || text[pos] !== ch) return;

    // "." only counts as a sentence end if followed by whitespace/EOL/a closer
    // (rejects "3.14", "v1.2.3") and not an abbreviation ("e.g.", "Mr.").
    if (ch === ".") {
      const next = pos + 1 < text.length ? text[pos + 1] : "";
      if (next !== "" && !/\s/.test(next) && !"\"')]}".includes(next)) return;
      if (ABBREVIATIONS.has(prevToken(text, pos))) return;
    }

    const blockStart = field.blockStart(pos);
    const blockEnd = field.blockEnd(pos);
    const span = ch === "\n"
      ? { from: text.lastIndexOf("\n", pos - 1) + 1, to: pos }
      : sentenceSpan(text, blockStart, blockEnd, pos);
    if (span.to - span.from > MAX_UNIT_CHARS) return;
    const unit = text.slice(span.from, span.to);
    if (unit.trim().length < MIN_UNIT_CHARS) return;
    if (looksLikeCode(unit)) return;

    // If the unit overlaps an already-applied (still-active) correction, the
    // user is editing the corrected text — don't substitute over it again.
    if (hasAppliedOverlap(field, span.from, span.to)) return;

    this.queued = { field, from: span.from, to: span.to };
    this.maybeFire();
  }

  private maybeFire(): void {
    if (this.isPending || paused || !this.queued) return;
    const q = this.queued;
    this.queued = null;
    void this.fire(q);
  }

  private async fire(q: QueuedUnit): Promise<void> {
    this.isPending = true;
    const g = this.gen;
    try {
      if (this.gen !== g || paused || active !== q.field) return;
      const text = q.field.readText();
      const raw = text.slice(q.from, q.to);
      const trimmed = raw.trim();
      const lead = raw.length - raw.trimStart().length;
      if (trimmed.length < MIN_UNIT_CHARS) return;
      if (looksLikeCode(trimmed)) return;

      const corrected = await this.request(trimmed);
      if (this.gen !== g || paused || active !== q.field) return;
      if (!corrected) return;

      const final = capitalizeInitial(corrected, capitalize);
      if (final === trimmed) return;

      // The user edited the unit while we waited — never insert stale text.
      if (q.field.readText().slice(q.from, q.to).trim() !== trimmed) return;

      const hunks = diffWords(trimmed, final);
      if (hunks.length > 0) applyHunks(q.field, q.from, lead, trimmed, hunks);
    } finally {
      this.isPending = false;
      this.queued = null;
      this.maybeFire();
    }
  }

  private async request(text: string): Promise<string | null> {
    const resp = await browser.runtime.sendMessage({ type: "correct", text });
    return resp && resp.type === "correctResult" ? resp.corrected : null;
  }
}

// ---------------------------------------------------------------------------
// Apply + decorations
// ---------------------------------------------------------------------------

interface Deco {
  span: HTMLElement;
  original: string;
  replacement: string;
  snippet: string;
}
const decos: Deco[] = [];

/**
 * Map the user's caret through a set of disjoint changes (like CodeMirror maps
 * the selection through a ChangeSet). We never move the caret to a corrected
 * word — we preserve where the user is, shifted only by length deltas.
 */
function mapCaret(caret: number, changes: { from: number; to: number; ins: string }[]): number {
  let c = caret;
  for (const ch of [...changes].sort((a, b) => b.from - a.from)) {
    if (c > ch.to) {
      c += ch.ins.length - (ch.to - ch.from); // caret beyond the change → shift
    } else if (c >= ch.from) {
      c = ch.from + ch.ins.length;            // caret inside the replaced range → its end
    }
  }
  return c;
}

/** Wrap a text node in a marker span (keeps its text; the span is the marker). */
function wrapTextNode(node: Text, className: string): HTMLElement | null {
  if (!node.parentNode) return null;
  const span = document.createElement("span");
  span.className = className;
  try {
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
    return span;
  } catch {
    return null;
  }
}

/**
 * Wrap exactly the text range [from, to) of a contenteditable in a marker span,
 * splitting text nodes at the boundaries so ONLY that range is marked.
 * Returns null if the range can't be isolated (e.g. it crosses an element).
 */
function wrapRange(root: HTMLElement, from: number, to: number, className: string): HTMLElement | null {
  const model = buildModel(root);
  if (model.texts.length === 0 || from < 0 || to > model.text.length || from >= to) return null;
  const range = modelRange(model, from, to);
  const sc = range.startContainer;
  const ec = range.endContainer;
  const so = range.startOffset;
  const eo = range.endOffset;

  // Single text node: split out exactly [a, b) and wrap that.
  if (sc.nodeType === Node.TEXT_NODE && ec.nodeType === Node.TEXT_NODE && sc === ec) {
    const t = sc as Text;
    const a = so, b = eo;
    if (a > 0) {
      const mid = t.splitText(a);
      if (b - a < mid.data.length) mid.splitText(b - a);
      return wrapTextNode(mid, className);
    }
    if (b < t.data.length) t.splitText(b);
    return wrapTextNode(t, className);
  }

  // Cross text nodes: only wrap if they're contiguous text siblings.
  if (sc.nodeType === Node.TEXT_NODE && ec.nodeType === Node.TEXT_NODE && sc !== ec) {
    const startNode = so > 0 ? (sc as Text).splitText(so) : (sc as Text);
    let endNode = ec as Text;
    if (eo > 0 && eo < endNode.data.length) endNode.splitText(eo); // endNode keeps [0, eo)
    let n: Node | null = startNode.nextSibling;
    while (n && n !== endNode) {
      if (n.nodeType !== Node.TEXT_NODE) return null;
      n = n.nextSibling;
    }
    if (!n) return null;
    const span = document.createElement("span");
    span.className = className;
    try {
      const r = document.createRange();
      r.setStart(startNode, 0);
      r.setEnd(endNode, eo > endNode.data.length ? endNode.data.length : eo);
      r.surroundContents(span);
      return span;
    } catch {
      return null;
    }
  }
  return null;
}

/** Textarea applied ranges (approximate offsets), keyed by field element, for the re-correction guard. */
const textApplied = new Map<HTMLElement, { from: number; to: number }[]>();

function registerTextApplied(field: Field, ranges: { from: number; to: number }[]): void {
  const el = field.el;
  const list = textApplied.get(el) ?? [];
  list.push(...ranges);
  textApplied.set(el, list);
}

function unregisterTextApplied(field: Field, ranges: { from: number; to: number }[]): void {
  const el = field.el;
  const list = textApplied.get(el);
  if (!list) return;
  const dropped = new Set(ranges);
  const remaining = list.filter((r) => !dropped.has(r));
  if (remaining.length === 0) textApplied.delete(el);
  else textApplied.set(el, remaining);
}

/** True if the unit [from,to) overlaps an active (un-accepted) correction in this field. */
function hasAppliedOverlap(field: Field, from: number, to: number): boolean {
  if (field.kind === "contenteditable") {
    const model = buildModel(field.el);
    for (const d of decos) {
      if (!field.el.contains(d.span)) continue;
      const tn = d.span.firstChild;
      if (!tn || tn.nodeType !== Node.TEXT_NODE) continue;
      const idx = model.texts.indexOf(tn as Text);
      if (idx === -1) continue;
      const df = model.starts[idx];
      const dt = df + (tn as Text).data.length;
      if (df < to && dt > from) return true;
    }
    return false;
  }
  const list = textApplied.get(field.el);
  return !!list && list.some((r) => r.from < to && r.to > from);
}

function applyHunks(field: Field, spanStart: number, lead: number, trimmed: string, hunks: DiffHunk[]): void {
  const base = spanStart + lead;
  if (field.kind === "textarea") {
    const text = field.readText();
    const changes = hunks.map((h) => ({ from: base + h.from, to: base + h.to, ins: h.replacement }));
    const caretBefore = field.caret();
    let v = text;
    for (const c of [...changes].sort((a, b) => b.from - a.from)) {
      v = v.slice(0, c.from) + c.ins + v.slice(c.to);
    }
    field.setValue(v);
    field.setCaret(mapCaret(caretBefore, changes));
    showCorrectionPill(field, base, trimmed, hunks);
    return;
  }

  // Contenteditable: apply descending so earlier offsets stay valid.
  const text = field.readText();
  const changes: { from: number; to: number; ins: string }[] = [];
  const caretBefore = field.caret();
  for (const h of [...hunks].sort((a, b) => b.from - a.from)) {
    const from = base + h.from;
    const to = base + h.to;
    const ins = h.replacement;
    const original = text.slice(from, to);
    const snippet = contextSnippet(text, from, to, original, ins);
    field.replace(from, to, ins);
    changes.push({ from, to, ins });
    // execCommand merges inserted text into its containing text node, so locate
    // the exact [from, from+ins.length) range and wrap ONLY that.
    if (ins !== "") {
      const span = wrapRange(field.el, from, from + ins.length, "ft-correction");
      if (span) {
        span.title = "FastTyper correction";
        addTooltip(span);
        decos.push({ span, original, replacement: ins, snippet });
        span.addEventListener("click", () => revertDeco(decoOf(span)));
      }
    }
  }
  // execCommand leaves the caret at the last inserted text; put it back where
  // the user was, mapped through the edits.
  field.setCaret(mapCaret(caretBefore, changes));
}

function decoOf(span: HTMLElement): Deco | null {
  return decos.find((d) => d.span === span) ?? null;
}

function revertDeco(d: Deco | null): void {
  if (!d) return;
  const idx = decos.indexOf(d);
  if (idx !== -1) decos.splice(idx, 1);
  hideTooltip();
  d.span.replaceWith(document.createTextNode(d.original));
}

function acceptAll(): void {
  for (const d of decos) {
    d.span.replaceWith(...Array.from(d.span.childNodes));
  }
  decos.length = 0;
  textApplied.clear();
  hideTooltip();
  dismissAllPills();
}

// --- textarea indicator pills ---
interface Pill {
  el: HTMLElement;
  field: Field;
  undoHunks: { from: number; len: number; original: string; ins: string }[];
  appliedRanges: { from: number; to: number }[];
  timer: ReturnType<typeof setTimeout>;
}
const pills: Pill[] = [];

/** The corrected sentence, with each changed word shown as `was → now`. */
function buildHighlighted(trimmed: string, hunks: DiffHunk[]): HTMLElement {
  const body = document.createElement("div");
  body.className = "ft-pill-body";
  let pos = 0;
  for (const h of hunks) {
    if (h.from > pos) body.appendChild(document.createTextNode(trimmed.slice(pos, h.from)));
    const mark = document.createElement("span");
    mark.className = "ft-pill-change";
    const was = document.createElement("span");
    was.className = "ft-pill-was";
    was.textContent = trimmed.slice(h.from, h.to) || "∅";
    const arrow = document.createTextNode(" → ");
    const now = document.createElement("span");
    now.className = "ft-pill-now";
    now.textContent = h.replacement;
    mark.append(was, arrow, now);
    body.appendChild(mark);
    pos = h.to;
  }
  if (pos < trimmed.length) body.appendChild(document.createTextNode(trimmed.slice(pos)));
  return body;
}

/** One pill per correction event, aggregating every hunk in the sentence. */
function showCorrectionPill(field: Field, base: number, trimmed: string, hunks: DiffHunk[]): void {
  const pill = document.createElement("div");
  pill.className = "ft-pill";
  pill.appendChild(buildHighlighted(trimmed, hunks));

  const row = document.createElement("div");
  row.className = "ft-pill-row";
  const undo = document.createElement("button");
  undo.className = "ft-pill-btn";
  undo.textContent = hunks.length > 1 ? `Undo (${hunks.length})` : "Undo";
  undo.addEventListener("click", () => undoPill(pill));
  row.appendChild(undo);
  const dismiss = document.createElement("button");
  dismiss.className = "ft-pill-btn ft-pill-x";
  dismiss.textContent = "×";
  dismiss.title = "Dismiss (correction stays applied)";
  dismiss.addEventListener("click", () => removePill(pill));
  row.appendChild(dismiss);
  pill.appendChild(row);

  document.body.appendChild(pill);

  // Record the applied range (guard against re-correcting while editing) and
  // the reverse hunks (undo), all in post-apply field coordinates.
  const appliedRanges = hunks.map((h) => ({ from: base + h.from, to: base + h.to }));
  const undoHunks = hunks.map((h) => ({
    from: base + h.from,
    len: h.replacement.length,
    original: trimmed.slice(h.from, h.to),
    ins: h.replacement,
  }));
  registerTextApplied(field, appliedRanges);

  positionPill(pill, field.el);
  const timer = setTimeout(() => removePill(pill), 8000);
  pills.push({ el: pill, field, undoHunks, appliedRanges, timer });
}

function positionPill(pill: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const pr = pill.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  // Stack below any other pill anchored to the same field.
  for (const p of pills) {
    if (p.el === pill) continue;
    if (p.field.el !== anchor) continue;
    const pr2 = p.el.getBoundingClientRect();
    top = Math.max(top, pr2.bottom + 4);
  }
  if (left + pr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pr.width - 8);
  if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
  pill.style.left = `${left}px`;
  pill.style.top = `${top}px`;
}

function removePill(pill: HTMLElement): void {
  const idx = pills.findIndex((p) => p.el === pill);
  if (idx === -1) return;
  clearTimeout(pills[idx].timer);
  pills.splice(idx, 1);
  pill.remove();
}

/** Revert every hunk this pill reported (skips hunks the user already edited). */
function undoPill(pill: HTMLElement): void {
  const idx = pills.findIndex((p) => p.el === pill);
  if (idx === -1) return;
  const p = pills[idx];
  const v = p.field.readText();
  const caretBefore = p.field.caret();
  const changes: { from: number; to: number; ins: string }[] = [];
  let nv = v;
  for (const u of [...p.undoHunks].sort((a, b) => b.from - a.from)) {
    if (nv.slice(u.from, u.from + u.len) === u.ins) {
      nv = nv.slice(0, u.from) + u.original + nv.slice(u.from + u.len);
      changes.push({ from: u.from, to: u.from + u.len, ins: u.original });
    }
  }
  if (changes.length > 0) {
    p.field.setValue(nv);
    p.field.setCaret(mapCaret(caretBefore, changes));
  }
  unregisterTextApplied(p.field, p.appliedRanges);
  removePill(pill);
}

function dismissAllPills(): void {
  for (const p of [...pills]) removePill(p.el);
}

// --- contenteditable hover tooltip ---
let tooltip: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "ft-tooltip";
    tooltip.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function hideTooltip(): void {
  if (tooltip) tooltip.style.display = "none";
}

function addTooltip(span: HTMLElement): void {
  span.addEventListener("mouseenter", () => {
    const d = decoOf(span);
    if (!d) return;
    const tip = ensureTooltip();
    tip.textContent = "";
    const snippet = document.createElement("strong");
    snippet.textContent = d.snippet;
    const hint = document.createElement("span");
    hint.className = "ft-hint";
    hint.textContent = "click to revert";
    tip.appendChild(snippet);
    tip.appendChild(hint);
    tip.style.display = "block";
    const r = span.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 4;
    if (left + tr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tr.width - 8);
    if (top + tr.height > window.innerHeight - 8) top = Math.max(8, r.top - tr.height - 4);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  span.addEventListener("mouseleave", hideTooltip);
}

// ---------------------------------------------------------------------------
// Wiring: focus + input listeners
// ---------------------------------------------------------------------------

const corrector = new Corrector();
let active: Field | null = null;

function onFocusIn(el: HTMLElement): void {
  if (!isEditableElement(el)) return; // buttons/links etc. — leave active field alone
  const f = makeField(el);
  if (!f) {
    corrector.reset();
    active = null;
    return;
  }
  if (active !== f) corrector.reset();
  active = f;
}

// beforeinput snapshot: distinguishes a fresh trigger insertion from an old one.
let pendingInsert: { caretBefore: number; data: string; lineBreak: boolean } | null = null;

document.addEventListener("beforeinput", (e) => {
  if (siteDisabled) return;
  const ie = e as InputEvent;
  if (!e.isTrusted || ie.isComposing) return;
  const target = e.target as HTMLElement;
  if (!isEditableElement(target)) { pendingInsert = null; return; }
  if (!active || active.el !== target) { pendingInsert = null; return; }
  const t = ie.inputType;
  if (t === "insertText" || t === "insertLineBreak" || t === "insertParagraph") {
    pendingInsert = {
      caretBefore: active.caret(),
      data: ie.data ?? "",
      lineBreak: t !== "insertText",
    };
  } else {
    pendingInsert = null;
  }
}, true);

document.addEventListener("input", (e) => {
  if (siteDisabled) return;
  const ie = e as InputEvent;
  if (!e.isTrusted || ie.isComposing) return;
  const target = e.target as HTMLElement;
  if (!isEditableElement(target)) { pendingInsert = null; return; }
  if (!active || active.el !== target) onFocusIn(target);
  if (!active || active.el !== target) { pendingInsert = null; return; }

  const p = pendingInsert;
  pendingInsert = null;
  if (!p) return;

  const field = active;
  const text = field.readText();
  const pos = field.caret() - 1;
  if (pos < 0) return;
  const ch = text[pos];
  if (ch !== "." && ch !== "?" && ch !== "!" && ch !== "\n") return;

  const fresh =
    p.lineBreak
      ? pos >= p.caretBefore && pos <= p.caretBefore + 2
      : pos === p.caretBefore + p.data.length - 1;
  if (!fresh) return;

  corrector.verify(field, pos, ch);
}, true);

document.addEventListener("focusin", (e) => {
  if (siteDisabled) return;
  onFocusIn(e.target as HTMLElement);
}, true);
