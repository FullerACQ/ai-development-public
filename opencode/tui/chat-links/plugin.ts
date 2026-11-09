import type { RGBA as Color, Renderable, TextRenderable as TextNode, TextChunk } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { GitHubPrCache, VISIBLE_REFRESH_INTERVAL_MS, type GitHubPrCacheOptions } from "./cache"
import type { CommandModifierReader, HttpUrlOpener } from "./click"
import { parseGitHubPrTarget, type GitHubPrTarget } from "./github"
import { statusSymbols, tooltipDescription, type SymbolColor } from "./presentation"
import { compactProseUrls, installCompactProse, type CompactProseSource } from "./prose"
import { extractUrls } from "./urls"
import {
  createTooltipOverlay, installLinkRenderer, PR_STRIP_PREFIX, rendererCore, sourceBlock, textSources,
  type Diagnostic, type LinkHit,
} from "./renderer"

const { RGBA, RenderableEvents, StyledText, TextRenderable } = rendererCore

type Strip = {
  block: Renderable
  node: TextNode
  targets: Map<string, GitHubPrTarget>
  sourceText: string
  destinations: string
  signature: string
  release: () => void
}

type CompactSource = {
  source: Renderable
  view: CompactProseSource
  theme: string
  refreshing: boolean
  dirty: boolean
  targets: Set<string>
  destinations: string
  release: () => void
}

export type ChatLinksApi = Readonly<{
  app: TuiPluginApi["app"]
  renderer: TuiPluginApi["renderer"]
  theme: Readonly<{ current: Pick<TuiPluginApi["theme"]["current"], "primary" | "text" | "textMuted" | "success" | "error" | "warning" | "backgroundPanel" | "border"> }>
  ui: Pick<TuiPluginApi["ui"], "toast">
  client: Readonly<{ app: Pick<TuiPluginApi["client"]["app"], "log"> }>
}>
export type ChatLinksOptions = Readonly<{
  client?: GitHubPrCacheOptions["client"]
  now?: () => number
  activation?: Readonly<{
    commandPressed: CommandModifierReader["commandPressed"]
    openHttpUrl: HttpUrlOpener["openHttpUrl"]
  }>
}>

