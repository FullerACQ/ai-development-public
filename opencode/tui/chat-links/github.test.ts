import { describe, expect, test } from "bun:test";
import {
  createGitHubPrClient,
  executeGh,
  GH_MAX_OUTPUT_BYTES,
  GH_PR_JQ,
  GH_PR_JSON_FIELDS,
  GH_REQUEST_TIMEOUT_MS,
  PR_CHECK_NAME_MAX_LENGTH,
  PR_CHECK_URL_MAX_LENGTH,
  parseGitHubPrResponse,
  parseGitHubPrTarget,
  sanitizeTerminalText,
  type CiState,
  type GhExecutor,
  type GitHubPrResult,
  type GitHubPrTarget,
} from "./github";

function target(url = "https://github.com/owner/repo/pull/42"): GitHubPrTarget {
  const parsed = parseGitHubPrTarget(url);
  if (parsed === null) throw new Error("Invalid test PR URL");
  return parsed;
}

function response(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ state: "OPEN", isDraft: false, title: "A pull request", url: target().canonicalUrl, statusCheckRollup: [], ...overrides });
}

function success(result: GitHubPrResult) {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function run(status: string, conclusion: string | null) {
  return { __typename: "CheckRun", status, conclusion };
}

function context(state: string) { return { __typename: "StatusContext", state }; }

describe("parseGitHubPrTarget", () => {
  test("canonicalizes host, names, number, tabs, query, and fragment", () => {
    for (const suffix of ["", "/", "/files", "/commits/", "/checks?x=1#check", "?diff=split#anchor"]) {
      expect(parseGitHubPrTarget(`HTTPS://GITHUB.COM/Owner/Repo.Name/pull/00042${suffix}`)).toEqual({
        owner: "owner", repo: "repo.name", number: 42, canonicalUrl: "https://github.com/owner/repo.name/pull/42",
      });
    }
    expect(parseGitHubPrTarget("http://github.com:80/owner/repo/pull/42")).toEqual(target());
    expect(parseGitHubPrTarget("https://github.com:443/owner/repo/pull/42")).toEqual(target());
  });

  const rejected = [
    "https://github.com.evil.test/owner/repo/pull/42", "https://evil.test/github.com/owner/repo/pull/42",
    "https://github.com@evil.test/owner/repo/pull/42", "https://evil@github.com/owner/repo/pull/42",
    "https://www.github.com/owner/repo/pull/42", "https://api.github.com/owner/repo/pull/42",
    "https://%67ithub.com/owner/repo/pull/42", "https://github.com./owner/repo/pull/42",
    "https://github.com:444/owner/repo/pull/42", "https://github.com:80/owner/repo/pull/42",
    "ftp://github.com/owner/repo/pull/42", "//github.com/owner/repo/pull/42",
    "https://github.com/owner/repo/pull/0", "https://github.com/owner/repo/pull/-1",
    "https://github.com/owner/repo/pull/1.5", "https://github.com/owner/repo/pull/1e3",
    "https://github.com/owner/repo/pull/9007199254740992", "https://github.com/owner/repo/pulls/42",
    "https://github.com/owner/repo/issues/42", "https://github.com/owner/repo/pull/42/files/extra",
    "https://github.com/owner/repo/pull/42/commits/abc", "https://github.com/owner/repo/pull/42/evil",
    "https://github.com/owner/repo/pull/42/../42", "https://github.com/owner/repo/pull/%34%32",
    "https://github.com/owner/repo/pull/42\n", "https://github.com/owner/repo/pull/42?x=\u001b",
    "https://github.com/owner/../pull/42", "https://github.com/owner/repo\\pull/42",
    "https://github.com//owner/repo/pull/42", "https://github.com/owner/repo/pull/42;echo",
  ];
  for (const url of rejected) test(`rejects ${JSON.stringify(url)}`, () => { expect(parseGitHubPrTarget(url)).toBeNull(); });
});

describe("PR response and CI classification", () => {
  const matrix: readonly Readonly<{ label: string; checks: unknown; ci: CiState }>[] = [
    { label: "no checks", checks: [], ci: "unknown" },
    { label: "null checks", checks: null, ci: "unknown" },
    { label: "success", checks: [run("COMPLETED", "SUCCESS")], ci: "passed" },
    { label: "legacy success context", checks: [context("SUCCESS")], ci: "passed" },
    { label: "mixed failure and pending", checks: [run("IN_PROGRESS", null), run("COMPLETED", "FAILURE")], ci: "failed" },
    { label: "context failure and pending", checks: [context("PENDING"), context("ERROR")], ci: "failed" },
    { label: "stale failed conclusion dominates pending status", checks: [run("IN_PROGRESS", "FAILURE")], ci: "failed" },
    { label: "queued and successful", checks: [run("QUEUED", null), context("SUCCESS")], ci: "pending" },
    { label: "all old skipped", checks: [run("COMPLETED", "SKIPPED"), run("COMPLETED", "SKIPPED")], ci: "unknown" },
    { label: "all neutral", checks: [run("COMPLETED", "NEUTRAL")], ci: "unknown" },
    { label: "skip and neutral alongside success", checks: [run("COMPLETED", "NEUTRAL"), run("COMPLETED", "SKIPPED"), context("SUCCESS")], ci: "passed" },
    { label: "unknown future conclusion with success", checks: [context("SUCCESS"), run("COMPLETED", "NEW_CONCLUSION")], ci: "unknown" },
    { label: "incomplete completed check", checks: [run("COMPLETED", null)], ci: "unknown" },
    { label: "unknown status", checks: [run("FUTURE_STATUS", "SUCCESS")], ci: "unknown" },
    { label: "context without typename", checks: [{ state: "success" }], ci: "passed" },
    { label: "run without typename", checks: [{ status: "completed", conclusion: "success" }], ci: "passed" },
    { label: "lowercase conclusions", checks: [run("completed", "cancelled")], ci: "failed" },
    { label: "unknown context", checks: [context("FUTURE_STATE")], ci: "unknown" },
  ];
  for (const { label, checks, ci } of matrix) {
    test(label, () => {
      const parsed = success(parseGitHubPrResponse(response({ statusCheckRollup: checks }), target()));
      expect(parsed.ci).toBe(ci);
      expect(parsed.lifecycle).toBe("open");
      if (ci === "unknown") expect(parsed.ciReason).toBeString();
    });
  }
  for (const conclusion of ["CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "FAILURE", "ERROR"]) {
    test(`${conclusion} fails despite pending peers`, () => {
      expect(success(parseGitHubPrResponse(response({ statusCheckRollup: [run("WAITING", null), run("COMPLETED", conclusion)] }), target())).ci).toBe("failed");
    });
  }

  test("draft flag only affects open lifecycle; merged and closed keep their actual lifecycle", () => {
    for (const isDraft of [false, true]) {
      for (const state of ["OPEN", "MERGED", "CLOSED"] as const) {
        const parsed = success(parseGitHubPrResponse(response({ state, isDraft, statusCheckRollup: [run("COMPLETED", "FAILURE")] }), target()));
        expect(parsed.lifecycle).toBe(state === "OPEN" ? isDraft ? "draft" : "open" : state === "MERGED" ? "merged" : "closed");
        expect(parsed.ci).toBe("failed");
      }
    }
  });

  test("tooltip details preserve run names, legacy contexts, and each check outcome", () => {
    const checks = [
      { ...run("COMPLETED", "FAILURE"), name: "build (linux)", detailsUrl: "https://github.com/owner/repo/actions/runs/123" },
      { ...context("ERROR"), context: "deploy/preview", targetUrl: "https://ci.example.com/build/456" },
      { ...run("IN_PROGRESS", null), name: "integration tests" },
      { ...context("SUCCESS"), context: "lint" },
      { ...run("COMPLETED", "SKIPPED"), name: "optional test" },
      { ...run("COMPLETED", "NEUTRAL"), name: "informational report" },
      { ...run("COMPLETED", "FUTURE_CONCLUSION"), name: "future check" },
    ];
    const parsed = success(parseGitHubPrResponse(response({ statusCheckRollup: checks }), target()));
    expect(parsed.ci).toBe("failed");
    expect(parsed.checks).toEqual([
      { name: "build (linux)", outcome: "failed", url: "https://github.com/owner/repo/actions/runs/123" },
      { name: "deploy/preview", outcome: "failed", url: "https://ci.example.com/build/456" },
      { name: "integration tests", outcome: "pending", url: null },
      { name: "lint", outcome: "passed", url: null },
      { name: "optional test", outcome: "ignored", url: null },
      { name: "informational report", outcome: "ignored", url: null },
      { name: "future check", outcome: "unknown", url: null },
    ]);
    expect(parsed.checks.filter((check) => check.outcome === "failed").map((check) => check.name)).toEqual(["build (linux)", "deploy/preview"]);
  });

  test("missing or sanitized-empty names retain outcomes as explicitly unnamed checks", () => {
    const parsed = success(parseGitHubPrResponse(response({ statusCheckRollup: [
      run("COMPLETED", "FAILURE"),
      { ...context("PENDING"), context: null, targetUrl: null },
      { ...run("COMPLETED", "SUCCESS"), name: "\u001b[31m\u001b[0m\n", detailsUrl: null },
    ] }), target()));
    expect(parsed.checks).toEqual([
      { name: "Unnamed check", outcome: "failed", url: null },
      { name: "Unnamed check", outcome: "pending", url: null },
      { name: "Unnamed check", outcome: "passed", url: null },
    ]);
    expect(parsed.ci).toBe("failed");
  });

  test("null or empty rollups return empty details with unknown CI", () => {
    for (const statusCheckRollup of [null, []]) {
      const parsed = success(parseGitHubPrResponse(response({ statusCheckRollup }), target()));
      expect(parsed.checks).toEqual([]);
      expect(parsed.ci).toBe("unknown");
    }
  });

  test("names are sanitized and bounded; optional URLs are never rewritten or truncated", () => {
    const parsed = success(parseGitHubPrResponse(response({ statusCheckRollup: [
      { ...run("COMPLETED", "FAILURE"), name: `\u001b[31m${"x".repeat(PR_CHECK_NAME_MAX_LENGTH + 20)}\u001b[0m` },
      { ...context("SUCCESS"), context: "\u001b]8;;https://evil.example\u0007lint\u001b]8;;\u001b\\\n clean\u202e" },
      { ...run("COMPLETED", "SUCCESS"), name: "http detail", detailsUrl: "http://ci.example.com/results?x=A%2FB#check" },
    ] }), target()));
    expect(parsed.checks[0]?.name).toBe("x".repeat(PR_CHECK_NAME_MAX_LENGTH));
    expect(parsed.checks[1]?.name).toBe("lint clean");
    expect(parsed.checks[2]?.url).toBe("http://ci.example.com/results?x=A%2FB#check");
    for (const check of parsed.checks) expect(check.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u);

    for (const url of ["", "not a URL", "javascript:alert(1)", "file:///tmp/check", "https://user:secret@ci.example.com/",
      "https://ci.example.com/path\u001b[31m", "https://ci.example.com/a b", `https://ci.example.com/${"x".repeat(PR_CHECK_URL_MAX_LENGTH)}`,
    ]) {
      for (const check of [
        { ...run("COMPLETED", "SUCCESS"), name: "build", detailsUrl: url },
        { ...context("SUCCESS"), context: "legacy build", targetUrl: url },
      ]) {
        const result = success(parseGitHubPrResponse(response({ statusCheckRollup: [check] }), target()));
        expect(result.ci).toBe("passed");
        expect(result.checks[0]?.url).toBeNull();
      }
    }
  });

  test("metadata with non-string fields is rejected at the parsed boundary", () => {
    for (const check of [
      { ...run("COMPLETED", "SUCCESS"), name: 1 },
      { ...run("COMPLETED", "SUCCESS"), detailsUrl: {} },
      { ...context("SUCCESS"), context: false },
      { ...context("SUCCESS"), targetUrl: [] },
    ]) {
      const parsed = parseGitHubPrResponse(response({ statusCheckRollup: [check] }), target());
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.kind).toBe("invalid-response");
    }
  });

  test("invalid JSON, missing fields, and malformed checks fail at the boundary", () => {
    for (const raw of ["bad", "null", "[]", "{}", response({ state: null }), response({ state: "pending" }),
      response({ isDraft: "false" }), response({ title: 12 }), response({ url: "https://evil.test/owner/repo/pull/42" }),
      response({ url: "https://github.com/owner/repo/pull/43" }), response({ statusCheckRollup: {} }),
      response({ statusCheckRollup: [null] }), response({ statusCheckRollup: [{ status: "COMPLETED" }] }),
      response({ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: {} }] }),
      response({ statusCheckRollup: [{ __typename: "StatusContext", state: 1 }] }),
      response({ statusCheckRollup: [{ __typename: "Other", state: "SUCCESS" }] }),
    ]) {
      const parsed = parseGitHubPrResponse(raw, target());
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.kind).toBe("invalid-response");
    }
  });

  test("untrusted titles and errors never carry terminal controls", () => {
    const dirty = "\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u001b\\\n\u009b2Jclean\u202e";
    expect(sanitizeTerminalText(dirty)).toBe("redlink clean");
    expect(success(parseGitHubPrResponse(response({ title: dirty }), target())).title).toBe("redlink clean");
  });
});

