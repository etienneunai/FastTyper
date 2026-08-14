/**
 * FastTyper background worker.
 *
 * All llama-server traffic goes through here (host_permissions lets the
 * background context fetch localhost without the page's CORS policy), and the
 * recent-exchange log is kept in storage.local (a browser extension has no
 * filesystem access, so the Obsidian plugin's llm-log.txt isn't available).
 */
import {
  buildPayload, LLM_URL, LLM_BASE, parseResponse, resolvePrompt, PROMPT_PRESETS,
  type Request, type Response, type LogEntry, type PushMsg,
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
}

const DEFAULT_SETTINGS: Settings = {
  paused: false,
  capitalize: true,
  blacklist: [],
  promptId: "A",
  customSystem: PROMPT_PRESETS[0].system,
  customUser: PROMPT_PRESETS[0].user,
};

async function getSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: s });
  await broadcast({ type: "settings", paused: s.paused, capitalize: s.capitalize, blacklist: s.blacklist });
}

async function broadcast(msg: PushMsg): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
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

/** POST a sentence to the daemon → the corrected text (or null). */
async function correct(text: string, url?: string): Promise<string | null> {
  const s = await getSettings();
  const body = JSON.stringify(buildPayload(text, resolvePrompt(s.promptId, s.customSystem, s.customUser)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(LLM_URL, {
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
  }
}

/** Cheap reachability probe so the popup can show a daemon-status dot. */
async function daemonUp(): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetch(`${LLM_BASE}/v1/models`, { signal: controller.signal });
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
        return correct(msg.text, sender.tab?.url).then(
          (corrected): Response => ({ type: "correctResult", corrected })
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

      case "getState":
        return Promise.all([getSettings(), daemonUp()]).then(
          ([s, up]): Response => ({ type: "state", paused: s.paused, capitalize: s.capitalize, blacklist: s.blacklist, promptId: s.promptId, customSystem: s.customSystem, customUser: s.customUser, daemonUp: up })
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
  }
});
