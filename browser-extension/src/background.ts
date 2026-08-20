/**
 * FastTyper background worker.
 *
 * All llama-server traffic goes through here (host_permissions lets the
 * background context fetch localhost without the page's CORS policy), and the
 * recent-exchange log is kept in storage.local (a browser extension has no
 * filesystem access, so the Obsidian plugin's llm-log.txt isn't available).
 */
import {
  buildPayload, DEFAULT_LLM_BASE, DEFAULT_MODEL, parseResponse, resolvePrompt, PROMPT_PRESETS,
  type Request, type Response, type LogEntry, type PushMsg, type ThinkingMode,
} from "./shared";

const LOG_KEY = "llmLog";
const SETTINGS_KEY = "settings";
const LOG_CAP = 50;

interface Settings {
  paused: boolean;
  capitalize: boolean;
  blacklist: string[];
  /** Active prompt preset id (`PROMPT_PRESETS[i].id` or `"custom"`). */
  promptId: string;
  /** Custom system message (used when `promptId === "custom"`). */
  customSystem: string;
  /** Custom user-message template with `{text}` (used when `promptId === "custom"`). */
  customUser: string;
  /** Thinking mode: "fast" flat only · "auto" flat then E+thinking on a no-op · "always" E+thinking every request. */
  thinkingMode: ThinkingMode;
  llmBase: string;
  model: string;
}

const DEFAULT_SETTINGS: Settings = {
  paused: false,
  capitalize: true,
  blacklist: [],
  promptId: "A",
  customSystem: PROMPT_PRESETS[0].system,
  customUser: PROMPT_PRESETS[0].user,
  thinkingMode: "auto",
  llmBase: DEFAULT_LLM_BASE,
  model: DEFAULT_MODEL,
};

async function getSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: s });
  await broadcast({ type: "settings", paused: s.paused, capitalize: s.capitalize, blacklist: s.blacklist, thinkingMode: s.thinkingMode });
}

async function broadcast(msg: PushMsg): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    if (!t.url?.startsWith("http://") && !t.url?.startsWith("https://")) continue;
    browser.tabs.sendMessage(t.id, msg).catch(() => {}); // tab may not have a content script yet
  }
}

async function appendLog(entry: LogEntry): Promise<void> {
  const got = await browser.storage.local.get(LOG_KEY);
  const list = (got[LOG_KEY] as LogEntry[] | undefined) ?? [];
  list.push(entry);
  while (list.length > LOG_CAP) list.shift();
  await browser.storage.local.set({ [LOG_KEY]: list });
}

async function getLog(): Promise<LogEntry[]> {
  const got = await browser.storage.local.get(LOG_KEY);
  return (got[LOG_KEY] as LogEntry[] | undefined) ?? [];
}

/** The tab id → AbortController for every daemon request in flight (for the halt command). */
const inFlight = new Map<number, AbortController>();

