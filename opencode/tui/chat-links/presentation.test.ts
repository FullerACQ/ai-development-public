import { describe, expect, test } from "bun:test"
import type { GitHubPrSnapshot } from "./cache"
import type { CiState, GitHubPrTarget, PrCheckDetail } from "./github"
import { statusSymbols, tooltipDescription, type StatusSymbol } from "./presentation"

const target: GitHubPrTarget = {
  owner: "octo-org-sample", repo: "alpha", number: 123,
  canonicalUrl: "https://github.com/octo-org-sample/alpha/pull/123",
}
const fetchedAt = Date.UTC(2026, 9, 8, 12, 34, 56)
const title = "Keep chat text copyable"
const base: GitHubPrSnapshot = {
  target, url: target.canonicalUrl, title,
  lifecycle: "open", ci: "passed", checks: [], reason: null, error: null,
  lastSuccessfulFetchAt: fetchedAt, lastAttemptAt: fetchedAt, refreshing: false,
}

describe("status symbols preserve lifecycle independently of CI", () => {
  const lifecycles: Readonly<Record<GitHubPrSnapshot["lifecycle"], readonly StatusSymbol[]>> = {
    open: [], draft: [{ text: "◇", color: "muted" }],
    merged: [{ text: "◆", color: "merged" }], closed: [{ text: "⊘", color: "error" }], unknown: [],
  }
  const ciSymbols: Readonly<Record<CiState, StatusSymbol>> = {
    passed: { text: "✓", color: "success" }, failed: { text: "✕", color: "error" },
    pending: { text: "◷", color: "warning" }, unknown: { text: "?", color: "muted" },
  }
  const lifecycleValues: readonly GitHubPrSnapshot["lifecycle"][] = ["open", "draft", "merged", "closed", "unknown"]
  const ciValues: readonly CiState[] = ["passed", "failed", "pending", "unknown"]
  for (const lifecycle of lifecycleValues) {
    for (const ci of ciValues) {
      test(`${lifecycle} + ${ci}`, () => {
        expect(statusSymbols({ ...base, lifecycle, ci })).toEqual([...lifecycles[lifecycle], ciSymbols[ci]])
      })
    }
  }

  test("a cache miss has no success or failure evidence", () => {
    expect(statusSymbols(undefined)).toEqual([{ text: "?", color: "muted" }])
    expect(tooltipDescription(target, undefined)).toBe("octo-org-sample/alpha #123\nFetching GitHub status…")
  })
})

test("tooltip shows check counts, failing names, overflow and successful fetch time", () => {
  const checks: readonly PrCheckDetail[] = [
    { name: "typecheck", outcome: "passed", url: null },
    { name: "unit tests", outcome: "failed", url: "https://ci.example.org/unit" },
    { name: "lint", outcome: "failed", url: null },
    { name: "deploy", outcome: "failed", url: null },
    { name: "preview", outcome: "pending", url: null },
    { name: "optional", outcome: "ignored", url: null },
  ]
  expect(tooltipDescription(target, { ...base, lifecycle: "draft", ci: "failed", checks })).toBe([
    "octo-org-sample/alpha #123", "Draft · CI failing", `Last fetched: ${new Date(fetchedAt).toLocaleString()}`,
    "1 passed · 3 failed · 1 pending · 1 skipped/neutral", "✕ unit tests", "✕ lint",
    "… 1 more failed checks", base.title,
  ].join("\n"))
})

test("freshness precedes reasons, counts and long failure details in tooltip line order", () => {
  const reason = "Required CI checks failed"
  const names = ["unit tests / ".repeat(14) + "Linux", "integration / ".repeat(13) + "Windows"]
  const snapshot: GitHubPrSnapshot = {
    ...base, lifecycle: "draft", ci: "failed", refreshing: true, reason,
    checks: names.map((name) => ({ name, outcome: "failed", url: null })),
  }
  expect(tooltipDescription(target, snapshot).split("\n")).toEqual([
    "octo-org-sample/alpha #123", "Draft · CI failing · refreshing…",
    `Last fetched: ${new Date(fetchedAt).toLocaleString()}`, reason,
    "0 passed · 2 failed · 0 pending · 0 skipped/neutral", `✕ ${names[0]}`, `✕ ${names[1]}`, title,
  ])
})

