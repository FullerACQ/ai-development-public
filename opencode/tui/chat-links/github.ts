import { execFile } from "node:child_process";

export type GitHubPrTarget = Readonly<{
  canonicalUrl: string;
  owner: string;
  repo: string;
  number: number;
}>;

export type PrLifecycle = "open" | "draft" | "merged" | "closed";
export type CiState = "passed" | "failed" | "pending" | "unknown";
export type PrCheckOutcome = "passed" | "failed" | "pending" | "ignored" | "unknown";
/** Tooltip-ready check data; url is an optional, validated HTTP(S) detail link. */
export type PrCheckDetail = Readonly<{ name: string; outcome: PrCheckOutcome; url: string | null }>;
export type GitHubPrStatus = Readonly<{
  target: GitHubPrTarget;
  url: string;
  title: string;
  lifecycle: PrLifecycle;
  ci: CiState;
  ciReason: string | null;
  checks: readonly PrCheckDetail[];
}>;

export type GitHubPrErrorKind =
  | "invalid-target"
  | "invalid-response"
  | "unavailable"
  | "missing-gh"
  | "authentication"
  | "timeout"
  | "aborted"
  | "output-limit";
export type GitHubPrError = Readonly<{ kind: GitHubPrErrorKind; message: string }>;
export type GitHubPrResult =
  | Readonly<{ ok: true; value: GitHubPrStatus }>
  | Readonly<{ ok: false; error: GitHubPrError }>;

export const GH_REQUEST_TIMEOUT_MS = 20_000;
export const GH_MAX_OUTPUT_BYTES = 256 * 1024;
export const PR_CHECK_NAME_MAX_LENGTH = 200;
export const PR_CHECK_URL_MAX_LENGTH = 2_048;
export const GH_PR_JSON_FIELDS = "state,isDraft,title,statusCheckRollup,url";
export const GH_PR_JQ =
  "{state,isDraft,title,url,statusCheckRollup:(.statusCheckRollup | if . == null then null else map({__typename,state,status,conclusion,name,context,detailsUrl,targetUrl}) end)}";

