/** FastTyper popup: mirrors the Obsidian plugin's pause/capitalize/accept-all controls. */
import type { Response } from "./shared";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Show the custom system/user textareas only when the Custom prompt is selected. */
function toggleCustom(promptId: string) {
  ($("customPrompts") as HTMLElement).hidden = promptId !== "custom";
}

async function refresh(): Promise<void> {
  const st = (await browser.runtime.sendMessage({ type: "getState" })) as Response;
  if (st.type !== "state") return;
  ($("paused") as HTMLInputElement).checked = st.paused;
  ($("capitalize") as HTMLInputElement).checked = st.capitalize;
  ($("prompt") as HTMLSelectElement).value = st.promptId;
  ($("thinkingMode") as HTMLSelectElement).value = st.thinkingMode;
  ($("customSystem") as HTMLTextAreaElement).value = st.customSystem;
  ($("customUser") as HTMLTextAreaElement).value = st.customUser;
  toggleCustom(st.promptId);
  ($("blacklist") as HTMLTextAreaElement).value = (st.blacklist ?? []).join("\n");
  const status = $("status");
  status.textContent =
    st.daemonUp === true
      ? "Daemon: connected (" + st.llmBase + ")"
      : st.daemonUp === null
        ? "Daemon: not reachable — is the fasttyper service running?"
        : "Daemon: error";
  status.className = "status " + (st.daemonUp ? "ok" : "bad");
}

($("paused") as HTMLInputElement).addEventListener("change", (e) => {
  void browser.runtime.sendMessage({ type: "setPaused", paused: (e.target as HTMLInputElement).checked });
});
($("capitalize") as HTMLInputElement).addEventListener("change", (e) => {
  void browser.runtime.sendMessage({ type: "setCapitalize", value: (e.target as HTMLInputElement).checked });
});
($("prompt") as HTMLSelectElement).addEventListener("change", (e) => {
  const id = (e.target as HTMLSelectElement).value;
  toggleCustom(id);
  void browser.runtime.sendMessage({ type: "setPrompt", promptId: id });
});
($("thinkingMode") as HTMLSelectElement).addEventListener("change", (e) => {
  const mode = (e.target as HTMLSelectElement).value as "fast" | "auto" | "always";
  void browser.runtime.sendMessage({ type: "setThinkingMode", thinkingMode: mode });
});
($("customSystem") as HTMLTextAreaElement).addEventListener("input", (e) => {
  void browser.runtime.sendMessage({ type: "setCustomSystem", value: (e.target as HTMLTextAreaElement).value });
});
($("customUser") as HTMLTextAreaElement).addEventListener("input", (e) => {
  void browser.runtime.sendMessage({ type: "setCustomUser", value: (e.target as HTMLTextAreaElement).value });
});
$("acceptAll").addEventListener("click", () => {
  void browser.runtime.sendMessage({ type: "acceptAll" });
});
$("saveBlacklist").addEventListener("click", () => {
  const raw = ($("blacklist") as HTMLTextAreaElement).value;
  const list = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  void browser.runtime.sendMessage({ type: "setBlacklist", blacklist: list });
});
$("logWrap").addEventListener("toggle", () => {
  void browser.runtime.sendMessage({ type: "getLog" }).then((r) => {
    const resp = r as Response;
    if (resp.type === "log") $("log").textContent = resp.entries.join("\n") || "(no exchanges yet)";
  });
});

void refresh();
