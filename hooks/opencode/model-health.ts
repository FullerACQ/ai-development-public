// OpenCode plugin: surface model failures in the TUI instead of only in
// ~/.local/share/opencode/log/opencode.log. Retries, errors, and stalls inside
// subagents are otherwise invisible from the parent session, which reads as
// "opencode stopped responding".
//   - session.status retry → warning toast (attempt, provider message, next try)
//   - session.error        → error toast (aborts are user-initiated; skipped)
//   - busy with no model output for STALL_MS, outside a running tool → warning
import type { Plugin } from "@opencode-ai/plugin";

const STALL_MS = 3 * 60_000;
const CHECK_MS = 30_000;

type Variant = "info" | "success" | "warning" | "error";
type Activity = { lastOutput: number; toolsRunning: Set<string>; stallWarned: boolean };

export const ModelHealth: Plugin = async ({ client }) => {
  const titles = new Map<string, string>();
  const busy = new Map<string, Activity>();

  const label = (sessionID: string | undefined): string =>
    (sessionID && titles.get(sessionID)) ?? sessionID?.slice(-8) ?? "session";

  const toast = (variant: Variant, title: string, message: string): void => {
    client.tui
      .showToast({ body: { title, message: message.slice(0, 300), variant, duration: 10_000 } })
      .catch(() => {}); // headless `opencode run` has no TUI to receive it
  };

  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const [sessionID, a] of busy) {
      if (a.stallWarned || a.toolsRunning.size > 0 || now - a.lastOutput < STALL_MS) continue;
      a.stallWarned = true;
      const minutes = Math.round((now - a.lastOutput) / 60_000);
      toast("warning", `Model stalled: ${label(sessionID)}`, `No output for ${minutes}m. See opencode.log.`);
    }
  }, CHECK_MS);

  return {
    dispose: async () => clearInterval(watchdog),
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const { id, title, parentID } = event.properties.info;
          titles.set(id, parentID ? `subagent "${title}"` : title);
          return;
        }
        case "session.status": {
          const { sessionID, status } = event.properties;
          if (status.type === "idle") {
            busy.delete(sessionID);
            return;
          }
          if (!busy.has(sessionID)) {
            busy.set(sessionID, { lastOutput: Date.now(), toolsRunning: new Set(), stallWarned: false });
          }
          if (status.type === "retry") {
            const wait = Math.max(0, Math.round((status.next - Date.now()) / 1000));
            toast("warning", `Retry #${status.attempt}: ${label(sessionID)}`, `${status.message} (next try in ${wait}s)`);
          }
          return;
        }
        case "session.error": {
          const { sessionID, error } = event.properties;
          if (!error || error.name === "MessageAbortedError") return;
          const message = "message" in error.data ? String(error.data.message) : error.name;
          toast("error", `Model error: ${label(sessionID)}`, message);
          return;
        }
        case "message.part.updated": {
          const { part } = event.properties;
          const a = busy.get(part.sessionID);
          if (!a) return;
          a.lastOutput = Date.now();
          a.stallWarned = false;
          if (part.type !== "tool") return;
          if (part.state.status === "running" || part.state.status === "pending") a.toolsRunning.add(part.callID);
          else a.toolsRunning.delete(part.callID);
          return;
        }
        default:
          return;
      }
    },
  };
};
