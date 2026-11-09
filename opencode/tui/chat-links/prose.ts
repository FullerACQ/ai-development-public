/** OpenCode 1.18.34 / OpenTUI 0.4.5 compact assistant-Markdown PR links.
 * Per-source adapter: the parent owns discovery, visibility, refresh and strips.
 * Only native parser chunks change; Markdown/content/message bytes never change.
 * Selection offsets are native display columns (including newlines), NOT UTF-16.
 * A selection touching a chip copies its whole original visual occurrence; a
 * concealed native label additionally carries its exact URL in parentheses.
 * No TextRenderable/Solid-child rewriting, network requests or opener here.
 */
import type { CodeRenderable, Renderable, RGBA, TextChunk, OnChunksCallback, ChunkRenderContext,
  CliRenderer } from "@opentui/core"
import { parseGitHubPrTarget, type GitHubPrTarget } from "./github"
import type { StatusSymbol, SymbolColor } from "./presentation"
import { rendererCore } from "./renderer"
import { extractUrls } from "./urls"

const { CodeRenderable: Code, MarkdownRenderable: Markdown, BoxRenderable: Box, TextBuffer } = rendererCore

export type CompactProseTheme = Readonly<{
  link: RGBA
  symbols: Readonly<Record<SymbolColor, RGBA>>
}>
export type CompactProseOptions = Readonly<{
  widthMethod: CliRenderer["widthMethod"]
  /** Inject statusSymbols(cache.snapshot(target)); missing/cache errors remain
   * presentation states owned by that provider. No GitHub fetches here. */
  readStatus: (target: GitHubPrTarget) => readonly StatusSymbol[]
  readTheme: () => CompactProseTheme
}>
/** Native logical display-column ranges, for parent renderer glyph ownership. */
export type CompactProseRange = Range & Readonly<{ url: string }>
export type CompactProseSymbolRange = CompactProseRange & Readonly<{ text: string }>
export type CompactProseSource = Readonly<{
  /** Latest content/refresh has committed native highlighting, including no
   * compact matches. False means defer fallback strip creation. */
  ready: () => boolean
  /** True only for a ready compact buffer. Use to suppress the prose strip. */
  owns: (source: Renderable) => boolean
  /** Exact destinations of compacted occurrences, including query/fragment. */
  urls: () => readonly string[]
  /** Whole clickable chips, not just their lifecycle/CI symbols. */
  compactRanges: () => readonly CompactProseRange[]
  statusRanges: () => readonly CompactProseSymbolRange[]
  /** Await before rendering the next frame; reuses the original parser hook. */
  refresh: () => Promise<void>
  dispose: () => void
}>

type Token = Readonly<{ type: string; raw: string; tokens?: unknown; items?: unknown; href?: unknown }>
function token(value: unknown): Token | null {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string"
    || !("raw" in value) || typeof value.raw !== "string") return null
  return { type: value.type, raw: value.raw, tokens: Reflect.get(value, "tokens"),
    items: Reflect.get(value, "items"), href: Reflect.get(value, "href") }
}
function tokens(value: unknown): readonly Token[] | null {
  if (!Array.isArray(value)) return null
  const parsed = value.map(token)
  return parsed.every((item): item is Token => item !== null) ? parsed : null
}
function childContaining(parent: Renderable, source: Renderable): Renderable | null {
  for (let node: Renderable | null = source; node !== null; node = node.parent) {
    if (node.parent === parent) return node
  }
  return null
}
/** Only sourceBlock's exact anchor identity is transparent to token lookup.
 * Its first child is the original native slot; strips remain extra children
 * inside that slot. Arbitrary boxes/prefix matches are not native token slots.
 */
function unwrapAnchor(node: Renderable): Renderable {
  let current = node
  while (current instanceof Box) {
    const child = current.getChildren()[0]
    if (child === undefined || current.id !== `acq-pr-anchor-${child.num}`) break
    current = child
  }
  return current
}

/** Pinned internal _blockStates/token association, never filetype/ID heuristics.
 * List marker/body structure matches native createListItemRenderable in 0.4.5.
 * FALLBACK: unsupported/custom structures retain native text + strip.
 */
