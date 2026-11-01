// OpenCode plugin: mirrors the agent's turn state into this cmux workspace's
// sidebar row as a status pill — a spinner while the model is working, a bell
// while it waits on you (a question, a permission prompt, or the next prompt).
// Inert outside cmux. Icons are SF Symbol names (`cmux set-status --icon`).
import type { Plugin } from "@opencode-ai/plugin";

type Pill = "working" | "needs-input" | "your-turn";

type PillStyle = {
  readonly label: string;
  readonly icon: string;
  readonly color: string;
  readonly priority: number;
};

// Colors and the needs-input priority match cmux's own agent pills, so this
// sits naturally next to Claude Code's.
const PILLS: Readonly<Record<Pill, PillStyle>> = {
  working: { label: "Working", icon: "progress.indicator", color: "#4C8DFF", priority: 0 },
  "needs-input": { label: "Needs input", icon: "bell.fill", color: "#FF9500", priority: 100 },
  "your-turn": { label: "Your turn", icon: "bell.fill", color: "#8E8E93", priority: 0 },
};

// The subset of the event bus this plugin reacts to. OpenCode emits both the
// v1 (`permission.updated`, `permissionID`) and v2 (`permission.asked`,
// `requestID`) shapes depending on build, so both are decoded.
type Transition =
  | { readonly kind: "busy"; readonly sessionID: string }
  | { readonly kind: "idle"; readonly sessionID: string }
  | { readonly kind: "asked"; readonly sessionID: string; readonly requestID: string }
  | { readonly kind: "answered"; readonly requestID: string }
  | { readonly kind: "disposed" };

function assertNever(value: never): never {
  throw new Error(`cmux-status: unhandled transition ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decode(type: string, props: Record<string, unknown>): Transition | null {
  switch (type) {
    case "session.status": {
      const sessionID = str(props, "sessionID");
      const status = isRecord(props.status) ? str(props.status, "type") : null;
      if (!sessionID || !status) return null;
      // "retry" is a provider backoff inside a turn: still working.
      return status === "idle" ? { kind: "idle", sessionID } : { kind: "busy", sessionID };
    }
    case "session.idle": {
      const sessionID = str(props, "sessionID");
      return sessionID ? { kind: "idle", sessionID } : null;
    }
    case "session.deleted": {
      const sessionID = isRecord(props.info) ? str(props.info, "id") : null;
      return sessionID ? { kind: "idle", sessionID } : null;
    }
    case "question.asked":
    case "permission.asked":
    case "permission.updated": {
      const sessionID = str(props, "sessionID");
      const requestID = str(props, "id");
      return sessionID && requestID ? { kind: "asked", sessionID, requestID } : null;
    }
    case "question.replied":
    case "question.rejected":
    case "permission.replied": {
      // v2 replies carry requestID; v1 permission.replied carries permissionID.
      const requestID = str(props, "requestID") ?? str(props, "permissionID");
      return requestID ? { kind: "answered", requestID } : null;
    }
    case "server.instance.disposed":
      return { kind: "disposed" };
    default:
      return null;
  }
}

export const CmuxStatus: Plugin = async ({ client }) => {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  const surface = process.env.CMUX_SURFACE_ID;
  if (!workspace || !surface) return {};

  // One pill per terminal surface, so two OpenCode panes in one workspace
  // don't overwrite each other.
  const key = `opencode.${surface}`;
  const busy = new Set<string>();
  const pending = new Map<string, string>(); // requestID -> sessionID
  let shown: Pill | "cleared" | null = null;
  let queue: Promise<void> = Promise.resolve();

  const warn = (message: string, extra: Readonly<Record<string, unknown>>) =>
    client.app.log({ body: { service: "cmux-status", level: "warn", message, extra: { key, ...extra } } });

  const cmux = async (args: readonly string[]): Promise<void> => {
    // FALLBACK: the pill is cosmetic; a cmux socket hiccup or missing binary
    // must never fail the agent's turn or wedge the render queue. Logged so a
    // persistent failure is visible.
    try {
      const proc = Bun.spawn(["cmux", ...args, "--workspace", workspace], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) await warn(`cmux ${args[0]} exited ${code}`, { stderr: stderr.slice(0, 200) });
    } catch (error) {
      await warn(`cmux ${args[0]} failed to run`, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Serialized so a fast busy -> idle flip can't land out of order.
  const show = (next: Pill | "cleared"): void => {
    if (next === shown) return;
    shown = next;
    queue = queue.then(() => {
      if (next === "cleared") return cmux(["clear-status", key]);
      const pill = PILLS[next];
      return cmux([
        "set-status", key, pill.label,
        "--icon", pill.icon,
        "--color", pill.color,
        "--priority", String(pill.priority),
      ]);
    });
  };

  const current = (): Pill => {
    if (pending.size > 0) return "needs-input";
    if (busy.size > 0) return "working";
    return "your-turn";
  };

  const apply = (t: Transition): void => {
    switch (t.kind) {
      case "busy":
        busy.add(t.sessionID);
        break;
      case "idle":
        busy.delete(t.sessionID);
        // An idle session can't still be waiting on its own question
        // (e.g. the turn was aborted with the prompt open).
        for (const [requestID, sessionID] of pending) {
          if (sessionID === t.sessionID) pending.delete(requestID);
        }
        break;
      case "asked":
        pending.set(t.requestID, t.sessionID);
        break;
      case "answered":
        pending.delete(t.requestID);
        break;
      case "disposed":
        show("cleared");
        return;
      default:
        assertNever(t);
    }
    show(current());
  };

  // Don't leave a stale pill behind when OpenCode quits.
  process.once("exit", () => {
    Bun.spawnSync(["cmux", "clear-status", key, "--workspace", workspace]);
  });

  show("your-turn");

  return {
    event: async ({ event }) => {
      const props: unknown = event.properties;
      if (!isRecord(props)) return;
      const transition = decode(event.type, props);
      if (transition) apply(transition);
    },
  };
};
