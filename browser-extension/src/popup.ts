/** FastTyper popup: mirrors the Obsidian plugin's pause/capitalize/accept-all controls. */
import type { Response } from "./shared";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function refresh(): Promise<void> {
  const st = (await browser.runtime.sendMessage({ type: "getState" })) as Response;
  if (st.type !== "state") return;
  ($("paused") as HTMLInputElement).checked = st.paused;
  ($("capitalize") as HTMLInputElement).checked = st.capitalize;
  const status = $("status");
  status.textContent =
    st.daemonUp === true
      ? "Daemon: connected (127.0.0.1:8808)"
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
$("acceptAll").addEventListener("click", () => {
  void browser.runtime.sendMessage({ type: "acceptAll" });
});
$("logWrap").addEventListener("toggle", () => {
  void browser.runtime.sendMessage({ type: "getLog" }).then((r) => {
    const resp = r as Response;
    if (resp.type === "log") $("log").textContent = resp.entries.join("\n") || "(no exchanges yet)";
  });
});

void refresh();