function proseToken(source: CodeRenderable): Token | null {
  let parent: Renderable | null = source.parent
  while (parent !== null && !(parent instanceof Markdown)) parent = parent.parent
  if (!(parent instanceof Markdown)) return null
  const slot = childContaining(parent, source)
  if (slot === null) return null
  const root = unwrapAnchor(slot)
  const state = parent._blockStates.find((block) => block.renderable === root)
  if (state === undefined) return null
  const descend = (slot: Renderable, current: Token): Token | null => {
    const node = unwrapAnchor(slot)
    if (node === source) {
      if (!["paragraph", "heading", "text"].includes(current.type)) return null
      const inline = tokens(current.tokens)
      if (inline !== null && inline.length > 0) return current
      // Coalesced/default mode manufactures paragraphs with tokens: []. Reuse
      // the canonical parsed token only when its full raw block matches uniquely;
      // never parse Markdown again or guess offsets within combined blocks.
      const canonical = parent._parseState === null ? null : tokens(parent._parseState.tokens)
      const matches = canonical === null ? [] : canonical.filter((item) =>
        ["paragraph", "heading", "text"].includes(item.type)
        && item.raw.replace(/[\r\n]+$/u, "") === current.raw.replace(/[\r\n]+$/u, ""))
      return matches.length === 1 ? matches[0]! : current
    }
    if (current.type !== "list" || !Array.isArray(current.items)) return null
    const rowSlot = childContaining(node, source)
    if (rowSlot === null) return null
    const row = unwrapAnchor(rowSlot)
    const item: unknown = current.items[node.getChildren().indexOf(rowSlot)]
    if (typeof item !== "object" || item === null || !("tokens" in item)) return null
    const children = tokens(item.tokens)
    const body = row.getChildren()[1]
    if (children === null || body === undefined) return null
    const child = childContaining(body, source)
    if (child === null) return null
    const filtered = children.filter((item) => item.type !== "space" && item.type !== "checkbox")
    const next = filtered[body.getChildren().indexOf(child)]
    return next === undefined ? null : descend(child, next)
  }
  const parsed = token(state.token)
  return parsed === null ? null : descend(root, parsed)
}

type Range = Readonly<{ start: number; end: number }>
type RawLink = Range & Readonly<{ url: string }>
type InlineRanges = Readonly<{ links: readonly RawLink[]; protected: readonly Range[]; hasAst: boolean }>
function inlineRanges(current: Token, content: string): InlineRanges {
  const links: RawLink[] = []
  const protectedRanges: Range[] = []
  // FALLBACK: a source updated independently/in flight can precede its parent
  // token. Use native highlight/link evidence instead of projecting stale AST.
  if (current.raw.replace(/[\r\n]+$/u, "") !== content.replace(/[\r\n]+$/u, "")) {
    return { links, protected: protectedRanges, hasAst: false }
  }
  const visit = (items: readonly Token[], offset: number): void => {
    let cursor = offset
    for (const item of items) {
      const start = content.indexOf(item.raw, cursor)
      // FALLBACK: custom renderer/parser tokens that do not match this source
      // cannot establish a safe raw-to-visual association.
      if (start === -1) continue
      const end = start + item.raw.length
      cursor = end
      if (item.type === "codespan" || item.type === "image") protectedRanges.push({ start, end })
      else if (item.type === "link" && typeof item.href === "string") {
        links.push({ start, end, url: item.href })
        const label = tokens(item.tokens)
        if (label !== null) visit(label, start)
      }
      else {
        const nested = tokens(item.tokens)
        if (nested !== null) visit(nested, start)
      }
    }
  }
  const items = tokens(current.tokens)
  if (items !== null) visit(items, 0)
  return { links, protected: protectedRanges, hasAst: items !== null && items.length > 0 }
}

/** Exact resolved PR hrefs for parent discovery/cache subscriptions, before
 * native highlighting or visibility. Reference destinations come from the
 * existing Markdown AST, never reparsing or rendered link attributes. Bare URL
 * literals remain the parent's extractUrls responsibility. Commands, images,
 * fences and sources without an associated prose AST contribute no destinations.
 */
export function compactProseUrls(source: Renderable): readonly string[] {
  if (!(source instanceof Code) || source.isDestroyed) return []
  const current = proseToken(source)
  if (current === null) return []
  const inline = inlineRanges(current, source.content)
  return inline.links.filter((link) => parseGitHubPrTarget(link.url) !== null
    && source.content.slice(link.start, link.end) !== link.url
    && !inline.protected.some((range) => intersects(range, link))).map((link) => link.url)
}

type Origin = Range & Readonly<{ rawStart: number; rawEnd: number; exact: boolean }>
/** Match native chunks to raw source in order, accounting for the parser's
 * synthesized conceal-space. No reparse or Markdown reserialization. Unmapped
 * custom-hook chunks may still use explicit native link metadata below.
 */