test("never-fetched freshness occupies the third line before an unavailable reason", () => {
  const reason = "GitHub authentication expired"
  const snapshot: GitHubPrSnapshot = {
    ...base, title: null, lifecycle: "unknown", ci: "unknown", lastSuccessfulFetchAt: null, reason,
    error: { kind: "authentication", message: reason },
  }
  expect(tooltipDescription(target, snapshot).split("\n")).toEqual([
    "octo-org-sample/alpha #123", "Lifecycle unavailable · CI unavailable", "Not successfully fetched yet", reason,
  ])
})

test("refreshing preserves confirmed status and identifies the last successful fetch", () => {
  const tooltip = tooltipDescription(target, { ...base, refreshing: true, lastAttemptAt: fetchedAt + 3_000 })
  expect(tooltip).toContain("Open · CI passing · refreshing…")
  expect(tooltip).toContain(`Last fetched: ${new Date(fetchedAt).toLocaleString()}`)
  expect(tooltip).toContain("Keep chat text copyable")
})

test.each([
  "No CI checks reported", "All CI checks are skipped or neutral",
  "CI includes an unrecognized or incomplete check", "GitHub authentication expired",
])("unavailable status explains %s without showing green", (reason) => {
  const snapshot: GitHubPrSnapshot = {
    ...base, lifecycle: "unknown", ci: "unknown", title: null, reason,
    lastSuccessfulFetchAt: null, error: { kind: "unavailable", message: reason },
  }
  expect(statusSymbols(snapshot)).toEqual([{ text: "?", color: "muted" }])
  const tooltip = tooltipDescription(target, snapshot)
  expect(tooltip).toContain("Lifecycle unavailable · CI unavailable")
  expect(tooltip).toContain(reason)
  expect(tooltip).toContain("Not successfully fetched yet")
  expect(tooltip).not.toContain("passing")
  expect(tooltip).not.toContain("Last fetched:")
})

test("a failed refresh displays its reason and old successful timestamp, not stale green", () => {
  const snapshot: GitHubPrSnapshot = {
    ...base, lifecycle: "unknown", ci: "unknown", title: null,
    reason: "PR status request timed out", error: { kind: "timeout", message: "PR status request timed out" },
    lastAttemptAt: fetchedAt + 300_000,
  }
  const tooltip = tooltipDescription(target, snapshot)
  expect(statusSymbols(snapshot)).toEqual([{ text: "?", color: "muted" }])
  expect(tooltip).toContain("PR status request timed out")
  expect(tooltip).toContain(`Last fetched: ${new Date(fetchedAt).toLocaleString()}`)
  expect(tooltip).not.toContain("passing")
})

test("skipped and unrecognized check details cannot make unknown CI look passing", () => {
  const reason = "CI includes an unrecognized or incomplete check"
  const snapshot: GitHubPrSnapshot = {
    ...base, ci: "unknown", reason,
    checks: [
      { name: "neutral", outcome: "ignored", url: null },
      { name: "new provider state", outcome: "unknown", url: null },
    ],
  }
  const tooltip = tooltipDescription(target, snapshot)
  expect(tooltip).toContain("Open · CI unavailable")
  expect(tooltip).toContain("0 passed · 0 failed · 0 pending · 1 skipped/neutral")
  expect(tooltip).toContain(reason)
  expect(statusSymbols(snapshot)).toEqual([{ text: "?", color: "muted" }])
})

test.each([
  ["merged", "Merged"], ["closed", "Closed without merging"], ["draft", "Draft"], ["open", "Open"],
] satisfies readonly (readonly [GitHubPrSnapshot["lifecycle"], string])[])(
  "%s tooltip labels lifecycle separately from pending CI", (lifecycle, label) => {
    expect(tooltipDescription(target, { ...base, lifecycle, ci: "pending" })).toContain(`${label} · CI pending`)
  },
)
