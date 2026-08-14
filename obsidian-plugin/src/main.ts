import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { StateField, StateEffect, Transaction, ChangeSet, type Range, type Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, hoverTooltip, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

interface AppliedCorrection {
    from: number;
    to: number;
    originalText: string;
    replacement: string;
}

/** One edit produced by the diff: [from, to) in the sent text, replaced with `replacement`. */
interface DiffHunk {
    from: number;
    to: number;
    replacement: string;
}

const LLM_URL = "http://127.0.0.1:8808/v1/chat/completions";
const MODEL = "dyslexic-writer-qwen3-4b-q4_k_m.gguf";
/** Wait after a trigger char insertion to make sure the user didn't delete it. */
const TRIGGER_VERIFY_MS = 100;
/** Skip units longer than this (sentences are short; keeps the 4B model's latency sane). */
const MAX_UNIT_CHARS = 800;
const MIN_UNIT_CHARS = 3;
/** Max times we re-send a unit that changed while the request was in flight. */
const MAX_RETRIES = 3;

/** Absolute path to the LLM exchange log (FastTyper repo root). */
const LLM_LOG_PATH = "/home/etienne/Projects/FastTyper/llm-log.txt";

/** Common abbreviations whose trailing period is not a sentence end. */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "Mr.", "Mrs.", "Ms.", "Dr.", "St.", "vs.", "no."]);

declare const require: (id: string) => any;

let fsModule: any = null;
/** Append one `sent:\n…\nreceived:\n…` exchange to LLM_LOG_PATH. */
function logExchange(sent: string, received: string): void {
    try {
        if (fsModule === null) {
            try { fsModule = require("fs"); } catch { fsModule = false; }
        }
        if (!fsModule) return;
        const ts = new Date().toISOString();
        const entry = `--- ${ts} ---\nsent:\n${sent}\nreceived:\n${received}\n\n`;
        fsModule.appendFileSync(LLM_LOG_PATH, entry, "utf8");
    } catch (e) {
        console.error("FastTyper: failed to write LLM log", e);
    }
}

export const setCorrections = StateEffect.define<AppliedCorrection[]>();
export const revertCorrection = StateEffect.define<AppliedCorrection>();
/** Commit every applied correction (clears all underline decorations). */
export const clearCorrections = StateEffect.define<null>();

/** When true, no new corrections fire (set by the pause/resume command and setting). */
let correctionsPaused = false;
/** When true, capitalize the first letter of each corrected sentence (deterministic — the model won't). */
let capitalizeInitials = true;

/** Read the correction metadata off a mark or a deletion-widget decoration. */
function correctionOf(value: Decoration): AppliedCorrection | null {
    const spec = (value as any).spec;
    if (!spec) return null;
    return spec.correction ?? spec.widget?.correction ?? null;
}

/**
 * Invisible zero-width marker placed at a deletion point so the removal stays
 * discoverable (hover to revert). `Decoration.mark` cannot be zero-length, so
 * deletions need a widget.
 */
class DeletionMarker extends WidgetType {
    constructor(readonly correction: AppliedCorrection) { super(); }
    eq(other: DeletionMarker) { return other.correction === this.correction; }
    toDOM() {
        const span = document.createElement("span");
        span.className = "grammar-deletion-marker";
        span.title = "FastTyper correction (hover to revert)";
        return span;
    }
    ignoreEvent() { return true; }
}