/** POST a sentence to the daemon → the corrected text (or null). */
async function correct(text: string, thinking: boolean, url?: string, tabId?: number): Promise<string | null> {
  const s = await getSettings();
  const promptId = thinking ? "E" : s.promptId;
  const body = JSON.stringify(buildPayload(s.model, text, resolvePrompt(promptId, s.customSystem, s.customUser), thinking));
  const controller = new AbortController();
  if (typeof tabId === "number") inFlight.set(tabId, controller);
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(`${s.llmBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const rawBody = await resp.text();
    appendLog({ ts: new Date().toISOString(), url, sent: body, received: rawBody });
    if (!resp.ok) return null;

    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const content = (data as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const corrected = parseResponse(content);
    if (!corrected) return null;
    // Gross echo guard: the model shouldn't balloon the input 2x+200 chars.
    if (corrected.length > text.length * 2 + 200) return null;
    return corrected;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (typeof tabId === "number") inFlight.delete(tabId);
  }
}

/**
 * Halt the correction in a tab: abort the daemon fetch for that tab (so the
 * model actually stops thinking) and tell its content script to drop queued +
 * in-flight work.
 */
async function haltProcessing(tabId?: number): Promise<void> {
  if (typeof tabId === "number") inFlight.get(tabId)?.abort();
  await broadcast({ type: "halt" });
}

let _wordSet: Set<string> | null = null;
async function wordSet(): Promise<Set<string>> {
  if (_wordSet === null) {
    try {
      const url = browser.runtime.getURL("wordlist.json");
      const resp = await fetch(url);
      const list = await resp.json();
      _wordSet = new Set(list);
    } catch {
      _wordSet = new Set();
    }
  }
  return _wordSet;
}

// Mirrors obsidian-plugin/src/main.ts hasSuspectTokens() exactly: never flags
// digit-bordered tokens ("v2"), any-uppercase tokens (proper nouns + the
// capitalized sentence start), or apostrophe tokens (contractions). Lone
// lowercase "i" is a real typo for "I" and *is* a dictionary word, so it's
// flagged explicitly.
const SUSPECT_REGEX = /[a-z]+(?:'[a-z]+)*/gi;
async function hasSuspectTokens(text: string): Promise<boolean> {
  const ws = await wordSet();
  SUSPECT_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUSPECT_REGEX.exec(text)) !== null) {
    const raw = m[0];
    if (/\d/.test(text[m.index - 1] ?? "") || /\d/.test(text[m.index + raw.length] ?? "")) continue;
    if (/[A-Z]/.test(raw)) continue;
    const token = raw.toLowerCase();
    if (token.includes("'")) continue;      // don't, it's, James'
    if (token.length === 1) { if (token === "i") return true; continue; }
    if (!ws.has(token)) return true;
  }
  return false;
}

/** Cheap reachability probe so the popup can show a daemon-status dot. */
async function daemonUp(): Promise<boolean | null> {
  const s = await getSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetch(`${s.llmBase}/v1/models`, { signal: controller.signal });
    return resp.ok;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

browser.runtime.onMessage.addListener(
  (msg: Request, sender): Promise<Response> => {
    switch (msg.type) {
      case "correct":
        return correct(msg.text, msg.thinking, sender.tab?.url, sender.tab?.id).then(
          (corrected): Response => ({ type: "correctResult", corrected })
        );

      case "halt":
        return haltProcessing(sender.tab?.id).then(
          (): Response => ({ type: "correctResult", corrected: null })
        );

      case "checkSuspects":
        return hasSuspectTokens(msg.text).then(
          (suspects): Response => ({ type: "checkSuspectsResult", suspects })
        );

      case "acceptAll":
        return broadcast({ type: "acceptAll" }).then(
          (): Response => ({ type: "correctResult", corrected: null })
        );

      case "setPaused":
        return getSettings().then((s) =>
          saveSettings({ ...s, paused: msg.paused }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setCapitalize":
        return getSettings().then((s) =>
          saveSettings({ ...s, capitalize: msg.value }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setPrompt":
        return getSettings().then((s) =>
          saveSettings({ ...s, promptId: msg.promptId }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setCustomSystem":
        return getSettings().then((s) =>
          saveSettings({ ...s, customSystem: msg.value }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setCustomUser":
        return getSettings().then((s) =>
          saveSettings({ ...s, customUser: msg.value }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setBlacklist":
        return getSettings().then((s) =>
          saveSettings({ ...s, blacklist: msg.blacklist }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setThinkingMode":
        return getSettings().then((s) =>
          saveSettings({ ...s, thinkingMode: msg.thinkingMode }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setLlmBase":
        return getSettings().then((s) =>
          saveSettings({ ...s, llmBase: msg.value }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "setModel":
        return getSettings().then((s) =>
          saveSettings({ ...s, model: msg.value }).then(
            (): Response => ({ type: "correctResult", corrected: null })
          )
        );

      case "getState":
        return Promise.all([getSettings(), daemonUp()]).then(
          ([s, up]): Response => ({ type: "state", paused: s.paused, capitalize: s.capitalize, blacklist: s.blacklist, promptId: s.promptId, customSystem: s.customSystem, customUser: s.customUser, thinkingMode: s.thinkingMode, llmBase: s.llmBase, model: s.model, daemonUp: up })
        );

      case "getLog":
        return getLog().then((entries): Response => ({
          type: "log",
          entries: entries.map((e) =>
            `--- ${e.ts}${e.url ? "  (" + e.url + ")" : ""} ---\nsent:\n${e.sent}\nreceived:\n${e.received}\n`
          ),
        }));
    }
  }
);

browser.commands.onCommand.addListener((command) => {
  if (command === "toggle-corrections") {
    getSettings().then((s) => saveSettings({ ...s, paused: !s.paused }));
  } else if (command === "halt-corrections") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => haltProcessing(tabs[0]?.id));
  }
});
