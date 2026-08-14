/**
 * FastTyper background worker.
 *
 * All llama-server traffic goes through here (host_permissions lets the
 * background context fetch localhost without the page's CORS policy), and the
 * recent-exchange log is kept in storage.local (a browser extension has no
 * filesystem access, so the Obsidian plugin's llm-log.txt isn't available).
 */
import {
  buildPayload, LLM_URL, LLM_BASE, parseResponse,
  type Request, type Response, type LogEntry, type PushMsg,
} from "./shared";

const LOG_KEY = "llmLog";
const SETTINGS_KEY = "settings";
const LOG_CAP = 50;

interface Settings {
  paused: boolean;
  capitalize: boolean;
}

const DEFAULT_SETTINGS: Settings = { paused: false, capitalize: true };

async function getSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: s });
  await broadcast({ type: "settings", paused: s.paused, capitalize: s.capitalize });
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
  const body = JSON.stringify(buildPayload(text));
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

      case "getState":
        return Promise.all([getSettings(), daemonUp()]).then(
          ([s, up]): Response => ({ type: "state", paused: s.paused, capitalize: s.capitalize, daemonUp: up })
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