export const grammarCorrectionsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr: Transaction) {
        decorations = decorations.map(tr.changes);

        for (let effect of tr.effects) {
            if (effect.is(setCorrections)) {
                const newDecos: Range<Decoration>[] = [];
                for (const c of effect.value) {
                    if (c.from < c.to) {
                        newDecos.push(Decoration.mark({
                            class: 'grammar-applied-underline',
                            correction: c
                        }).range(c.from, c.to));
                    } else {
                        newDecos.push(Decoration.widget({
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
                decorations = Decoration.none;
            }
        }
        return decorations;
    },
    provide: (f) => EditorView.decorations.from(f)
});

const CONTEXT_CHARS = 10;

/** `…before[original]after…` — the typo/removed text bracketed, with a little context. */
function contextSnippet(doc: Text, from: number, to: number, original: string, replacement: string): string {
    const before = doc.sliceString(Math.max(0, from - CONTEXT_CHARS), from);
    const after = doc.sliceString(to, Math.min(doc.length, to + CONTEXT_CHARS));
    const core = original || replacement; // insertions have no original; show the added text
    const leftWs = before.match(/\s*$/)?.[0] ?? "";
    const rightWs = after.match(/^\s*/)?.[0] ?? "";
    const bText = before.slice(0, before.length - leftWs.length);
    const aText = after.slice(rightWs.length);
    const lead = leftWs.length > 0 || from === 0 ? "" : "…";
    const trail = rightWs.length > 0 || to >= doc.length ? "" : "…";
    const tag = original === "" ? " (added)" : "";
    return lead + bText + "[" + core + "]" + aText + trail + tag;
}

export const grammarTooltip = hoverTooltip((view, pos, side) => {
    let found: AppliedCorrection | null = null;
    let decoFrom = 0;
    let decoTo = 0;
    const field = view.state.field(grammarCorrectionsField, false);
    if (!field) return null;

    field.between(pos, pos, (from, to, value) => {
        const c = correctionOf(value);
        if (c) {
            found = c;
            decoFrom = from;
            decoTo = to;
        }
    });

    if (!found) return null;

    return {
        pos: decoFrom,
        end: decoTo,
        above: true,
        create(view) {
            const c = found as AppliedCorrection;
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
            snippet.textContent = contextSnippet(view.state.doc, c.from, c.to, c.originalText, c.replacement);

            const hint = document.createElement("span");
            hint.style.opacity = "0.55";
            hint.style.marginLeft = "6px";
            hint.style.fontWeight = "normal";
            hint.textContent = "click to revert";

            dom.appendChild(snippet);
            dom.appendChild(hint);

            dom.addEventListener("mousedown", (e) => {
                e.preventDefault();
                view.dispatch({
                    changes: { from: decoFrom, to: decoTo, insert: c.originalText },
                    effects: revertCorrection.of(c)
                });
            });

            return { dom };
        }
    };
});

// ---------------------------------------------------------------------------
// Response parsing + diff (dependency-free)
// ---------------------------------------------------------------------------

/** Strip Qwen3 `<think>` blocks (and any unclosed tail) and tidy the reply. */
function parseResponse(content: string): string | null {
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
function charDiff(a: string, b: string): DiffHunk[] {
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
function diffWords(a: string, b: string): DiffHunk[] {
    return charDiff(a, b).filter((h) => {
        const orig = a.slice(h.from, h.to);
        if (orig === h.replacement) return false;                       // identity
        if (orig.trim() === "" && h.replacement.trim() === "") return false; // whitespace churn
        return true;
    });
}

// ---------------------------------------------------------------------------
// Corrector ViewPlugin
// ---------------------------------------------------------------------------

const grammarCheckerPlugin = ViewPlugin.fromClass(class {
    view: EditorView;
    verifyTimeout: any = null;
    verifyPos: number | null = null;
    verifyChar: string = "";
    abortController: AbortController | null = null;
    isPending: boolean = false;
    pending: { from: number; to: number; text: string; lead: number } | null = null;
    queued: { from: number; to: number } | null = null;
    destroyed: boolean = false;
    paused: boolean = false;

    constructor(view: EditorView) {
        this.view = view;
        this.paused = correctionsPaused;
    }

    /** Pause/resume. Pausing drops queued work and aborts any in-flight request. */
    setPaused(paused: boolean) {
        this.paused = paused;
        if (paused) {
            if (this.verifyTimeout) { clearTimeout(this.verifyTimeout); this.verifyTimeout = null; }
            this.verifyPos = null;
            this.verifyChar = "";
            this.queued = null;
            if (this.abortController) this.abortController.abort();
        }
    }

    destroy() {
        this.destroyed = true;
        if (this.verifyTimeout) clearTimeout(this.verifyTimeout);
        if (this.abortController) this.abortController.abort();
        this.abortController = null;
    }

    update(update: ViewUpdate) {
        // Keep in-flight state in sync with whatever the user keeps typing.
        if (this.pending) {
            this.pending = { ...this.mapSpan(this.pending, update.changes), text: this.pending.text, lead: this.pending.lead };
        }
        if (this.queued) this.queued = this.mapSpan(this.queued, update.changes);
        if (this.verifyPos !== null) this.verifyPos = update.changes.mapPos(this.verifyPos, 1);

        if (!update.docChanged) return;

        // Ignore our own corrections/reverts so we don't re-trigger on them.
        const isAutoApply = update.transactions.some(tr => tr.effects.some(e => e.is(setCorrections) || e.is(revertCorrection) || e.is(clearCorrections)));
        if (isAutoApply) return;
        if (this.paused) return;

        const trig = this.findTrigger(update);
        if (!trig) return;

        if (this.verifyTimeout) clearTimeout(this.verifyTimeout);
        this.verifyPos = trig.pos;
        this.verifyChar = trig.ch;
        this.verifyTimeout = setTimeout(() => this.confirmTrigger(), TRIGGER_VERIFY_MS);
    }

    /** Last pure insertion of `.`/`?`/`!`/`\n` across the update's transactions. */
    private findTrigger(update: ViewUpdate): { pos: number; ch: string } | null {
        for (let t = update.transactions.length - 1; t >= 0; t--) {
            let found: { pos: number; ch: string } | null = null;
            update.transactions[t].changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                if (fromA !== toA) return; // only count pure insertions
                const s = inserted.toString();
                for (let k = s.length - 1; k >= 0; k--) {
                    const c = s[k];
                    if (c === '.' || c === '?' || c === '!' || c === '\n') {
                        found = { pos: fromB + k, ch: c };
                        break;
                    }
                }
            });
            if (found) return found;
        }
        return null;
    }

    /** Called TRIGGER_VERIFY_MS after the trigger char — confirm it survived, then fire. */
    private confirmTrigger() {
        if (this.destroyed || this.paused || this.verifyPos === null) return;
        const pos = this.verifyPos;
        const ch = this.verifyChar;
        this.verifyPos = null;
        this.verifyChar = "";

        const doc = this.view.state.doc;
        if (pos >= doc.length || doc.sliceString(pos, pos + 1) !== ch) return;

        // "." only counts as a sentence end if followed by whitespace/EOL/a closer
        // (rejects "3.14", "v1.2.3") and not an abbreviation ("e.g.", "Mr.").
        if (ch === '.') {
            const next = pos + 1 < doc.length ? doc.sliceString(pos + 1, pos + 2) : "";
            if (next !== "" && !/\s/.test(next) && !"\"')]}".includes(next)) return;
            const prev = this.prevToken(pos);
            if (prev && ABBREVIATIONS.has(prev)) return;
        }

        const span = ch === '\n' ? this.lineSpan(pos) : this.sentenceSpan(pos);
        if (!span) return;
        if (span.to - span.from > MAX_UNIT_CHARS) return;
        if (doc.sliceString(span.from, span.to).trim().length < MIN_UNIT_CHARS) return;
        if (this.containsCode(span.from, span.to)) return;

        this.queued = span;
        this.maybeFire();
    }

    /** Expand `head` to the surrounding paragraph block (blank-line delimited). */
    private paragraphRange(head: number): { from: number; to: number } {
        const doc = this.view.state.doc;
        const line = doc.lineAt(head);
        let from = line.from;
        let to = line.to;
        while (from > 0) {
            const prev = doc.lineAt(from - 1);
            if (prev.text.trim().length === 0) break;
            from = prev.from;
        }
        while (to < doc.length) {
            const next = doc.lineAt(to + 1);
            if (next.text.trim().length === 0) break;
            to = next.to;
        }
        return { from, to };
    }

    /** The sentence ending at `triggerPos` (the position of `.`/`?`/`!`). */
    private sentenceSpan(triggerPos: number): { from: number; to: number } | null {
        const doc = this.view.state.doc;
        const para = this.paragraphRange(triggerPos);

        // Walk back over the punctuation cluster that includes the trigger ("...", "?!").
        let clusterStart = triggerPos;
        while (clusterStart > para.from) {
            const c = doc.sliceString(clusterStart - 1, clusterStart);
            if (c !== '.' && c !== '?' && c !== '!') break;
            clusterStart--;
        }

        // Scan back to the previous sentence terminator (or the paragraph start).
        let from = para.from;
        for (let i = clusterStart - 1; i >= para.from; i--) {
            const c = doc.sliceString(i, i + 1);
            if (c === '.' || c === '?' || c === '!') {
                from = i + 1;
                break;
            }
        }

        // Include any trailing closers after the trigger.
        let to = triggerPos + 1;
        while (to < para.to) {
            const c = doc.sliceString(to, to + 1);
            if (c !== '"' && c !== "'" && c !== ')' && c !== ']' && c !== '}') break;
            to++;
        }

        return { from, to };
    }

    /** The line completed by the newline at `triggerPos`. */
    private lineSpan(triggerPos: number): { from: number; to: number } | null {
        const doc = this.view.state.doc;
        if (triggerPos <= 0) return null;
        const line = doc.lineAt(triggerPos - 1);
        if (line.to !== triggerPos) return null;
        return { from: line.from, to: line.to };
    }

    /** Whitespace-delimited token immediately before `pos` (including a trailing period). */
    private prevToken(pos: number): string {
        const doc = this.view.state.doc;
        if (pos <= 0) return "";
        let start = pos;
        while (start > 0) {
            if (/\s/.test(doc.sliceString(start - 1, start))) break;
            start--;
        }
        return doc.sliceString(start, pos + 1);
    }

    /** True if the range overlaps inline/fenced code or frontmatter. */
    private containsCode(from: number, to: number): boolean {
        let found = false;
        syntaxTree(this.view.state).iterate({
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
    private mapSpan(span: { from: number; to: number }, changes: ChangeSet): { from: number; to: number } {
        return { from: changes.mapPos(span.from, 1), to: changes.mapPos(span.to, -1) };
    }

    /** If no request is in flight and something is queued, start it. */
    private maybeFire() {
        if (this.isPending || this.paused || !this.queued) return;
        const span = this.queued;
        this.queued = null;
        this.fire(span);
    }

    /** Correct `span`, re-sending (≤MAX_RETRIES) if the text changes while we wait. */
    private async fire(span: { from: number; to: number }) {
        this.isPending = true;
        this.pending = { from: span.from, to: span.to, text: "", lead: 0 };
        try {
            for (let retries = 0; retries <= MAX_RETRIES; retries++) {
                const raw = this.view.state.doc.sliceString(this.pending.from, this.pending.to);
                const text = raw.trim();
                const lead = raw.length - raw.trimStart().length;
                if (text.length < MIN_UNIT_CHARS) return;
                if (this.containsCode(this.pending.from, this.pending.to)) return;
                this.pending.text = text;
                this.pending.lead = lead;

                const controller = new AbortController();
                this.abortController = controller;

                let corrected: string | null = null;
                try {
                    corrected = await this.request(text, controller.signal);
                } catch (e: any) {
                    if (e?.name !== 'AbortError') {
                        console.error("FastTyper: grammar request failed", e);
                    }
                    return;
                }
                if (this.destroyed || this.paused || this.abortController !== controller) return;
                this.abortController = null;

                if (!corrected) return; // nothing usable from the model
                corrected = this.capitalizeInitial(corrected);
                if (corrected === text) return; // no change after capitalization either

                const nowText = this.view.state.doc.sliceString(this.pending.from, this.pending.to).trim();
                if (nowText !== text) {
                    // The user edited the unit while we waited — resend with the new text.
                    if (retries < MAX_RETRIES) continue;
                    return;
                }

                const hunks = diffWords(text, corrected);
                if (hunks.length > 0) this.applyHunks(this.pending.from, this.pending.lead, hunks);
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
    private capitalizeInitial(corrected: string): string {
        if (!capitalizeInitials || corrected.length === 0) return corrected;
        const c0 = corrected[0];
        if (c0 >= 'a' && c0 <= 'z') return c0.toUpperCase() + corrected.slice(1);
        return corrected;
    }

    /** POST the unit to the daemon and return the corrected text (or null). */
    private async request(text: string, signal: AbortSignal): Promise<string | null> {
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
        let data: any;
        try {
            data = JSON.parse(rawBody);
        } catch (e) {
            return null;
        }
        const content: unknown = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") return null;

        const corrected = parseResponse(content);
        if (!corrected) return null;
        // Gross echo guard: the model shouldn't balloon the input 2x+200 chars.
        if (corrected.length > text.length * 2 + 200) return null;
        return corrected;
    }

    /** Replace the diff hunks in the doc and decorate the changed spans. */
    private applyHunks(spanFrom: number, lead: number, hunks: DiffHunk[]) {
        const doc = this.view.state.doc;
        const changes = hunks.map(h => ({
            from: spanFrom + lead + h.from,
            to: spanFrom + lead + h.to,
            insert: h.replacement
        }));
        const changeSet = ChangeSet.of(changes, doc.length);

        const applied: AppliedCorrection[] = hunks.map(h => {
            const docFrom = spanFrom + lead + h.from;
            const docTo = spanFrom + lead + h.to;
            const originalText = doc.sliceString(docFrom, docTo);
            // assoc -1: a pure insertion's mark must start AT the insertion point.
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

class FastTyperSettingTab extends PluginSettingTab {
    plugin: FastTyperPlugin;

    constructor(app: App, plugin: FastTyperPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Pause corrections")
            .setDesc("Stop triggering new corrections. Applied corrections stay until accepted or reverted.")
            .addToggle(toggle => toggle
                .setValue(correctionsPaused)
                .onChange(value => this.plugin.setPaused(value)));

        new Setting(containerEl)
            .setName("Capitalize sentence-initial letters")
            .setDesc("Capitalize the first letter of each corrected sentence. Done deterministically in the plugin (the model is spelling-only and won't do it).")
            .addToggle(toggle => toggle
                .setValue(capitalizeInitials)
                .onChange(value => this.plugin.setCapitalizeInitials(value)));

        new Setting(containerEl)
            .setName("Accept all corrections")
            .setDesc("Commit every currently-applied correction and clear its underline.")
            .addButton(button => button
                .setButtonText("Accept all")
                .setCta()
                .onClick(() => this.plugin.acceptAll()));
    }
}

export default class FastTyperPlugin extends Plugin {
    settingsTab: FastTyperSettingTab | null = null;

    async onload() {
        console.log('Loading FastTyper plugin');
        const data = await this.loadData();
        if (data?.paused) correctionsPaused = true;
        if (typeof data?.capitalizeInitials === "boolean") capitalizeInitials = data.capitalizeInitials;

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

        // Editors already open need their ViewPlugin instances told about the
        // loaded pause state (new ones pick it up in their constructor).
        this.applyPauseState();
    }

    onunload() {
        console.log('Unloading FastTyper plugin');
    }

    /** Commit every applied correction: clears all underline decorations. */
    acceptAll() {
        const cv = this.activeCm();
        if (!cv) return;
        cv.dispatch({ effects: clearCorrections.of(null) });
    }

    /** Toggle corrections on/off across all open editors and persist the choice. */
    async setPaused(paused: boolean) {
        correctionsPaused = paused;
        await this.saveSettings();
        this.applyPauseState();
        this.settingsTab?.display();
        new Notice(paused ? "FastTyper: corrections paused" : "FastTyper: corrections resumed");
    }

    /** Toggle sentence-initial capitalization and persist. */
    async setCapitalizeInitials(value: boolean) {
        capitalizeInitials = value;
        await this.saveSettings();
        this.settingsTab?.display();
    }

    /** Persist the current settings to plugin data. */
    private async saveSettings() {
        await this.saveData({ paused: correctionsPaused, capitalizeInitials });
    }

    /** Push the current pause state to every open editor's corrector instance. */
    private applyPauseState() {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view as MarkdownView;
            ((view.editor as any)?.cm as EditorView | undefined)
                ?.plugin(grammarCheckerPlugin)?.setPaused(correctionsPaused);
        }
    }

    /** The CM6 EditorView backing the active markdown editor, if any. */
    private activeCm(): EditorView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return null;
        return ((view.editor as any)?.cm as EditorView) ?? null;
    }
}