describe("GitHub CLI client", () => {
  test("exec argument vector is canonical, narrow, bounded, and noninteractive", async () => {
    const calls: Parameters<GhExecutor>[] = [];
    const client = createGitHubPrClient({ execute: async (...args) => { calls.push(args); return { stdout: response(), stderr: "" }; } });
    expect((await client.fetch(target())).ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [file, args, options] = calls[0]!;
    expect(file).toBe("gh");
    expect(args).toEqual(["pr", "view", target().canonicalUrl, "--json", GH_PR_JSON_FIELDS, "--jq", GH_PR_JQ]);
    expect(options.timeout).toBe(GH_REQUEST_TIMEOUT_MS);
    expect(options.maxBuffer).toBe(GH_MAX_OUTPUT_BYTES);
    expect(options.env.GH_PROMPT_DISABLED).toBe("1");
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test("caller cancellation aborts a running request", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const client = createGitHubPrClient({ execute: (_file, _args, options) => {
      observed = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const pending = client.fetch(target(), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted", message: "PR status request aborted" } });
    expect(observed?.aborted).toBe(true);
  });

  test("already-aborted calls never spawn a process", async () => {
    let calls = 0;
    const client = createGitHubPrClient({ execute: async () => { calls++; return { stdout: response(), stderr: "" }; } });
    const result = await client.fetch(target(), AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("aborted");
    expect(calls).toBe(0);
  });

  test("deadline aborts the actual execFile subprocess", async () => {
    const client = createGitHubPrClient({ timeoutMs: 30, execute: (_file, _args, options) =>
      executeGh(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options),
    });
    const result = await client.fetch(target());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("timeout");
  });

  test("real subprocess output is bounded", async () => {
    const client = createGitHubPrClient({ execute: (_file, _args, options) =>
      executeGh(process.execPath, ["-e", `process.stdout.write('x'.repeat(${GH_MAX_OUTPUT_BYTES + 1024}))`], options),
    });
    const result = await client.fetch(target());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("output-limit");
  });

  test("check details are still subject to the total CLI output limit", async () => {
    const client = createGitHubPrClient({ execute: async () => ({ stdout: response({ statusCheckRollup: [
      { ...run("COMPLETED", "FAILURE"), name: "x".repeat(GH_MAX_OUTPUT_BYTES), detailsUrl: "https://ci.example.com/results" },
    ] }), stderr: "" }) });
    const parsed = await client.fetch(target());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe("output-limit");
  });

  test("missing gh, expired authentication, and network errors are results", async () => {
    for (const [error, kind] of [
      [{ code: "ENOENT", message: "spawn gh ENOENT" }, "missing-gh"],
      [{ code: 1, stderr: "To get started, run gh auth login" }, "authentication"],
      [{ code: 1, stderr: "\u001b[31mHTTP 503\u001b[0m\nservice unavailable\u0007" }, "unavailable"],
    ] as const) {
      const result = await createGitHubPrClient({ execute: async () => { throw error; } }).fetch(target());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe(kind);
        expect(result.error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      }
    }
  });

  test("rejects inconsistent targets and preserves unexpected programmer errors", async () => {
    const error = new TypeError("broken executor");
    const client = createGitHubPrClient({ execute: async () => { throw error; } });
    const bad = await client.fetch({ ...target(), canonicalUrl: "https://evil.test/owner/repo/pull/42" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("invalid-target");
    await expect(client.fetch(target())).rejects.toBe(error);
  });
});