export function installChatLinks(api: ChatLinksApi, options: ChatLinksOptions = {}): Readonly<{ dispose: () => void }> {
  const strips = new Map<Renderable, Strip>()
  const compact = new Map<Renderable, CompactSource>()
  const tooltip = createTooltipOverlay(api.renderer)
  const merged = RGBA.fromHex("#a78bfa")
  const diagnostics = new Set<string>()
  let visibleTargets = new Map<string, GitHubPrTarget>()
  let hovered: LinkHit | null = null
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const log = (level: "warn" | "error", message: string, extra: Readonly<Record<string, string>>): void => {
    void api.client.app.log({ service: "acq.chat-links", level, message, extra }).catch((error: unknown) => {
      // FALLBACK: the server log channel can disconnect independently of the local TUI.
      api.ui.toast({ variant: "error", title: "Chat links log", message: error instanceof Error ? error.message : String(error) })
    })
  }
  const diagnostic = (value: Diagnostic): void => {
    const key = `${value.code}:${value.detail}`
    if (diagnostics.has(key)) return
    diagnostics.add(key)
    log("warn", "Chat link renderer limitation", value)
    if (value.code === "unsupported-version" || value.code === "unsupported-runtime") {
      api.ui.toast({ variant: "warning", title: "Chat links", message: value.detail, duration: 10_000 })
    }
  }
  const fail = (error: unknown): void => {
    if (disposed) return
    // FALLBACK: PR metadata is a side channel; report unexpected failures without breaking chat.
    const message = error instanceof Error ? error.message : String(error)
    log("error", "PR status update failed", { message })
    api.ui.toast({ variant: "error", title: "PR status", message })
  }
  const track = (promise: Promise<unknown>): void => { void promise.catch(fail) }
  const color = (name: SymbolColor): Color => {
    const theme = api.theme.current
    switch (name) {
      case "muted": return theme.textMuted
      case "success": return theme.success
      case "error": return theme.error
      case "warning": return theme.warning
      case "merged": return merged
      default: { const exhaustive: never = name; throw new Error(`Unknown symbol color: ${exhaustive}`) }
    }
  }
  const cache = new GitHubPrCache({
    client: options.client,
    now: options.now,
    onChange: (snapshot) => {
      if (disposed) return
      for (const strip of strips.values()) updateStrip(strip)
      for (const record of compact.values()) {
        if (record.targets.has(snapshot.target.canonicalUrl)) refreshCompact(record)
      }
      showTooltip()
      scheduleRefresh()
    },
  })

  function compactTheme() {
    return {
      link: api.theme.current.primary,
      symbols: { muted: color("muted"), success: color("success"), error: color("error"), warning: color("warning"), merged },
    }
  }

  function releaseCompact(record: CompactSource): void {
    compact.delete(record.source)
    record.source.off(RenderableEvents.DESTROYED, record.release)
    record.view.dispose()
  }

  function refreshCompact(record: CompactSource): void {
    record.dirty = true
    if (record.refreshing) return
    record.refreshing = true
    track((async () => {
      try {
        while (record.dirty && !disposed && !record.source.isDestroyed && compact.get(record.source) === record) {
          record.dirty = false
          await record.view.refresh()
        }
      } finally { record.refreshing = false }
    })())
  }

  function discoverCompactSources(hits: readonly LinkHit[]): void {
    const destinations = new Map<Renderable, Set<string>>()
    for (const hit of hits) {
      const target = parseGitHubPrTarget(hit.url)
      if (target === null) continue
      let keys = destinations.get(hit.source)
      if (keys === undefined) { keys = new Set(); destinations.set(hit.source, keys) }
      keys.add(target.canonicalUrl)
    }
    const theme = JSON.stringify(compactTheme())
    for (const record of [...compact.values()]) {
      if (record.source.isDestroyed || record.source.parent === null) { releaseCompact(record); continue }
      if (theme !== record.theme) { record.theme = theme; refreshCompact(record) }
    }
    for (const source of textSources(api.renderer.root)) {
      if (!(source instanceof rendererCore.CodeRenderable)) continue
      const targets = new Set<string>()
      const sourceUrls = [...extractUrls(source.content).map(({ url }) => url), ...compactProseUrls(source)]
      const exact = new Set<string>()
      for (const url of sourceUrls) {
        const target = parseGitHubPrTarget(url)
        if (target !== null) { targets.add(target.canonicalUrl); exact.add(url) }
      }
      const fingerprint = JSON.stringify([...exact].sort())
      const native = destinations.get(source)
      if (native !== undefined) for (const key of native) targets.add(key)
      const existing = compact.get(source)
      if (existing !== undefined) {
        for (const key of targets) existing.targets.add(key)
        if (fingerprint !== existing.destinations) { existing.destinations = fingerprint; refreshCompact(existing) }
        continue
      }
      if (targets.size === 0) continue
      const view = installCompactProse(source, {
        widthMethod: api.renderer.widthMethod,
        readStatus: (target) => statusSymbols(cache.get(target)),
        readTheme: compactTheme,
      })
      if (view === null) continue
      const record: CompactSource = { source, view, theme, targets, destinations: fingerprint, refreshing: false, dirty: false, release: () => releaseCompact(record) }
      compact.set(source, record)
      source.once(RenderableEvents.DESTROYED, record.release)
    }
  }

  function showTooltip(): void {
    const target = hovered === null ? null : parseGitHubPrTarget(hovered.url)
    if (hovered === null || target === null) { tooltip.show(null, ""); return }
    const theme = api.theme.current
    tooltip.show(hovered, tooltipDescription(target, cache.get(target)), {
      foreground: theme.text, background: theme.backgroundPanel, border: theme.border,
    })
  }

  function updateStrip(strip: Strip): void {
    if (strip.node.isDestroyed || strip.block.isDestroyed) return
    const chunks: TextChunk[] = []
    for (const target of strip.targets.values()) {
      if (chunks.length > 0) chunks.push({ __isChunk: true, text: "   " })
      const link = { url: target.canonicalUrl }
      chunks.push({ __isChunk: true, text: `${target.repo}#${target.number} `, fg: api.theme.current.textMuted, link })
      const symbols = statusSymbols(cache.get(target))
      symbols.forEach((symbol, index) => {
        chunks.push({ __isChunk: true, text: `${index > 0 ? " " : ""}${symbol.text}`, fg: color(symbol.color), link })
      })
    }
    const signature = JSON.stringify(chunks.map((chunk) => [chunk.text, chunk.fg, chunk.link]))
    if (signature === strip.signature) return
    strip.signature = signature
    strip.node.content = new StyledText(chunks)
  }

  function removeStrip(strip: Strip): void {
    strips.delete(strip.block)
    strip.block.off(RenderableEvents.DESTROYED, strip.release)
    if (!strip.node.isDestroyed) strip.node.destroy()
  }

  function sourceVisible(block: Renderable): boolean {
    for (let node: Renderable | null = block; node !== null; node = node.parent) {
      if (!node.visible || node.isDestroyed) return false
      if (node === api.renderer.root) return true
    }
    return false
  }

  function sourceText(block: Renderable): string {
    return textSources(block).map((source) => source.plainText).join("\n")
  }

  function ensureStrip(block: Renderable, targets: Map<string, GitHubPrTarget>): void {
    if (block.isDestroyed || block.parent === null) return
    const content = sourceText(block)
    const destinations = JSON.stringify([...targets.keys()].sort())
    const existing = strips.get(block)
    if (existing !== undefined) {
      if (existing.node.isDestroyed) { removeStrip(existing); ensureStrip(block, targets); return }
      if (content !== existing.sourceText || destinations !== existing.destinations) existing.targets.clear()
      for (const [url, target] of targets) existing.targets.set(url, target)
      existing.sourceText = content
      existing.destinations = destinations
      updateStrip(existing)
      return
    }
    // FALLBACK: agreed message-attached strip keeps decorations out of source text/copy.
    const node = new TextRenderable(api.renderer, {
      id: `${PR_STRIP_PREFIX}-${block.num}`, selectable: false, flexShrink: 0, wrapMode: "word",
    })
    const strip: Strip = { block, node, targets: new Map(targets), sourceText: content, destinations, signature: "", release: () => removeStrip(strip) }
    strips.set(block, strip)
    block.parent.add(node, block.parent.getChildren().indexOf(block) + 1)
    block.once(RenderableEvents.DESTROYED, strip.release)
    updateStrip(strip)
  }

  function scheduleRefresh(): void {
    if (timer !== undefined) clearTimeout(timer)
    if (disposed) return
    const targets = visibleTargets
    if (targets.size === 0) return
    // FALLBACK: production uses wall time; tests supply a deterministic clock.
    const now = options.now === undefined ? Date.now() : options.now()
    let delay = VISIBLE_REFRESH_INTERVAL_MS
    for (const target of targets.values()) {
      const snapshot = cache.get(target)
      if (snapshot === undefined || snapshot.lastAttemptAt === null) delay = 1
      else if (!snapshot.refreshing) delay = Math.min(delay, Math.max(1, snapshot.lastAttemptAt + VISIBLE_REFRESH_INTERVAL_MS - now))
    }
    timer = setTimeout(() => {
      timer = undefined
      track(cache.refreshVisible(visibleTargets.values()).finally(scheduleRefresh))
    }, delay)
    timer.unref()
  }

  const controller = installLinkRenderer(api, {
    onDiagnostic: diagnostic,
    statusRanges: (source) => {
      const record = compact.get(source)
      return record === undefined ? [] : record.view.statusRanges()
    },
    commandPressed: options.activation === undefined ? undefined : options.activation.commandPressed,
    onActivate: options.activation === undefined ? undefined : (hit) => {
      const activation = options.activation
      if (activation === undefined) throw new Error("Command activation lost its configured opener")
      void activation.openHttpUrl(hit.url).then((result) => {
        if (disposed || result.ok) return
        log("warn", "Link opening failed", { kind: result.error.kind })
        api.ui.toast({ variant: "error", title: "Open link", message: result.error.message })
      }, (error: unknown) => {
        if (disposed) return
        // FALLBACK: opening is a user-side action; surface exceptions without breaking chat.
        // Raw subprocess exceptions can repeat private URL query parameters.
        log("error", "Link opener threw unexpectedly", { kind: error instanceof Error ? error.name : "unknown" })
        api.ui.toast({ variant: "error", title: "Open link", message: "Link opening failed unexpectedly." })
      })
    },
    onHover(hit) {
      if (disposed) return
      const entered = hit?.occurrence !== hovered?.occurrence || hit?.url !== hovered?.url
      hovered = hit
      const target = hit === null ? null : parseGitHubPrTarget(hit.url)
      if (entered && target !== null) track(cache.hoverEntry(target))
      showTooltip()
    },
    onVisible(hits, stripHits) {
      if (disposed) return
      discoverCompactSources(hits)
      const groups = new Map<Renderable, Map<string, GitHubPrTarget>>()
      visibleTargets = new Map()
      for (const hit of hits) {
        const target = parseGitHubPrTarget(hit.url)
        if (target === null) continue
        visibleTargets.set(target.canonicalUrl, target)
        const record = compact.get(hit.source)
        if (record !== undefined && (!record.view.ready()
          || (record.view.owns(hit.source) && record.view.urls().includes(hit.url)))) continue
        const block = sourceBlock(hit.source)
        let targets = groups.get(block)
        if (targets === undefined) { targets = new Map(); groups.set(block, targets) }
        targets.set(target.canonicalUrl, target)
      }
      for (const strip of [...strips.values()]) {
        if (strip.block.isDestroyed || strip.node.isDestroyed || strip.block.parent === null) { removeStrip(strip); continue }
        const visible = sourceVisible(strip.block)
        strip.node.visible = visible
        const record = compact.get(strip.block)
        if (!groups.has(strip.block) && record !== undefined && (!record.view.ready() || record.view.owns(strip.block))) {
          removeStrip(strip)
          continue
        }
        if (visible && !groups.has(strip.block) && sourceText(strip.block) !== strip.sourceText) removeStrip(strip)
      }
      for (const [block, targets] of groups) ensureStrip(block, targets)
      const stripsByNode = new Map<Renderable, Strip>([...strips.values()].map((strip) => [strip.node, strip]))
      for (const hit of stripHits) {
        const target = parseGitHubPrTarget(hit.url)
        const strip = stripsByNode.get(hit.source)
        if (target === null || strip === undefined || !sourceVisible(strip.block)
          || !strip.targets.has(target.canonicalUrl)) continue
        visibleTargets.set(target.canonicalUrl, target)
      }
      cache.setVisible(visibleTargets.values())
      for (const target of visibleTargets.values()) track(cache.firstSight(target))
      scheduleRefresh()
    },
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    controller.dispose()
    cache.dispose()
    for (const record of [...compact.values()]) releaseCompact(record)
    for (const strip of [...strips.values()]) removeStrip(strip)
    tooltip.dispose()
    api.renderer.off("destroy", dispose)
  }
  api.renderer.once("destroy", dispose)
  return { dispose }
}
