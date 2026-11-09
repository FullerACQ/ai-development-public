import type { GitHubPrSnapshot } from "./cache"
import type { GitHubPrTarget } from "./github"

export type SymbolColor = "muted" | "success" | "error" | "warning" | "merged"
export type StatusSymbol = Readonly<{ text: string; color: SymbolColor }>

export function statusSymbols(snapshot: GitHubPrSnapshot | undefined): readonly StatusSymbol[] {
  if (snapshot === undefined) return [{ text: "?", color: "muted" }]
  const lifecycle: StatusSymbol[] = []
  switch (snapshot.lifecycle) {
    case "draft": lifecycle.push({ text: "◇", color: "muted" }); break
    case "merged": lifecycle.push({ text: "◆", color: "merged" }); break
    case "closed": lifecycle.push({ text: "⊘", color: "error" }); break
    case "open": case "unknown": break
    default: return assertNever(snapshot.lifecycle)
  }
  switch (snapshot.ci) {
    case "passed": return [...lifecycle, { text: "✓", color: "success" }]
    case "failed": return [...lifecycle, { text: "✕", color: "error" }]
    case "pending": return [...lifecycle, { text: "◷", color: "warning" }]
    case "unknown": return [...lifecycle, { text: "?", color: "muted" }]
    default: return assertNever(snapshot.ci)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled PR presentation state: ${String(value)}`)
}

export function tooltipDescription(target: GitHubPrTarget, snapshot: GitHubPrSnapshot | undefined): string {
  const heading = `${target.owner}/${target.repo} #${target.number}`
  if (snapshot === undefined) return `${heading}\nFetching GitHub status…`
  const lifecycle = {
    open: "Open", draft: "Draft", merged: "Merged", closed: "Closed without merging", unknown: "Lifecycle unavailable",
  }[snapshot.lifecycle]
  const ci = { passed: "passing", failed: "failing", pending: "pending", unknown: "unavailable" }[snapshot.ci]
  const lines = [heading, `${lifecycle} · CI ${ci}${snapshot.refreshing ? " · refreshing…" : ""}`]
  // Keep freshness ahead of optional check details when the viewport clips a tooltip.
  if (snapshot.lastSuccessfulFetchAt === null) lines.push("Not successfully fetched yet")
  else lines.push(`Last fetched: ${new Date(snapshot.lastSuccessfulFetchAt).toLocaleString()}`)
  if (snapshot.reason !== null) lines.push(snapshot.reason)
  const counts = { passed: 0, failed: 0, pending: 0, ignored: 0, unknown: 0 }
  for (const check of snapshot.checks) counts[check.outcome]++
  if (snapshot.checks.length > 0) {
    lines.push(`${counts.passed} passed · ${counts.failed} failed · ${counts.pending} pending · ${counts.ignored} skipped/neutral`)
  }
  const failures = snapshot.checks.filter((check) => check.outcome === "failed")
  for (const check of failures.slice(0, 2)) lines.push(`✕ ${check.name}`)
  if (failures.length > 2) lines.push(`… ${failures.length - 2} more failed checks`)
  if (snapshot.title !== null && lines.length < 8) lines.push(snapshot.title)
  return lines.join("\n")
}
