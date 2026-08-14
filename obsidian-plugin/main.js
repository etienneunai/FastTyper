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
  revertCorrection: () => revertCorrection,
  setCorrections: () => setCorrections
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
    const isAutoApply = update.transactions.some((tr) => tr.effects.some((e) => e.is(setCorrections) || e.is(revertCorrection) || e.is(clearCorrections)));
    if (isAutoApply)
      return;
    if (this.paused)
      return;
    const trig = this.findTrigger(update);
    if (!trig)
      return;
    if (this.verifyTimeout)
      clearTimeout(this.verifyTimeout);
    this.verifyPos = trig.pos;
    this.verifyChar = trig.ch;
    this.verifyTimeout = setTimeout(() => this.confirmTrigger(), TRIGGER_VERIFY_MS);
  }
  /** Last pure insertion of `.`/`?`/`!`/`\n` across the update's transactions. */
  findTrigger(update) {
    for (let t = update.transactions.length - 1; t >= 0; t--) {
      let found = null;
      update.transactions[t].changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (fromA !== toA)
          return;
        const s = inserted.toString();
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
    if (pos >= doc.length || doc.sliceString(pos, pos + 1) !== ch)
      return;
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
          corrected = await this.request(text, controller.signal);
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
        if (corrected === text)
          return;
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
      this.isPending = false;
      this.abortController = null;
      this.pending = null;
      this.maybeFire();
    }
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
  /** POST the unit to the daemon and return the corrected text (or null). */
  async request(text, signal) {
    var _a, _b, _c;
    const payload = {
      model: MODEL,
      messages: [
        { role: "system", content: "You are a spelling correction assistant." },
        { role: "user", content: "Fix any spelling mistakes in this text. If there are no mistakes, output the text unchanged.\n\n" + text }
      ],
      temperature: 0,
      max_tokens: Math.min(2048, Math.ceil(text.length / 3) + 256)
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
    const content = (_c = (_b = (_a = data == null ? void 0 : data.choices) == null ? void 0 : _a[0]) == null ? void 0 : _b.message) == null ? void 0 : _c.content;
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
    this.settingsTab = new FastTyperSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerEditorExtension([
      grammarCorrectionsField,
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
  /** Persist the current settings to plugin data. */
  async saveSettings() {
    await this.saveData({ paused: correctionsPaused, capitalizeInitials });
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