/** GitHub names are case insensitive; query, fragment, and tab never enter the key. */
export function parseGitHubPrTarget(raw: string): GitHubPrTarget | null {
  // Match the raw path as well: URL alone would normalize dot-segment traversal.
  const authority = raw.match(/^https?:\/\/github\.com(?::(?:80|443))?(\/[^?#]*)(?:[?#][\s\S]*)?$/iu);
  if (authority === null || /[\s\u0000-\u001f\u007f-\u009f]/u.test(raw)) return null;
  const path = authority[1]!.match(
    /^\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/([a-z0-9_.-]+)\/pull\/([0-9]+)(?:\/(?:files|commits|checks))?\/?$/iu,
  );
  if (path === null || path[2] === "." || path[2] === "..") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "github.com" || url.port !== "") return null;
  } catch {
    // FALLBACK: a malformed chat URL is an ordinary non-PR link.
    return null;
  }
  const number = Number(path[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const owner = path[1]!.toLowerCase();
  const repo = path[2]!.toLowerCase();
  return { owner, repo, number, canonicalUrl: `https://github.com/${owner}/${repo}/pull/${number}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CheckRunStatus = "COMPLETED" | "PENDING" | "UNKNOWN";
type CheckConclusion = "SUCCESS" | "FAILURE" | "SKIPPED" | "NEUTRAL" | "UNKNOWN" | null;
type PrCheckMetadata = Readonly<{ name: string; url: string | null }>;
export type PrCheck =
  | Readonly<PrCheckMetadata & { type: "check-run"; status: CheckRunStatus; conclusion: CheckConclusion }>
  | Readonly<PrCheckMetadata & { type: "status-context"; state: "SUCCESS" | "FAILURE" | "PENDING" | "SKIPPED" | "NEUTRAL" | "UNKNOWN" }>;

function parseCheckMetadata(rawName: unknown, rawUrl: unknown): PrCheckMetadata | null {
  if (!(rawName == null || typeof rawName === "string") || !(rawUrl == null || typeof rawUrl === "string")) return null;
  // FALLBACK: older gh fixtures omit names and jq emits null for missing fields;
  // retain their CI evidence and label empty/sanitized-away names explicitly.
  const name = typeof rawName === "string" ? sanitizeTerminalText(rawName).slice(0, PR_CHECK_NAME_MAX_LENGTH) : "";
  // FALLBACK: missing or empty display names are supported by older check data.
  return { name: name.length > 0 ? name : "Unnamed check", url: parseCheckDetailUrl(rawUrl) };
}

function parseCheckDetailUrl(raw: string | null | undefined): string | null {
  // FALLBACK: CI providers do not always publish a detail link.
  if (raw == null || raw === "") return null;
  // FALLBACK: optional tooltip links that are unsafe or too long are omitted;
  // truncating/rewriting a URL would change its destination, not its CI outcome.
  if (raw.length > PR_CHECK_URL_MAX_LENGTH || sanitizeTerminalText(raw) !== raw || /\s/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    // FALLBACK: only HTTP(S) detail links are usable by the chat-link opener.
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "" || url.username !== "" || url.password !== "") return null;
    return raw;
  } catch {
    // FALLBACK: a malformed optional detail URL does not invalidate CI evidence.
    return null;
  }
}

function conclusion(value: string | null): CheckConclusion {
  switch (value) {
    case null: return null;
    case "SUCCESS": return "SUCCESS";
    case "FAILURE":
    case "ERROR":
    case "CANCELLED":
    case "CANCELED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE": return "FAILURE";
    case "SKIPPED": return "SKIPPED";
    case "NEUTRAL": return "NEUTRAL";
    default: return "UNKNOWN";
  }
}

function parseCheck(raw: unknown): PrCheck | null {
  if (!isRecord(raw)) return null;
  if (raw.__typename === "CheckRun" || (raw.__typename == null && typeof raw.status === "string")) {
    if (typeof raw.status !== "string" || !(raw.conclusion === null || typeof raw.conclusion === "string")) return null;
    const metadata = parseCheckMetadata(raw.name, raw.detailsUrl);
    if (metadata === null) return null;
    const status = raw.status.toUpperCase();
    return {
      ...metadata,
      type: "check-run",
      status: status === "COMPLETED" ? "COMPLETED"
        : ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"].includes(status) ? "PENDING" : "UNKNOWN",
      conclusion: conclusion(raw.conclusion === null ? null : raw.conclusion.toUpperCase()),
    };
  }
  if (raw.__typename === "StatusContext" || (raw.__typename == null && typeof raw.state === "string")) {
    if (typeof raw.state !== "string") return null;
    const metadata = parseCheckMetadata(raw.context, raw.targetUrl);
    if (metadata === null) return null;
    const state = raw.state.toUpperCase();
    return {
      ...metadata,
      type: "status-context",
      state: state === "SUCCESS" ? "SUCCESS"
        : ["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED"].includes(state) ? "FAILURE"
        : ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"].includes(state) ? "PENDING"
        : state === "SKIPPED" ? "SKIPPED" : state === "NEUTRAL" ? "NEUTRAL" : "UNKNOWN",
    };
  }
  return null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled PR check variant: ${String(value)}`);
}

function checkOutcome(check: PrCheck): PrCheckOutcome {
  switch (check.type) {
    case "status-context":
      switch (check.state) {
        case "SUCCESS": return "passed";
        case "FAILURE": return "failed";
        case "PENDING": return "pending";
        case "NEUTRAL":
        case "SKIPPED": return "ignored";
        case "UNKNOWN": return "unknown";
        default: return assertNever(check.state);
      }
    case "check-run":
      // A failed conclusion dominates even a stale/inconsistent in-progress status.
      if (check.conclusion === "FAILURE") return "failed";
      switch (check.status) {
        case "PENDING": return "pending";
        case "UNKNOWN": return "unknown";
        case "COMPLETED":
          switch (check.conclusion) {
            case "SUCCESS": return "passed";
            case "NEUTRAL":
            case "SKIPPED": return "ignored";
            case "UNKNOWN":
            case null: return "unknown";
            default: return assertNever(check.conclusion);
          }
        default: return assertNever(check.status);
      }
    default: return assertNever(check);
  }
}

export function summarizePrChecks(checks: readonly PrCheck[] | null): Readonly<{ ci: CiState; ciReason: string | null }> {
  if (checks === null || checks.length === 0) {
    return { ci: "unknown", ciReason: "No CI checks reported" };
  }
  const outcomes = checks.map(checkOutcome);
  if (outcomes.includes("failed")) return { ci: "failed", ciReason: null };
  if (outcomes.includes("pending")) return { ci: "pending", ciReason: null };
  if (outcomes.includes("unknown")) return { ci: "unknown", ciReason: "CI includes an unrecognized or incomplete check" };
  if (outcomes.includes("passed")) return { ci: "passed", ciReason: null };
  return { ci: "unknown", ciReason: "All CI checks are skipped or neutral" };
}

/** Remove ANSI/OSC escapes and control characters from untrusted terminal text. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$)/gu, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

function failure(kind: GitHubPrErrorKind, message: string): GitHubPrResult {
  return { ok: false, error: { kind, message: sanitizeTerminalText(message).slice(0, 400) } };
}

export function parseGitHubPrResponse(raw: string, target: GitHubPrTarget): GitHubPrResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // FALLBACK: gh is an optional status source; malformed output is unavailable.
    return failure("invalid-response", "GitHub CLI returned invalid JSON");
  }
  if (!isRecord(data) || typeof data.title !== "string" || typeof data.url !== "string"
    || typeof data.isDraft !== "boolean" || typeof data.state !== "string" || !["OPEN", "MERGED", "CLOSED"].includes(data.state)
    || !(data.statusCheckRollup === null || Array.isArray(data.statusCheckRollup))) {
    return failure("invalid-response", "GitHub CLI returned an invalid PR response");
  }
  const returnedTarget = parseGitHubPrTarget(data.url);
  if (returnedTarget === null || returnedTarget.canonicalUrl !== target.canonicalUrl) {
    return failure("invalid-response", "GitHub CLI returned a different or invalid PR URL");
  }
  const checks: PrCheck[] = [];
  if (data.statusCheckRollup !== null) {
    for (const rawCheck of data.statusCheckRollup) {
      const check = parseCheck(rawCheck);
      if (check === null) return failure("invalid-response", "GitHub CLI returned a malformed CI check");
      checks.push(check);
    }
  }
  const lifecycle: PrLifecycle = data.state === "MERGED" ? "merged"
    : data.state === "CLOSED" ? "closed" : data.isDraft ? "draft" : "open";
  return {
    ok: true,
    value: {
      target, url: returnedTarget.canonicalUrl, title: sanitizeTerminalText(data.title), lifecycle,
      ...summarizePrChecks(data.statusCheckRollup === null ? null : checks),
      checks: checks.map((check) => ({ name: check.name, outcome: checkOutcome(check), url: check.url })),
    },
  };
}

export type GhExecOptions = Readonly<{
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}>;
export type GhExecutor = (
  file: string, args: readonly string[], options: GhExecOptions,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

/** execFile uses an argument vector, never a shell or an interpolated command. */
export const executeGh: GhExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error !== null) {
      reject(Object.assign(error, { stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});

export type GitHubPrClient = Readonly<{
  fetch(target: GitHubPrTarget, signal?: AbortSignal): Promise<GitHubPrResult>;
}>;
export type GitHubPrClientOptions = Readonly<{ execute?: GhExecutor; timeoutMs?: number }>;

export function createGitHubPrClient(options: GitHubPrClientOptions = {}): GitHubPrClient {
  // FALLBACK: production uses execFile and the agreed 20s timeout; tests may inject.
  const execute = options.execute ?? executeGh;
  // FALLBACK: 20s is the specified request deadline, not inferred configuration.
  const timeoutMs = options.timeoutMs ?? GH_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("PR timeout must be positive");
  return {
    async fetch(target, signal) {
      const parsed = parseGitHubPrTarget(target.canonicalUrl);
      if (parsed === null || parsed.canonicalUrl !== target.canonicalUrl || parsed.owner !== target.owner
        || parsed.repo !== target.repo || parsed.number !== target.number) {
        return failure("invalid-target", "Invalid canonical GitHub PR target");
      }
      if (signal !== undefined && signal.aborted) return failure("aborted", "PR status request aborted");
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const output = await execute("gh", ["pr", "view", parsed.canonicalUrl, "--json", GH_PR_JSON_FIELDS, "--jq", GH_PR_JQ], {
          signal: controller.signal, timeout: timeoutMs, maxBuffer: GH_MAX_OUTPUT_BYTES,
          encoding: "utf8", windowsHide: true,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", CLICOLOR: "0" },
        });
        if (timedOut) return failure("timeout", "PR status request timed out");
        if (controller.signal.aborted) return failure("aborted", "PR status request aborted");
        if (Buffer.byteLength(output.stdout) > GH_MAX_OUTPUT_BYTES || Buffer.byteLength(output.stderr) > GH_MAX_OUTPUT_BYTES) {
          return failure("output-limit", "GitHub CLI output exceeded the size limit");
        }
        return parseGitHubPrResponse(output.stdout, parsed);
      } catch (error) {
        // FALLBACK: optional GitHub status must not interrupt chat; expose the reason.
        if (timedOut) return failure("timeout", "PR status request timed out");
        if (controller.signal.aborted) return failure("aborted", "PR status request aborted");
        if (!isRecord(error)) throw error;
        if (error.code === "ENOENT") return failure("missing-gh", "GitHub CLI is not installed");
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failure("output-limit", "GitHub CLI output exceeded the size limit");
        // execFile's errors carry code; programmer errors from an injected executor do not.
        if (typeof error.code !== "number" && typeof error.code !== "string" && error.killed !== true) throw error;
        const detail = typeof error.stderr === "string" && error.stderr.trim() !== "" ? error.stderr
          : typeof error.message === "string" ? error.message : "GitHub CLI failed";
        if (/gh auth login|not logged|authentication|bad credentials|http 401/iu.test(detail)) {
          return failure("authentication", "GitHub CLI authentication is unavailable; use existing gh authentication");
        }
        return failure("unavailable", detail);
      } finally {
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener("abort", abort);
      }
    },
  };
}
