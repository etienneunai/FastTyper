var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  clearCorrections: () => clearCorrections,
  default: () => FastTyperPlugin,
  grammarCorrectionsField: () => grammarCorrectionsField,
  grammarTooltip: () => grammarTooltip,
  processingField: () => processingField,
  revertCorrection: () => revertCorrection,
  setCorrections: () => setCorrections,
  setProcessing: () => setProcessing
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_language = require("@codemirror/language");
var LLM_URL = "http://127.0.0.1:8808/v1/chat/completions";
var MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf";
var TRIGGER_VERIFY_MS = 100;
var MAX_UNIT_CHARS = 800;
var MIN_UNIT_CHARS = 3;
var MAX_RETRIES = 3;
var CUSTOM_PROMPT_ID = "custom";
var PROMPT_PRESETS = [
  {
    id: "A",
    name: "A \u2014 prod",
    system: "You are a spelling correction assistant.",
    user: "Fix any spelling mistakes in this text. If there are no mistakes, output the text unchanged.\n\n{text}"
  },
  {
    id: "B",
    name: "B \u2014 gram",
    system: "You are a spelling and grammar correction assistant.",
    user: "Fix any spelling mistakes, missing spaces, and a/an errors in this text. If there are no mistakes, output the text unchanged.\n\n{text}"
  },
  {
    id: "E",
    name: "E \u2014 proof",
    system: "You are a careful proofreader.",
    user: "Fix only clear errors: misspellings, run-together words, missing apostrophes, and a/an agreement. Never reword, restyle, or alter correct text. Reply with only the corrected text.\n\n{text}"
  },
  {
    id: "C",
    name: "C \u2014 clean",
    system: "You are an English text cleaner.",
    user: "Insert missing spaces between run-together words, fix spelling and a/an errors. Return only the corrected text.\n\n{text}"
  }
];
var LLM_LOG_PATH = "/home/etienne/Projects/FastTyper/llm-log.txt";
var ABBREVIATIONS = /* @__PURE__ */ new Set(["e.g.", "i.e.", "etc.", "Mr.", "Mrs.", "Ms.", "Dr.", "St.", "vs.", "no."]);
var fsModule = null;
function logExchange(sent, received) {
  try {
    if (fsModule === null) {
      try {
        fsModule = require("fs");
      } catch (e) {
        fsModule = false;
      }
    }
    if (!fsModule)
      return;
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const entry = `--- ${ts} ---
sent:
${sent}
received:
${received}

`;
    fsModule.appendFileSync(LLM_LOG_PATH, entry, "utf8");
  } catch (e) {
    console.error("FastTyper: failed to write LLM log", e);
  }
}
var setCorrections = import_state.StateEffect.define();
var revertCorrection = import_state.StateEffect.define();
var clearCorrections = import_state.StateEffect.define();
var correctionsPaused = false;
var capitalizeInitials = true;
var promptId = "A";
var customSystem = PROMPT_PRESETS[0].system;
var customUser = PROMPT_PRESETS[0].user;
var thinkingMode = "auto";
function activePrompt() {
  var _a;
  if (promptId === CUSTOM_PROMPT_ID)
    return { system: customSystem, user: customUser };
  return (_a = PROMPT_PRESETS.find((p) => p.id === promptId)) != null ? _a : PROMPT_PRESETS[0];
}
function correctionOf(value) {
  var _a, _b, _c;
  const spec = value.spec;
  if (!spec)
    return null;
  return (_c = (_b = spec.correction) != null ? _b : (_a = spec.widget) == null ? void 0 : _a.correction) != null ? _c : null;
}
var DeletionMarker = class extends import_view.WidgetType {
  constructor(correction) {
    super();
    this.correction = correction;
  }
  eq(other) {
    return other.correction === this.correction;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "grammar-deletion-marker";
    span.title = "FastTyper correction (hover to revert)";
    return span;
  }
  ignoreEvent() {
    return true;
  }
};
var grammarCorrectionsField = import_state.StateField.define({
  create() {
    return import_view.Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (let effect of tr.effects) {
      if (effect.is(setCorrections)) {
        const newDecos = [];
        for (const c of effect.value) {
          if (c.from < c.to) {
            newDecos.push(import_view.Decoration.mark({
              class: "grammar-applied-underline",
              correction: c
            }).range(c.from, c.to));
          } else {
            newDecos.push(import_view.Decoration.widget({
              widget: new DeletionMarker(c),
              side: 1
            }).range(c.from));
          }
        }
        decorations = decorations.update({ add: newDecos });
      } else if (effect.is(revertCorrection)) {
        decorations = decorations.update({
          filter: (from, to, value) => correctionOf(value) !== effect.value
        });
      } else if (effect.is(clearCorrections)) {
        decorations = import_view.Decoration.none;
      }
    }
    return decorations;
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
var setProcessing = import_state.StateEffect.define();
var processingField = import_state.StateField.define({
  create() {
    return null;
  },
  update(state, tr) {
    if (state) {
      state = {
        from: tr.changes.mapPos(state.from, 1),
        to: tr.changes.mapPos(state.to, -1),
        thinking: state.thinking
      };
      if (state.from >= state.to)
        state = null;
    }
    for (const e of tr.effects) {
      if (e.is(setProcessing))
        state = e.value;
    }
    return state;
  },
  provide: (f) => import_view.EditorView.decorations.from(f, (s) => s ? import_view.Decoration.set([import_view.Decoration.mark({
    class: s.thinking ? "ft-processing ft-processing-thinking" : "ft-processing"
  }).range(s.from, s.to)]) : import_view.Decoration.none)
});
var CONTEXT_CHARS = 10;
function contextSnippet(doc, from, to, original, replacement) {
  var _a, _b, _c, _d;
  const before = doc.sliceString(Math.max(0, from - CONTEXT_CHARS), from);
  const after = doc.sliceString(to, Math.min(doc.length, to + CONTEXT_CHARS));
  const core = original || replacement;
  const leftWs = (_b = (_a = before.match(/\s*$/)) == null ? void 0 : _a[0]) != null ? _b : "";
  const rightWs = (_d = (_c = after.match(/^\s*/)) == null ? void 0 : _c[0]) != null ? _d : "";
  const bText = before.slice(0, before.length - leftWs.length);
  const aText = after.slice(rightWs.length);
  const lead = leftWs.length > 0 || from === 0 ? "" : "\u2026";
  const trail = rightWs.length > 0 || to >= doc.length ? "" : "\u2026";
  const tag = original === "" ? " (added)" : "";
  return lead + bText + "[" + core + "]" + aText + trail + tag;
}
var grammarTooltip = (0, import_view.hoverTooltip)((view, pos, side) => {
  let found = null;
  let decoFrom = 0;
  let decoTo = 0;
  const field = view.state.field(grammarCorrectionsField, false);
  if (!field)
    return null;
  field.between(pos, pos, (from, to, value) => {
    const c = correctionOf(value);
    if (c) {
      found = c;
      decoFrom = from;
      decoTo = to;
    }
  });
  if (!found)
    return null;
  return {
    pos: decoFrom,
    end: decoTo,
    above: true,
    create(view2) {
      const c = found;
      let dom = document.createElement("div");
      dom.className = "grammar-suggestion-tooltip";
      dom.style.cursor = "pointer";
      dom.style.padding = "6px 10px";
      dom.style.border = "1px solid var(--background-modifier-border)";
      dom.style.backgroundColor = "var(--background-secondary)";
      dom.style.borderRadius = "5px";
      dom.style.color = "var(--text-normal)";
      dom.style.fontSize = "var(--font-ui-smaller)";
      dom.style.maxWidth = "360px";
      const snippet = document.createElement("span");
      snippet.style.fontWeight = "bold";
      snippet.style.color = "var(--text-accent)";
      snippet.textContent = contextSnippet(view2.state.doc, c.from, c.to, c.originalText, c.replacement);
      const hint = document.createElement("span");
      hint.style.opacity = "0.55";
      hint.style.marginLeft = "6px";
      hint.style.fontWeight = "normal";
      hint.textContent = "click to revert";
      dom.appendChild(snippet);
      dom.appendChild(hint);
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view2.dispatch({
          changes: { from: decoFrom, to: decoTo, insert: c.originalText },
          effects: revertCorrection.of(c)
        });
      });
      return { dom };
    }
  };
});
function parseResponse(content) {
  let s = content.replace(/<think[\s\S]*?<\/think>/g, "");
  const openIdx = s.indexOf("<think");
  if (openIdx !== -1)
    s = s.slice(0, openIdx);
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"')
    s = s.slice(1, -1).trim();
  const fenced = s.match(/^```[\s\S]*?```$/);
  if (fenced)
    s = s.slice(3, -3).trim();
  return s.length > 0 ? s : null;
}
var MAX_CHAR_DIFF_CELLS = 4e6;
function charDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > MAX_CHAR_DIFF_CELLS)
    return a === b ? [] : [{ from: 0, to: n, replacement: b }];
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2 * width + j2] = a.charCodeAt(i2) === b.charCodeAt(j2) ? dp[(i2 + 1) * width + (j2 + 1)] + 1 : Math.max(dp[(i2 + 1) * width + j2], dp[i2 * width + (j2 + 1)]);
    }
  }
  const hunks = [];
  let i = 0, j = 0;
  let hStart = null;
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
      i++;
      j++;
    } else {
      if (hStart === null)
        hStart = i;
      if (dp[i * width + j + 1] >= dp[(i + 1) * width + j]) {
        hRepl += b[j];
        j++;
      } else {
        i++;
      }
    }
  }
  if (i < n || j < m) {
    if (hStart === null)
      hStart = i;
    hRepl += b.slice(j);
    i = n;
    j = m;
  }
  flush();
  return hunks;
}
function diffWords(a, b) {
  return charDiff(a, b).filter((h) => {
    const orig = a.slice(h.from, h.to);
    if (orig === h.replacement)
      return false;
    if (orig.trim() === "" && h.replacement.trim() === "")
      return false;
    return true;
  });
}
var grammarCheckerPlugin = import_view.ViewPlugin.fromClass(class {
  constructor(view) {
    this.verifyTimeout = null;
    this.verifyPos = null;
    this.verifyChar = "";
    this.abortController = null;
    this.isPending = false;
    this.pending = null;
    this.queued = null;
    this.destroyed = false;
    this.paused = false;
    this.view = view;
    this.paused = correctionsPaused;
  }
  /** Pause/resume. Pausing drops queued work and aborts any in-flight request. */
  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      if (this.verifyTimeout) {
        clearTimeout(this.verifyTimeout);
        this.verifyTimeout = null;
      }
      this.verifyPos = null;
      this.verifyChar = "";
      this.queued = null;
      if (this.abortController)
        this.abortController.abort();
    }
  }
  destroy() {
    this.destroyed = true;
    if (this.verifyTimeout)
      clearTimeout(this.verifyTimeout);
    if (this.abortController)
      this.abortController.abort();
    this.abortController = null;
  }
  update(update) {
    if (this.pending) {
      this.pending = { ...this.mapSpan(this.pending, update.changes), text: this.pending.text, lead: this.pending.lead };
    }
    if (this.queued)
      this.queued = this.mapSpan(this.queued, update.changes);
    if (this.verifyPos !== null)
      this.verifyPos = update.changes.mapPos(this.verifyPos, 1);
    if (!update.docChanged)
      return;
    const isAutoApply = update.transactions.some((tr) => tr.effects.some((e) => e.is(setCorrections) || e.is(revertCorrection) || e.is(clearCorrections) || e.is(setProcessing)));
    if (isAutoApply)
      return;
    if (this.paused)
      return;
    const trig = this.findTrigger(update);
    if (!trig)
      return;
    if (this.verifyTimeout) {
      clearTimeout(this.verifyTimeout);
      this.verifyTimeout = null;
      this.confirmTrigger();
    }
    this.verifyPos = trig.pos;
    this.verifyChar = trig.ch;
    this.verifyTimeout = setTimeout(() => this.confirmTrigger(), TRIGGER_VERIFY_MS);
  }
  /** Last pure insertion of `.`/`?`/`!`/`\n` across the update's transactions. */
  findTrigger(update) {
    for (let t = update.transactions.length - 1; t >= 0; t--) {
      let found = null;
      update.transactions[t].changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const s = inserted.toString();
        if (fromA !== toA && !s.includes("\n"))
          return;
        for (let k = s.length - 1; k >= 0; k--) {
          const c = s[k];
          if (c === "." || c === "?" || c === "!" || c === "\n") {
            found = { pos: fromB + k, ch: c };
            break;
          }
        }
      });
      if (found)
        return found;
    }
    return null;
  }
  /** Called TRIGGER_VERIFY_MS after the trigger char — confirm it survived, then fire. */
  confirmTrigger() {
    if (this.destroyed || this.paused || this.verifyPos === null)
      return;
    const pos = this.verifyPos;
    const ch = this.verifyChar;
    this.verifyPos = null;
    this.verifyChar = "";
    const doc = this.view.state.doc;
    if (pos >= doc.length || doc.sliceString(pos, pos + 1) !== ch) {
      return;
    }
    if (ch === ".") {
      const next = pos + 1 < doc.length ? doc.sliceString(pos + 1, pos + 2) : "";
      if (next !== "" && !/\s/.test(next) && !`"')]}`.includes(next))
        return;
      const prev = this.prevToken(pos);
      if (prev && ABBREVIATIONS.has(prev))
        return;
    }
    const span = ch === "\n" ? this.lineSpan(pos) : this.sentenceSpan(pos);
    if (!span)
      return;
    if (span.to - span.from > MAX_UNIT_CHARS)
      return;
    if (doc.sliceString(span.from, span.to).trim().length < MIN_UNIT_CHARS)
      return;
    if (this.containsCode(span.from, span.to))
      return;
    this.queued = span;
    this.maybeFire();
  }
  /** Expand `head` to the surrounding paragraph block (blank-line delimited). */
  paragraphRange(head) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(head);
    let from = line.from;
    let to = line.to;
    while (from > 0) {
      const prev = doc.lineAt(from - 1);
      if (prev.text.trim().length === 0)
        break;
      from = prev.from;
    }
    while (to < doc.length) {
      const next = doc.lineAt(to + 1);
      if (next.text.trim().length === 0)
        break;
      to = next.to;
    }
    return { from, to };
  }
  /** The sentence ending at `triggerPos` (the position of `.`/`?`/`!`). */
  sentenceSpan(triggerPos) {
    const doc = this.view.state.doc;
    const para = this.paragraphRange(triggerPos);
    let clusterStart = triggerPos;
    while (clusterStart > para.from) {
      const c = doc.sliceString(clusterStart - 1, clusterStart);
      if (c !== "." && c !== "?" && c !== "!")
        break;
      clusterStart--;
    }
    let from = para.from;
    for (let i = clusterStart - 1; i >= para.from; i--) {
      const c = doc.sliceString(i, i + 1);
      if (c === "." || c === "?" || c === "!") {
        from = i + 1;
        break;
      }
    }
    let to = triggerPos + 1;
    while (to < para.to) {
      const c = doc.sliceString(to, to + 1);
      if (c !== '"' && c !== "'" && c !== ")" && c !== "]" && c !== "}")
        break;
      to++;
    }
    return { from, to };
  }
  /** The line completed by the newline at `triggerPos`. */
  lineSpan(triggerPos) {
    const doc = this.view.state.doc;
    if (triggerPos <= 0)
      return null;
    const line = doc.lineAt(triggerPos - 1);
    if (line.to !== triggerPos)
      return null;
    return { from: line.from, to: line.to };
  }
  /** Whitespace-delimited token immediately before `pos` (including a trailing period). */
  prevToken(pos) {
    const doc = this.view.state.doc;
    if (pos <= 0)
      return "";
    let start = pos;
    while (start > 0) {
      if (/\s/.test(doc.sliceString(start - 1, start)))
        break;
      start--;
    }
    return doc.sliceString(start, pos + 1);
  }
  /** True if the range overlaps inline/fenced code or frontmatter. */
  containsCode(from, to) {
    let found = false;
    (0, import_language.syntaxTree)(this.view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name.includes("Code") || node.name === "Frontmatter") {
          found = true;
          return false;
        }
      }
    });
    return found;
  }
  /** Map a span forward through a change set (keeps it accurate while the user types). */
  mapSpan(span, changes) {
    return { from: changes.mapPos(span.from, 1), to: changes.mapPos(span.to, -1) };
  }
  /** If no request is in flight and something is queued, start it. */
  maybeFire() {
    if (this.isPending || this.paused || !this.queued)
      return;
    const span = this.queued;
    this.queued = null;
    this.fire(span);
  }
  /** Correct `span`, re-sending (≤MAX_RETRIES) if the text changes while we wait. */
  async fire(span) {
    this.isPending = true;
    this.pending = { from: span.from, to: span.to, text: "", lead: 0 };
    let thinking = thinkingMode === "always";
    this.markProcessing(thinking);
    try {
      for (let retries = 0; retries <= MAX_RETRIES; retries++) {
        const raw = this.view.state.doc.sliceString(this.pending.from, this.pending.to);
        const text = raw.trim();
        const lead = raw.length - raw.trimStart().length;
        if (text.length < MIN_UNIT_CHARS)
          return;
        if (this.containsCode(this.pending.from, this.pending.to))
          return;
        this.pending.text = text;
        this.pending.lead = lead;
        const controller = new AbortController();
        this.abortController = controller;
        let corrected = null;
        try {
          corrected = await this.request(text, controller.signal, thinking);
        } catch (e) {
          if ((e == null ? void 0 : e.name) !== "AbortError") {
            console.error("FastTyper: grammar request failed", e);
          }
          return;
        }
        if (this.destroyed || this.paused || this.abortController !== controller)
          return;
        this.abortController = null;
        if (!corrected)
          return;
        corrected = this.capitalizeInitial(corrected);
        if (corrected === text) {
          if (thinkingMode === "auto" && !thinking) {
            thinking = true;
            this.markProcessing(true);
            continue;
          }
          return;
        }
        const nowText = this.view.state.doc.sliceString(this.pending.from, this.pending.to).trim();
        if (nowText !== text) {
          if (retries < MAX_RETRIES)
            continue;
          return;
        }
        const hunks = diffWords(text, corrected);
        if (hunks.length > 0)
          this.applyHunks(this.pending.from, this.pending.lead, hunks);
        return;
      }
    } finally {
      if (!this.destroyed)
        this.view.dispatch({ effects: setProcessing.of(null) });
      this.isPending = false;
      this.abortController = null;
      this.pending = null;
      this.maybeFire();
    }
  }
  /**
   * Mark the in-flight unit with the amber processing underline. Deferred via
   * queueMicrotask: `fire()` can be reached synchronously from `update()` (the
   * newline path confirmTrigger → maybeFire), and dispatching to the view while
   * an update is in progress throws.
   */
  markProcessing(thinking) {
    if (!this.pending)
      return;
    queueMicrotask(() => {
      if (this.destroyed || !this.pending)
        return;
      this.view.dispatch({ effects: setProcessing.of({ from: this.pending.from, to: this.pending.to, thinking }) });
    });
  }
  /** Capitalize the sentence-initial letter (lowercase a-z first char only), if enabled. */
  capitalizeInitial(corrected) {
    if (!capitalizeInitials || corrected.length === 0)
      return corrected;
    const c0 = corrected[0];
    if (c0 >= "a" && c0 <= "z")
      return c0.toUpperCase() + corrected.slice(1);
    return corrected;
  }
  /**
   * POST the unit to the daemon and return the corrected text (or null).
   * When `thinking` is true the request uses the E (proof) preset with Qwen3
   * thinking enabled and a reasoning_budget_tokens cap — the config the eval
   * matrix proved fixes the hard dyslexic cases (9/10) that flat inference
   * leaves unchanged (6/10), at ~6–12 s instead of ~0.4 s.
   */
  async request(text, signal, thinking) {
    var _a, _b, _c, _d;
    const prompt = thinking ? (_a = PROMPT_PRESETS.find((p) => p.id === "E")) != null ? _a : PROMPT_PRESETS[0] : activePrompt();
    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user.split("{text}").join(text) }
      ],
      temperature: 0,
      // Thinking needs headroom for the reasoning block; flat stays capped
      // by text length. Never let a runaway thinking pass burn the whole
      // budget and return empty (see reasoning_budget_tokens below).
      max_tokens: thinking ? 2048 : Math.min(2048, Math.ceil(text.length / 3) + 256),
      chat_template_kwargs: { enable_thinking: thinking },
      // Per-request reasoning cap: force-emits the end-of-thinking tag when
      // exhausted, so the model can't burn max_tokens on reasoning_content
      // and return an empty no-op (the eval's 91.6 s → 6–12 s fix).
      ...thinking ? { reasoning_budget_tokens: 256 } : {}
    };
    const body = JSON.stringify(payload);
    const response = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal
    });
    const rawBody = await response.text();
    logExchange(body, rawBody);
    if (!response.ok) {
      console.error("FastTyper: daemon returned", response.status);
      return null;
    }
    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      return null;
    }
    const content = (_d = (_c = (_b = data == null ? void 0 : data.choices) == null ? void 0 : _b[0]) == null ? void 0 : _c.message) == null ? void 0 : _d.content;
    if (typeof content !== "string")
      return null;
    const corrected = parseResponse(content);
    if (!corrected)
      return null;
    if (corrected.length > text.length * 2 + 200)
      return null;
    return corrected;
  }
  /** Replace the diff hunks in the doc and decorate the changed spans. */
  applyHunks(spanFrom, lead, hunks) {
    const doc = this.view.state.doc;
    const changes = hunks.map((h) => ({
      from: spanFrom + lead + h.from,
      to: spanFrom + lead + h.to,
      insert: h.replacement
    }));
    const changeSet = import_state.ChangeSet.of(changes, doc.length);
    const applied = hunks.map((h) => {
      const docFrom = spanFrom + lead + h.from;
      const docTo = spanFrom + lead + h.to;
      const originalText = doc.sliceString(docFrom, docTo);
      const newFrom = changeSet.mapPos(docFrom, -1);
      const newTo = newFrom + h.replacement.length;
      return { from: newFrom, to: newTo, originalText, replacement: h.replacement };
    });
    this.view.dispatch({
      changes,
      effects: setCorrections.of(applied)
    });
  }
});
var FastTyperSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Pause corrections").setDesc("Stop triggering new corrections. Applied corrections stay until accepted or reverted.").addToggle((toggle) => toggle.setValue(correctionsPaused).onChange((value) => this.plugin.setPaused(value)));
    new import_obsidian.Setting(containerEl).setName("Capitalize sentence-initial letters").setDesc("Capitalize the first letter of each corrected sentence. Done deterministically in the plugin (the model is spelling-only and won't do it).").addToggle((toggle) => toggle.setValue(capitalizeInitials).onChange((value) => this.plugin.setCapitalizeInitials(value)));
    new import_obsidian.Setting(containerEl).setName("Correction prompt").setDesc("Which prompt to send the model. A \u2014 prod: the default, spelling-only, never corrupts correct text. B \u2014 gram: adds missing spaces and a/an, keeps A's safety and speed. E \u2014 proof: most capable (a/an, apostrophes, run-together) but slow \u2014 emits a ~340-token reasoning block per request (6\u201325 s). C \u2014 clean: fixes a/an and run-together but unreliable (empty outputs, mid-sentence truncation) \u2014 a correction risk. Custom: edit both messages.").addDropdown((drop) => drop.addOption("A", "A \u2014 prod").addOption("B", "B \u2014 gram").addOption("E", "E \u2014 proof").addOption("C", "C \u2014 clean").addOption(CUSTOM_PROMPT_ID, "Custom").setValue(promptId).onChange((value) => this.plugin.setPromptId(value)));
    new import_obsidian.Setting(containerEl).setName("Thinking mode").setDesc("Auto \u2014 flat attempt first (~0.4 s); escalates once to E + thinking (~6\u201312 s) only if flat changes nothing. Always \u2014 E + thinking on every trigger. Fast \u2014 flat-only, current behavior. While correcting, the unit is underlined amber; it pulses while thinking.").addDropdown((drop) => drop.addOption("fast", "Fast").addOption("auto", "Auto").addOption("always", "Always").setValue(thinkingMode).onChange((value) => this.plugin.setThinkingMode(value)));
    if (promptId === CUSTOM_PROMPT_ID) {
      new import_obsidian.Setting(containerEl).setName("Custom system prompt").setDesc("The system message sent with every request.").addTextArea((text) => text.setPlaceholder(PROMPT_PRESETS[0].system).setValue(customSystem).onChange((value) => this.plugin.setCustomSystem(value)));
      new import_obsidian.Setting(containerEl).setName("Custom user prompt").setDesc("The user-message template. {text} is replaced with the sentence/line to correct.").addTextArea((text) => text.setPlaceholder(PROMPT_PRESETS[0].user).setValue(customUser).onChange((value) => this.plugin.setCustomUser(value)));
    }
    new import_obsidian.Setting(containerEl).setName("Accept all corrections").setDesc("Commit every currently-applied correction and clear its underline.").addButton((button) => button.setButtonText("Accept all").setCta().onClick(() => this.plugin.acceptAll()));
  }
};
var FastTyperPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settingsTab = null;
  }
  async onload() {
    console.log("Loading FastTyper plugin");
    const data = await this.loadData();
    if (data == null ? void 0 : data.paused)
      correctionsPaused = true;
    if (typeof (data == null ? void 0 : data.capitalizeInitials) === "boolean")
      capitalizeInitials = data.capitalizeInitials;
    if (typeof (data == null ? void 0 : data.promptId) === "string")
      promptId = data.promptId;
    if (typeof (data == null ? void 0 : data.customSystem) === "string")
      customSystem = data.customSystem;
    if (typeof (data == null ? void 0 : data.customUser) === "string")
      customUser = data.customUser;
    if ((data == null ? void 0 : data.thinkingMode) === "fast" || (data == null ? void 0 : data.thinkingMode) === "auto" || (data == null ? void 0 : data.thinkingMode) === "always")
      thinkingMode = data.thinkingMode;
    this.addCommand({
      id: "accept-all-corrections",
      name: "Accept all corrections",
      callback: () => this.acceptAll()
    });
    this.addCommand({
      id: "toggle-corrections",
      name: "Pause/resume corrections",
      callback: () => this.setPaused(!correctionsPaused)
    });
    this.addCommand({
      id: "cycle-thinking-mode",
      name: "Cycle thinking mode (fast/auto/always)",
      callback: () => {
        const next = thinkingMode === "fast" ? "auto" : thinkingMode === "auto" ? "always" : "fast";
        this.setThinkingMode(next);
      }
    });
    this.settingsTab = new FastTyperSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerEditorExtension([
      grammarCorrectionsField,
      processingField,
      grammarTooltip,
      grammarCheckerPlugin
    ]);
    this.applyPauseState();
  }
  onunload() {
    console.log("Unloading FastTyper plugin");
  }
  /** Commit every applied correction: clears all underline decorations. */
  acceptAll() {
    const cv = this.activeCm();
    if (!cv)
      return;
    cv.dispatch({ effects: clearCorrections.of(null) });
  }
  /** Toggle corrections on/off across all open editors and persist the choice. */
  async setPaused(paused) {
    var _a;
    correctionsPaused = paused;
    await this.saveSettings();
    this.applyPauseState();
    (_a = this.settingsTab) == null ? void 0 : _a.display();
    new import_obsidian.Notice(paused ? "FastTyper: corrections paused" : "FastTyper: corrections resumed");
  }
  /** Toggle sentence-initial capitalization and persist. */
  async setCapitalizeInitials(value) {
    var _a;
    capitalizeInitials = value;
    await this.saveSettings();
    (_a = this.settingsTab) == null ? void 0 : _a.display();
  }
  /** Select the active prompt preset (`A`/`B`/`E`/`C`/`custom`) and persist. */
  async setPromptId(id) {
    var _a;
    promptId = id;
    await this.saveSettings();
    (_a = this.settingsTab) == null ? void 0 : _a.display();
  }
  /** Select the thinking mode (`fast`/`auto`/`always`) and persist. */
  async setThinkingMode(mode) {
    var _a;
    thinkingMode = mode;
    await this.saveSettings();
    (_a = this.settingsTab) == null ? void 0 : _a.display();
    new import_obsidian.Notice(`FastTyper: thinking mode = ${mode}`);
  }
  /** Set the custom system message (used with the Custom prompt) and persist. */
  async setCustomSystem(value) {
    customSystem = value;
    await this.saveSettings();
  }
  /** Set the custom user template (used with the Custom prompt) and persist. */
  async setCustomUser(value) {
    customUser = value;
    await this.saveSettings();
  }
  /** Persist the current settings to plugin data. */
  async saveSettings() {
    await this.saveData({ paused: correctionsPaused, capitalizeInitials, promptId, customSystem, customUser, thinkingMode });
  }
  /** Push the current pause state to every open editor's corrector instance. */
  applyPauseState() {
    var _a, _b, _c;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      (_c = (_b = (_a = view.editor) == null ? void 0 : _a.cm) == null ? void 0 : _b.plugin(grammarCheckerPlugin)) == null ? void 0 : _c.setPaused(correctionsPaused);
    }
  }
  /** The CM6 EditorView backing the active markdown editor, if any. */
  activeCm() {
    var _a, _b;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return null;
    return (_b = (_a = view.editor) == null ? void 0 : _a.cm) != null ? _b : null;
  }
};