function origins(chunks: readonly TextChunk[], context: ChunkRenderContext, conceal: boolean): readonly Origin[] {
  const result: Origin[] = []
  let cursor = 0
  let position = 0
  for (const chunk of chunks) {
    const end = position + chunk.text.length
    if (chunk.text.length === 0) continue
    while (conceal) {
      const hidden = context.highlights.find(([start, end, , meta]) =>
        start === cursor && end > start && meta?.conceal === "")
      if (hidden === undefined) break
      cursor = hidden[1]
    }
    const replacement = conceal ? context.highlights.find(([start, , , meta]) =>
      start === cursor && meta?.conceal === chunk.text) : undefined
    if (replacement !== undefined) {
      result.push({ start: position, end, rawStart: replacement[0], rawEnd: replacement[1], exact: false })
      cursor = replacement[1]
    } else {
      const start = context.content.indexOf(chunk.text, cursor)
      if (start !== -1) {
        result.push({ start: position, end, rawStart: start, rawEnd: start + chunk.text.length, exact: true })
        cursor = start + chunk.text.length
      }
    }
    position = end
  }
  return result
}
function project(range: Range, mapping: readonly Origin[]): Range | null {
  const overlaps = mapping.filter((origin) => origin.rawStart < range.end && origin.rawEnd > range.start)
  if (overlaps.length === 0) return null
  const first = overlaps[0]!
  const last = overlaps.at(-1)!
  return {
    start: first.start + (first.exact ? Math.max(0, range.start - first.rawStart) : 0),
    end: last.end - (last.exact ? Math.max(0, last.rawEnd - range.end) : 0),
  }
}
function intersects(a: Range, b: Range): boolean { return a.start < b.end && b.start < a.end }

type Replacement = Range & Readonly<{ url: string; target: GitHubPrTarget }>
function replacements(chunks: readonly TextChunk[], context: ChunkRenderContext, current: Token, conceal: boolean): readonly Replacement[] {
  const text = chunks.map((chunk) => chunk.text).join("")
  const mapping = origins(chunks, context, conceal)
  const inline = inlineRanges(current, context.content)
  if (!inline.hasAst && (context.highlights.some(([, , group]) => group.startsWith("markup.link"))
    || chunks.some((chunk) => chunk.link !== undefined))) {
    // FALLBACK: synthetic coalesced/custom sources without a matching inline
    // AST cannot distinguish an ordinary link from a command-label link/image.
    // Preserve the whole native block for its fallback strip rather than
    // partially replacing a destination or concealing an image's label.
    return []
  }
  // Coalesced native blocks have synthetic paragraph tokens without inline AST.
  // Tree-sitter raw scopes still identify inline commands and nested code.
  const rawScopes = context.highlights.filter(([, , group]) => group === "markup.raw" || group.startsWith("markup.raw."))
    .map(([start, end]) => ({ start, end }))
  const protectedRaw = [...inline.protected, ...rawScopes]
  // A command used as a native link label stays a command, including the
  // displayed destination. Do not partially compact its trailing parenthesis.
  const protectedLinks = inline.links.filter((link) => protectedRaw.some((range) => intersects(range, link)))
  const protectedRanges = [...protectedRaw, ...protectedLinks]
    .map((range) => project(range, mapping)).filter((range) => range !== null)
  const linked: RawLink[] = []
  let offset = 0
  for (const chunk of chunks) {
    const end = offset + chunk.text.length
    if (chunk.link !== undefined && end > offset) {
      const previous = linked.at(-1)
      if (previous !== undefined && previous.end === offset && previous.url === chunk.link.url) {
        linked[linked.length - 1] = { ...previous, end }
      } else linked.push({ start: offset, end, url: chunk.link.url })
    }
    offset = end
  }
  const result: Replacement[] = []
  const add = (input: RawLink): void => {
    const target = parseGitHubPrTarget(input.url)
    if (target === null) return
    const escaped = target.repo.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const label = text.slice(0, input.start).match(new RegExp(
      `(?<![\\p{L}\\p{N}_.-])${escaped}(?:[ \\t]+PR)?[ \\t]*#[ \\t]*${target.number}[ \\t]*\\([ \\t]*$`, "iu"))
    const wholeHumanLabel = label !== null && text[input.end] === ")" && text.slice(input.start, input.end) === input.url
    const range = wholeHumanLabel ? { ...input, start: input.start - label[0].length, end: input.end + 1 } : input
    // FALLBACK: native destinations exceed 512 UTF-8 bytes only by losing data;
    // keep those URLs visible instead of concealing an unclickable destination.
    if (new TextEncoder().encode(range.url).length > 512
      || protectedRanges.some((item) => intersects(item, range))
      || result.some((item) => intersects(item, range))) return
    result.push({ ...range, target })
  }
  for (const raw of inline.links) {
    const visual = project(raw, mapping)
    if (visual === null) continue
    // Native link metadata wins over token href (escaping/normalization/custom hooks).
    const native = linked.find((item) => intersects(item, visual))
    add({ ...visual, url: native === undefined ? raw.url : native.url })
  }
  for (const range of linked) add(range)
  for (const range of extractUrls(text)) {
    if (linked.some((item) => intersects(item, range))) continue
    add(range)
  }
  return result.sort((a, b) => a.start - b.start)
}

function sliceChunks(chunks: readonly TextChunk[], start: number, end: number): TextChunk[] {
  const result: TextChunk[] = []
  let position = 0
  for (const chunk of chunks) {
    const next = position + chunk.text.length
    if (start < next && end > position) result.push({ ...chunk, text: chunk.text.slice(Math.max(0, start - position), end - position) })
    position = next
  }
  return result
}
type CopySpan = Readonly<{ start: number; end: number; copyStart: number; copyEnd: number }>
type Projection = Readonly<{ text: string; spans: readonly CopySpan[]; urls: readonly string[]; compacts: readonly CompactProseRange[];
  symbols: readonly CompactProseSymbolRange[] }>
type HighlightCommit = Readonly<{ content: string; text: string }>

/** Install only on parent-authorized assistant message sources. Ineligible
 * sources (including code fences with filetype=markdown) return null untouched.
 */
export function installCompactProse(source: Renderable, options: CompactProseOptions): CompactProseSource | null {
  if (!(source instanceof Code) || source.isDestroyed || proseToken(source) === null) return null
  const nativeBuffer: unknown = Reflect.get(source, "textBuffer")
  if (!(nativeBuffer instanceof TextBuffer)) return null
  const originalHook = source.onChunks
  const originalCopy = source.getSelectedText
  const ownCopy = Object.getOwnPropertyDescriptor(source, "getSelectedText")
  const measure = TextBuffer.create(options.widthMethod)
  const copyBuffer = TextBuffer.create(options.widthMethod)
  let projection: Projection | null = null
  let latestCommit: HighlightCommit | null = null
  let revision = 0
  let disposed = false
  const column = (text: string): number => {
    measure.setText(text)
    return measure.length + text.split("\n").length - 1
  }
  // Displayed projection is deliberately independent of current source.content:
  // native streaming can keep the old chip visible until the new highlight lands.
  const displayed = (): Projection | null => !disposed && !source.isDestroyed && source.onChunks === transform && projection !== null
    && source.plainText === projection.text ? projection : null
  const ready = (): boolean => !disposed && !source.isDestroyed && !source.isHighlighting
    && source.onChunks === transform && latestCommit !== null
    && source.content === latestCommit.content && source.plainText === latestCommit.text
  const committed = (): Projection | null => ready() ? displayed() : null
  const invalidate = (): number => { latestCommit = null; return ++revision }
  const publish = (next: Projection | null, copyText: string, context: ChunkRenderContext, text: string, version: number): void => {
    // onChunks precedes native setStyledText. Publish only after its highlight
    // commits, retaining the old displayed URL map during streaming. Text alone
    // is insufficient: two exact destinations can render the identical chip.
    void source.highlightingDone.then(() => {
      if (disposed || source.isDestroyed || source.onChunks !== transform
        || source.content !== context.content || source.plainText !== text) return
      projection = next
      // A queued refresh can invalidate readiness while this native result
      // commits. Its displayed URL/copy map still must follow that actual commit.
      if (version === revision) latestCommit = { content: context.content, text }
      copyBuffer.setText(copyText)
    })
  }
  const transform: OnChunksCallback = async (chunks, context) => {
    const version = invalidate()
    const upstream = originalHook === undefined ? chunks : await originalHook.call(source, chunks, context)
    // FALLBACK: native OnChunksCallback explicitly allows undefined = unchanged.
    const input = upstream === undefined ? chunks : upstream
    const current = proseToken(source)
    if (disposed) return input
    const ranges = current === null ? [] : replacements(input, context, current, source.conceal)
    if (ranges.length === 0) {
      const text = input.map((chunk) => chunk.text).join("")
      publish(null, text, context, text, version)
      return input
    }
    measure.setTabWidth(nativeBuffer.getTabWidth())
    copyBuffer.setTabWidth(nativeBuffer.getTabWidth())
    const original = input.map((chunk) => chunk.text).join("")
    const output: TextChunk[] = []
    const spans: CopySpan[] = []
    const compactRanges: CompactProseRange[] = []
    const symbolRanges: CompactProseSymbolRange[] = []
    const theme = options.readTheme()
    let position = 0
    let copyText = ""
    let text = ""
    for (const range of ranges) {
      const unchanged = original.slice(position, range.start)
      output.push(...sliceChunks(input, position, range.start))
      text += unchanged
      copyText += unchanged
      const start = column(text)
      const copyStart = column(copyText)
      const label = `${range.target.repo[0]!.toUpperCase()}${range.target.repo.slice(1)} #${range.target.number}`
      const base = sliceChunks(input, range.start, range.end)[0]!
      const link = { url: range.url }
      output.push({ ...base, text: label, fg: theme.link, link })
      text += label
      const symbols = options.readStatus(range.target)
      if (symbols.length > 0) {
        output.push({ ...base, text: " ", fg: theme.link, link })
        text += " "
        for (const symbol of symbols) {
          const start = column(text)
          output.push({ ...base, text: symbol.text, fg: theme.symbols[symbol.color], link })
          text += symbol.text
          symbolRanges.push({ start, end: column(text), text: symbol.text, url: range.url })
        }
      }
      const originalOccurrence = original.slice(range.start, range.end)
      copyText += originalOccurrence.includes(range.url) ? originalOccurrence : `${originalOccurrence} (${range.url})`
      const end = column(text)
      spans.push({ start, end, copyStart, copyEnd: column(copyText) })
      compactRanges.push({ start, end, url: range.url })
      position = range.end
    }
    output.push(...sliceChunks(input, position, original.length))
    text += original.slice(position)
    copyText += original.slice(position)
    publish({ text, spans, urls: ranges.map((range) => range.url), compacts: compactRanges, symbols: symbolRanges },
      copyText, context, text, version)
    return output
  }
  const copy = (): string => {
    const current = displayed()
    const selection = source.getSelection()
    // FALLBACK: while highlighting/streaming, the old native buffer is authoritative.
    if (current === null || selection === null || selection.start === selection.end) return originalCopy.call(source)
    const map = (offset: number, edge: "start" | "end"): number => {
      let delta = 0
      for (const span of current.spans) {
        if (offset <= span.start) return offset + delta
        if (offset < span.end) return edge === "start" ? span.copyStart : span.copyEnd
        delta = span.copyEnd - span.end
      }
      return offset + delta
    }
    return copyBuffer.getTextRange(map(selection.start, "start"), map(selection.end, "end"))
  }
  source.onChunks = transform
  source.getSelectedText = copy
  source.requestRender()
  return {
    ready,
    owns: (node) => node === source && committed() !== null,
    urls: () => {
      const current = committed()
      return current === null ? [] : current.urls
    },
    compactRanges: () => {
      const current = committed()
      return current === null ? [] : current.compacts
    },
    statusRanges: () => {
      const current = committed()
      return current === null ? [] : current.symbols
    },
    refresh: async () => {
      if (disposed || source.isDestroyed || source.onChunks !== transform) return
      invalidate()
      await source.highlightingDone
      if (disposed || source.isDestroyed || source.onChunks !== transform) return
      invalidate()
      // Setter dirties highlighting even when content bytes have not changed.
      source.onChunks = undefined
      source.onChunks = transform
      source.requestRender()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      invalidate()
      projection = null
      if (source.onChunks === transform) source.onChunks = originalHook
      if (source.getSelectedText === copy) {
        if (ownCopy === undefined) Reflect.deleteProperty(source, "getSelectedText")
        else Object.defineProperty(source, "getSelectedText", ownCopy)
      }
      measure.destroy()
      copyBuffer.destroy()
      // Native startHighlight clears its dirty bit AFTER awaiting onChunks. If
      // teardown lands between our transform and its commit, re-dirty the
      // restored hook after that highlight completes, without clobbering owners.
      if (source.isHighlighting) void source.highlightingDone.then(() => {
        if (source.isDestroyed || source.onChunks !== originalHook) return
        source.onChunks = originalHook === undefined ? (chunks) => chunks : undefined
        source.onChunks = originalHook
        source.requestRender()
      })
      if (!source.isDestroyed) source.requestRender()
    },
  }
}
