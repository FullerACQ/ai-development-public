/**
 * Version-pinned link renderer: OpenCode 1.18.34, 1.19.0 / OpenTUI 0.4.5, Bun >= 1.3.
 *
 * The renderer's setFrameCallback runs BEFORE root.render. addPostProcessFn runs
 * AFTER drawing and BEFORE native diff/output. Decorate cell hyperlink metadata
 * and serialize owned, single-cell status symbols as ordinary Unicode scalars.
 * Native emits OSC 8; selection still reads untouched source text buffers.
 *
 * Version-specific reads (guarded, never patched): root.renderList,
 * TextBufferRenderable.textBuffer/textBufferView/_firstLineOffset. Replay the
 * current render list's clipped glyph ownership: renderer.hitTest is one frame
 * OLD inside postProcess and translucent mouse targets are not glyph occlusion.
 * Optional Command activation wraps the pinned processSingleMouseEvent instance
 * before native selection/bubbling and restores it only while still our wrapper.
 * It never rewrites stdin bytes, terminal mouse flags, or OS modifier state.
 *
 * Exact evidence:
 * https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/renderer.ts
 * https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/Renderable.ts
 * https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/text-buffer-view.ts
 * https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/zig/renderer.zig
 * https://github.com/anomalyco/opencode/blob/v1.18.34/packages/plugin/src/tui.ts
 * https://github.com/anomalyco/opencode/blob/v1.18.34/packages/tui/src/app.tsx
 *
 * HTTP(S) literals use the shared extractUrls, including links split
 * across styled spans, Unicode prefixes, native wrapping and viewport clipping.
 * Existing native link IDs (including Markdown labels) take precedence.
 * Literal URL mapping on truncated/first-line-offset layouts is diagnosed and
 * skipped; existing native links still support hover. This is
 * a renderer adapter, not a plugin controller or PR data fetcher.
 * Native link URLs are limited to 512 UTF-8 bytes in this exact version.
 */
import * as packageCore from "@opentui/core"
import type { CliRenderer, RenderCommand, TextChunk } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { extractUrls } from "./urls"

type CoreBindings = Pick<typeof packageCore, "BoxRenderable" | "CodeRenderable" | "MarkdownRenderable" |
  "Renderable" | "RenderableEvents" | "StyledText" | "TextBuffer" | "TextBufferView" |
  "TextRenderable" | "OptimizedBuffer" | "RGBA" | "Yoga" | "resolveRenderLib">
type Renderable = packageCore.Renderable
type TextRenderable = packageCore.TextRenderable
type CodeRenderable = packageCore.CodeRenderable
type BoxRenderable = packageCore.BoxRenderable
type RGBA = packageCore.RGBA
type OptimizedBuffer = packageCore.OptimizedBuffer

function isCoreBindings(value: unknown): value is CoreBindings {
  if (typeof value !== "object" || value === null) return false
  const constructors = ["BoxRenderable", "CodeRenderable", "MarkdownRenderable", "Renderable", "StyledText",
    "TextBuffer", "TextBufferView", "TextRenderable", "OptimizedBuffer", "RGBA"]
  if (!constructors.every((name) => typeof Reflect.get(value, name) === "function")) return false
  const events: unknown = Reflect.get(value, "RenderableEvents")
  const yoga: unknown = Reflect.get(value, "Yoga")
  const direction: unknown = typeof yoga === "object" && yoga !== null ? Reflect.get(yoga, "FlexDirection") : null
  return typeof Reflect.get(value, "resolveRenderLib") === "function"
    && typeof events === "object" && events !== null && Reflect.get(events, "DESTROYED") === "destroyed"
    && typeof direction === "object" && direction !== null && typeof Reflect.get(direction, "Column") === "number"
    && ["TextBuffer", "TextBufferView", "OptimizedBuffer"].every((name) => typeof Reflect.get(Reflect.get(value, name), "create") === "function")
    && typeof Reflect.get(Reflect.get(value, "RGBA"), "fromHex") === "function"
}

function bindCoreRuntime(): Readonly<{ core: CoreBindings; error: Diagnostic | null }> {
  // Stock 1.18.34's nested source imports can escape Bun's runtime-module rewrite
  // and resolve a second npm Core. This registry is the same canonical namespace
  // supplied to the virtual @opentui/core module, including minified host classes.
  // Never replace instanceof with duck typing or compare constructor names.
  // https://github.com/anomalyco/opentui/blob/v0.4.5/packages/solid/scripts/runtime-plugin-support-configure.ts#L78-L113
  const install: unknown = Reflect.get(globalThis, Symbol.for("opentui.solid.runtime-plugin-support"))
  // Standalone/headless Core has no Solid host; its ordinary package is canonical.
  if (install === undefined) return { core: packageCore, error: null }
  const core: unknown = typeof install === "object" && install !== null ? Reflect.get(install, "core") : null
  if (isCoreBindings(core)) return { core, error: null }
  // FALLBACK: preserve module initialization so installLinkRenderer can deliver
  // the explicit compatibility diagnostic instead of crashing plugin startup.
  return { core: packageCore, error: { code: "unsupported-runtime", detail: "Unsupported registered OpenTUI Solid Core exports" } }
}

const runtimeBindings = bindCoreRuntime()
/** Use these constructors in transitive presentation modules too. A mixed npm
 * renderable may carry a duplicate num and cannot safely be removed by the host.
 */
export const rendererCore: CoreBindings = runtimeBindings.core
const { BoxRenderable, CodeRenderable, MarkdownRenderable, Renderable, RenderableEvents, StyledText,
  TextBuffer, TextBufferView, TextRenderable, OptimizedBuffer, RGBA, Yoga, resolveRenderLib } = runtimeBindings.core

type UrlRange = Readonly<{ start: number; end: number; url: string }>
const OWNED_PREFIX = "acq-chat-links"
// All are single-scalar, single-cell presentation glyphs. Other graphemes keep
// their native width policy, including wide/combined text and host widgets.
const STATUS_GLYPHS = [..."◇◆✓✕◷⊘?⟳·…"]
/** Parent-created, nonselectable strips use this prefix for native-link hover. */
export const PR_STRIP_PREFIX = "acq-chat-links-pr-strip"
export type LinkHit = Readonly<{
  x: number
  y: number
  linkId: number
  url: string
  source: TextRenderable | CodeRenderable
  /** Bounding rectangle of this occurrence's visible cells, including wrapping. */
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>
  /** Same URL can share a native link ID. Coordinates + source identify occurrences. */
  occurrence: string
}>
export type Diagnostic = Readonly<{
  code: "unsupported-version" | "unsupported-runtime" | "unsupported-layout" | "link-pool-full" | "url-too-long"
  detail: string
}>
export type LinkRendererApi = Pick<TuiPluginApi, "app" | "renderer">
export type InlineStatusRange = Readonly<{ start: number; end: number; text: string; url: string }>
export type LinkRendererOptions = Readonly<{
  onHover: (hit: LinkHit | null) => void
  onDiagnostic: (diagnostic: Diagnostic) => void
  /** Once per native rendered frame, after visibility/occlusion verification.
   * First argument: original sources only. Second: verified native PR-strip
   * links only, for exact polling visibility without recursive decoration.
   * Each array is unique by occurrence; tooltip subtrees are excluded entirely.
   * Layout changes are safe here; update strips idempotently.
   */
  onVisible: (links: readonly LinkHit[], strips: readonly LinkHit[]) => void
  /** Supply both to enable Command-left-click interception. Modifier state is
   * provided by the parent; SGR does not encode macOS Command. No OS/open calls
   * occur here. Accepted presses/releases consume native mouse dispatch.
   */
  commandPressed?: () => boolean
  onActivate?: (hit: LinkHit) => void
  /** Committed projected status spans only. Offsets are native logical columns,
   * not UTF-16 or screen coordinates. Unmarked source/host symbols stay native.
   */
  statusRanges?: (source: Renderable) => readonly InlineStatusRange[]
}>

type ParsedPointer = Readonly<{
  type: "down" | "up" | "move" | "drag" | "scroll"
  button: number
  x: number
  y: number
}>
function isParsedPointer(value: unknown): value is ParsedPointer {
  return typeof value === "object" && value !== null && "type" in value
    && ["down", "up", "move", "drag", "scroll"].includes(String(value.type))
    && "button" in value && Number.isInteger(value.button)
    && "x" in value && Number.isInteger(value.x) && "y" in value && Number.isInteger(value.y)
}

/** These native methods exist in 0.4.5's ZigRenderLib but are omitted from its
 * RenderLib interface. Parse the runtime boundary instead of asserting a type.
 */
export type NativeLinks = Readonly<{
  linkAlloc: (url: string) => number
  linkGetUrl: (id: number, maxLength: number) => string
  attributesGetLinkId: (attributes: number) => number
  attributesWithLink: (attributes: number, id: number) => number
}>
function isNativeLinks(value: unknown): value is NativeLinks {
  return typeof value === "object" && value !== null
    && "linkAlloc" in value && typeof value.linkAlloc === "function"
    && "linkGetUrl" in value && typeof value.linkGetUrl === "function"
    && "attributesGetLinkId" in value && typeof value.attributesGetLinkId === "function"
    && "attributesWithLink" in value && typeof value.attributesWithLink === "function"
}
export function nativeLinks(): NativeLinks | null {
  const value: unknown = resolveRenderLib()
  return isNativeLinks(value) ? value : null
}

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>
function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}

function isCommand(value: unknown): value is RenderCommand {
  if (typeof value !== "object" || value === null || !("action" in value)) return false
  switch (value.action) {
    case "render": return "renderable" in value && value.renderable instanceof Renderable
    case "pushScissorRect": return ["x", "y", "screenX", "screenY", "width", "height"].every(
      (key) => key in value && typeof Reflect.get(value, key) === "number",
    )
    case "pushOpacity": return "opacity" in value && typeof value.opacity === "number"
    case "popOpacity": case "popScissorRect": return true
    default: return false
  }
}

function readCommands(root: Renderable): readonly RenderCommand[] | null {
  const value: unknown = Reflect.get(root, "renderList")
  return Array.isArray(value) && value.every(isCommand) ? value : null
}

function rejectedCommandDetail(root: Renderable): string {
  const list: unknown = Reflect.get(root, "renderList")
  if (!Array.isArray(list)) return `renderList=${typeof list}`
  const index = list.findIndex((command: unknown) => !isCommand(command))
  if (index === -1) return `commands=${list.length}, rootIdentity=${root instanceof Renderable}`
  const command: unknown = list[index]
  if (typeof command !== "object" || command === null) return `command[${index}]=${typeof command}`
  const fields = Object.keys(command).map((key) => `${key}:${typeof Reflect.get(command, key)}`).join(",")
  const renderable: unknown = Reflect.get(command, "renderable")
  return `command[${index}] action=${String(Reflect.get(command, "action"))} fields={${fields}} ` +
    `identity=${renderable instanceof Renderable}, rootIdentity=${root instanceof Renderable}, ` +
    `packageIdentity=${renderable instanceof packageCore.Renderable}, id=${typeof renderable === "object" && renderable !== null ? String(Reflect.get(renderable, "id")).slice(0, 96) : "none"}, ` +
    `importedClass=${Renderable.name}, actualClass=${typeof renderable === "object" && renderable !== null ? renderable.constructor.name : typeof renderable}`
}

/** Glyph ownership is NOT hit-grid ownership: a translucent Box registers its
 * whole mouse rectangle but native blendCells preserves the underlying glyphs.
 * Replay pixel scissors and known Box fill/border behavior, not mouse targets.
 */
function visibleOwners(commands: readonly RenderCommand[], width: number, height: number): Uint32Array | null {
  const owners = new Uint32Array(width * height)
  const stack: Rect[] = [{ x: 0, y: 0, width, height }]
  const opacity = [1]
  // Root.render starts at index 1 (its own command is deliberately not drawn).
  for (const command of commands.slice(1)) {
    switch (command.action) {
      case "pushScissorRect":
        stack.push(intersect(stack.at(-1)!, { x: command.x, y: command.y,
          width: command.width, height: command.height }))
        break
      case "popScissorRect":
        if (stack.length === 1) return null
        stack.pop()
        break
      case "render": {
        const node = command.renderable
        if (node.isDestroyed || opacity.at(-1) === 0) break
        const rect = intersect(stack.at(-1)!, { x: node.screenX, y: node.screenY, width: node.width, height: node.height })
        if (node instanceof BoxRenderable && node.constructor === BoxRenderable
          && node.renderBefore === undefined && node.renderAfter === undefined
          && (!node.shouldFill || node.backgroundColor.a * opacity.at(-1)! < 1)) {
          // Semi-transparent fill tints glyph colors; it does not replace a
          // visible single-cell glyph. Borders still paint their own characters.
          const sides = node.border === true ? ["top", "right", "bottom", "left"] : node.border === false ? [] : node.border
          for (let y = rect.y; y < rect.y + rect.height; y++) {
            for (let x = rect.x; x < rect.x + rect.width; x++) {
              if ((sides.includes("top") && y === node.screenY)
                || (sides.includes("bottom") && y === node.screenY + node.height - 1)
                || (sides.includes("left") && x === node.screenX)
                || (sides.includes("right") && x === node.screenX + node.width - 1)) owners[y * width + x] = node.num
            }
          }
          break
        }
        for (let y = rect.y; y < rect.y + rect.height; y++) {
          owners.fill(node.num, y * width + rect.x, y * width + rect.x + rect.width)
        }
        break
      }
      case "pushOpacity": opacity.push(opacity.at(-1)! * command.opacity); break
      case "popOpacity":
        if (opacity.length === 1) return null
        opacity.pop()
        break
      default: {
        const exhaustive: never = command
        throw new Error(`Unexpected command: ${exhaustive}`)
      }
    }
  }
  return stack.length === 1 && opacity.length === 1 ? owners : null
}

/** Public child traversal includes Markdown's reconciled Code/Text descendants. */
export function textSources(root: Renderable): readonly (TextRenderable | CodeRenderable)[] {
  const sources: (TextRenderable | CodeRenderable)[] = []
  const visit = (node: Renderable): void => {
    if (node.isDestroyed || !node.visible || node.id.startsWith(OWNED_PREFIX)) return
    if (node instanceof TextRenderable || node instanceof CodeRenderable) sources.push(node)
    for (const child of node.getChildren()) visit(child)
  }
  visit(root)
  return sources
}

function hasOwnedAncestor(source: Renderable): boolean {
  for (let node: Renderable | null = source; node !== null; node = node.parent) {
    if (node.id.startsWith(OWNED_PREFIX)) return true
  }
  return false
}

function isPrStripSource(source: Renderable): boolean {
  for (let node: Renderable | null = source; node !== null; node = node.parent) {
    if (node.id.startsWith(PR_STRIP_PREFIX)) return true
  }
  return false
}

/** Strips opt into native hover only. Tooltip/other owned subtrees never do. */
function supportsNativeHover(source: Renderable): boolean {
  for (let node: Renderable | null = source; node !== null; node = node.parent) {
    if (node.id.startsWith(OWNED_PREFIX) && !node.id.startsWith(PR_STRIP_PREFIX)) return false
  }
  return true
}

export type LinkRendererController = Readonly<{
  linkAt: (x: number, y: number) => LinkHit | null
  dispose: () => void
}>
/** Unsupported hosts receive one diagnostic and an inert controller, never an
 * initialization throw. The caller owns startup toast/lifecycle registration.
 */
/** Each entry must be verified against the adapter's internals before adding.
 * 1.19.0: OpenTUI catalog still 0.4.5; packages/tui diff vs 1.18.34 only adds
 * an update-notification provider (v1.18.34...v1.19.0).
 */
const SUPPORTED_OPENCODE_VERSIONS: readonly string[] = ["1.18.34", "1.19.0"]

export function installLinkRenderer(api: LinkRendererApi, options: LinkRendererOptions): LinkRendererController {
  const unsupported = (diagnostic: Diagnostic): LinkRendererController => {
    options.onDiagnostic(diagnostic)
    return { linkAt: () => null, dispose: () => {} }
  }
  if (!SUPPORTED_OPENCODE_VERSIONS.includes(api.app.version)) return unsupported({
    code: "unsupported-version",
    detail: `Expected OpenCode ${SUPPORTED_OPENCODE_VERSIONS.join(" or ")}, received ${api.app.version}`,
  })
  if (runtimeBindings.error !== null) return unsupported(runtimeBindings.error)
  const renderer = api.renderer
  const links = nativeLinks()
  if (typeof renderer.addPostProcessFn !== "function" || typeof renderer.removePostProcessFn !== "function"
    || readCommands(renderer.root) === null || links === null
    || typeof Reflect.get(renderer, "renderOffset") !== "number") return unsupported({
    code: "unsupported-runtime", detail: "Expected OpenTUI 0.4.5 post-process hooks, native links, renderOffset and root.renderList; " +
      `post=${typeof renderer.addPostProcessFn}, remove=${typeof renderer.removePostProcessFn}, native=${links !== null}, ` +
      `offset=${typeof Reflect.get(renderer, "renderOffset")}; ${rejectedCommandDetail(renderer.root)}`,
  })
  const lib = resolveRenderLib()
  const opaque = RGBA.fromHex("#000000")
  const measure = TextBuffer.create(renderer.widthMethod)
  const cache = new WeakMap<Renderable, { text: string; tabWidth: number; ranges: readonly UrlRange[] }>()
  const warned = new Set<string>()
  let cells = new Map<number, LinkHit>()
  let hover: LinkHit | null = null
  let hoverGeometry = ""
  let pointer: Readonly<{ x: number; y: number }> | null = null
  let pendingInput = ""
  let disposed = false
  let press: { hit: LinkHit; x: number; y: number; cancelled: boolean } | null = null
  let restoreMouseDispatch: (() => void) | null = null
  const diagnostic = (source: Renderable, code: Diagnostic["code"], detail: string): void => {
    const key = `${source.num}:${code}:${detail}`
    if (warned.has(key)) return
    warned.add(key)
    options.onDiagnostic({ code, detail: `${source.id}: ${detail}` })
  }
  const linkAt = (x: number, y: number): LinkHit | null => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
      || x >= renderer.width || y >= renderer.height) return null
    const index = y * renderer.width + x
    const hit = cells.get(index)
    if (hit === undefined || hit.source.isDestroyed) return null
    const id = links.attributesGetLinkId(renderer.currentRenderBuffer.buffers.attributes[index])
    return id === hit.linkId ? hit : null
  }
  const updateHover = (): void => {
    const next = pointer === null ? null : linkAt(pointer.x, pointer.y)
    const geometry = next === null ? "" : `${next.x}:${next.y}:${renderer.width}:${renderer.height}:` +
      `${next.bounds.x}:${next.bounds.y}:${next.bounds.width}:${next.bounds.height}`
    if (next?.occurrence === hover?.occurrence && next?.url === hover?.url && geometry === hoverGeometry) return
    hover = next
    hoverGeometry = geometry
    options.onHover(next)
  }
  const observePointer = (type: ParsedPointer["type"], x: number, y: number): void => {
    if (type === "move") { pointer = { x, y }; updateHover() }
    else if (type === "scroll") {
      pointer = { x, y }
      if (hover !== null) { hover = null; hoverGeometry = ""; options.onHover(null) }
    } else { pointer = null; updateHover() }
  }
  const postProcess = (buffer: OptimizedBuffer): void => {
    const commands = readCommands(renderer.root)
    if (commands === null) {
      diagnostic(renderer.root, "unsupported-runtime", `root.renderList changed shape; ${rejectedCommandDetail(renderer.root)}`)
      cells.clear()
      return
    }
    const owners = visibleOwners(commands, buffer.width, buffer.height)
    if (owners === null) {
      diagnostic(renderer.root, "unsupported-runtime", "Unbalanced native scissor commands")
      cells.clear()
      return
    }
    const nextCells = new Map<number, LinkHit>()
    const raw = buffer.buffers
    // Snapshot lazily: native linked labels alone require no cell rewrites.
    const original: { value: { fg: Uint16Array; bg: Uint16Array; styles: Uint32Array } | null } = { value: null }
    const urlsById = new Map<number, string>()
    // Native attributes are already authoritative screen coordinates. This pass
    // needs no source offsets, URL parsing or textBufferView mapping, so it also
    // covers colored badge labels, truncation and first-line-offset layouts.
    const nativeSources = new Map<number, TextRenderable | CodeRenderable>()
    const ownedText = new Set<number>()
    const inlineStatusCells = new Set<number>()
    for (const command of commands) {
      if (command.action !== "render") continue
      const source = command.renderable
      if (source instanceof TextRenderable && hasOwnedAncestor(source)) ownedText.add(source.num)
      if ((source instanceof TextRenderable || source instanceof CodeRenderable)
        && !source.isDestroyed && supportsNativeHover(source)) nativeSources.set(source.num, source)
    }
    const rasters = new Map<Renderable, { buffer: OptimizedBuffer; x: number; y: number }>()
    const redrawCell = (x: number, y: number, char: number, attributes: number): void => {
      if (original.value === null) original.value = { fg: raw.fg.slice(), bg: raw.bg.slice(),
        styles: raw.attributes.map((value) => value & 0xff) }
      buffer.drawChar(char, x, y, opaque, opaque, attributes)
    }
    const setCellLink = (x: number, y: number, linkId: number): void => {
      const index = y * buffer.width + x
      redrawCell(x, y, raw.char[index], links.attributesWithLink(raw.attributes[index] & 0xff, linkId))
    }
    for (let y = 0; y < buffer.height; y++) {
      let run: Readonly<{ source: Renderable; id: number; start: string }> | null = null
      for (let x = 0; x < buffer.width; x++) {
        const index = y * buffer.width + x
        const source = nativeSources.get(owners[index])
        const linkId = links.attributesGetLinkId(raw.attributes[index])
        if (source === undefined || linkId === 0) { run = null; continue }
        const start: string = run !== null && run.source === source && run.id === linkId
          ? run.start : `${x - source.screenX}:${y - source.screenY}`
        run = { source, id: linkId, start }
        let url = urlsById.get(linkId)
        if (url === undefined) { url = links.linkGetUrl(linkId, 512); urlsById.set(linkId, url) }
        nextCells.set(index, { x, y, linkId, url, source,
          bounds: { x, y, width: 1, height: 1 }, occurrence: `${source.num}:screen-native:${linkId}:${start}` })
      }
    }
    try {
      // A translucent native fill preserves characters but clears their link IDs.
      // Draw each visible source view into a bounded, independent raster to recover
      // its original native link metadata. Neither source bytes nor selection change.
      for (const source of nativeSources.values()) {
        const rect = intersect({ x: source.screenX, y: source.screenY, width: source.width, height: source.height },
          { x: 0, y: 0, width: buffer.width, height: buffer.height })
        const view: unknown = Reflect.get(source, "textBufferView")
        if (rect.width === 0 || rect.height === 0 || !(view instanceof TextBufferView)) continue
        const raster = OptimizedBuffer.create(rect.width, rect.height, renderer.widthMethod, { respectAlpha: true })
        rasters.set(source, { buffer: raster, x: rect.x, y: rect.y })
        raster.clear(RGBA.fromValues(0, 0, 0, 0))
        raster.drawTextBuffer(view, source.screenX - rect.x, source.screenY - rect.y)
        const sourceCells = raster.buffers
        for (let y = 0; y < rect.height; y++) {
          let run: Readonly<{ id: number; start: number }> | null = null
          for (let x = 0; x < rect.width; x++) {
            const nativeIndex = y * rect.width + x
            const screenX = rect.x + x
            const screenY = rect.y + y
            const index = screenY * buffer.width + screenX
            const linkId = links.attributesGetLinkId(sourceCells.attributes[nativeIndex])
            if (linkId === 0 || owners[index] !== source.num || raw.char[index] !== sourceCells.char[nativeIndex]) {
              run = null
              continue
            }
            const start: number = run !== null && run.id === linkId ? run.start : x
            run = { id: linkId, start }
            const currentId = links.attributesGetLinkId(raw.attributes[index])
            if (currentId === 0) setCellLink(screenX, screenY, linkId)
            // An existing displayed link wins over source metadata.
            const displayedId = currentId === 0 ? linkId : currentId
            let url = urlsById.get(displayedId)
            if (url === undefined) { url = links.linkGetUrl(displayedId, 512); urlsById.set(displayedId, url) }
            nextCells.set(index, { x: screenX, y: screenY, linkId: displayedId, url, source,
              bounds: { x: screenX, y: screenY, width: 1, height: 1 },
              occurrence: `${source.num}:screen-native:${displayedId}:${rect.x + start - source.screenX}:${screenY - source.screenY}` })
          }
        }
      }
      for (const source of textSources(renderer.root)) {
        const view: unknown = Reflect.get(source, "textBufferView")
        const textBuffer: unknown = Reflect.get(source, "textBuffer")
        const offset: unknown = Reflect.get(source, "_firstLineOffset")
        if (!(view instanceof TextBufferView) || !(textBuffer instanceof TextBuffer) || typeof offset !== "number") {
          diagnostic(source, "unsupported-runtime", "Expected native textBuffer, textBufferView and first-line offset")
          continue
        }
        if (source.truncate || offset !== 0) {
          if (extractUrls(source.plainText).length > 0) {
            diagnostic(source, "unsupported-layout", "Literal URL mapping for truncation / first-line-offset is not implemented; native links remain supported")
          }
          continue
        }
        // TextRenderable.content is StyledText for manual content, but stays empty
        // for Solid's child-span text. The native post-lifecycle text is authoritative.
        const text = source.plainText
        const tabWidth = lib.textBufferGetTabWidth(textBuffer.ptr)
        let entry = cache.get(source)
        if (entry === undefined || entry.text !== text || entry.tabWidth !== tabWidth) {
          lib.textBufferSetTabWidth(measure.ptr, tabWidth)
          const column = (utf16Offset: number): number => {
            const prefix = text.slice(0, utf16Offset)
            measure.setText(prefix)
            // Native length excludes newlines; lineStartCols counts each newline as 1.
            return measure.length + prefix.split("\n").length - 1
          }
          entry = { text, tabWidth, ranges: extractUrls(text).map((range) => ({
            start: column(range.start), end: column(range.end), url: range.url,
          })) }
          cache.set(source, entry)
        }
        const info = view.lineInfo // Visible rows, not the public conceal-remapped source lineInfo.
        const raster = rasters.get(source)
        if (raster === undefined) continue
        const { attributes } = buffer.buffers
        // Optional producer is called only after a flat source's native layout
        // has committed. No producer => no inline status ownership is inferred.
        const statusRanges = options.statusRanges?.(source)
        let nativeRun: Readonly<{ id: number; start: number; end: number }> | null = null
        for (let row = 0; row < info.lineStartCols.length; row++) {
          const y = source.screenY + row
          if (y < 0 || y >= buffer.height) continue
          for (let col = 0; col < Math.min(source.width, info.lineWidthCols[row] - source.scrollX); col++) {
            const x = source.screenX + col
            if (x < 0 || x >= buffer.width) continue
            const index = y * buffer.width + x
            if (owners[index] !== source.num) continue
            const nativeIndex = (y - raster.y) * raster.buffer.width + x - raster.x
            if (raw.char[index] !== raster.buffer.buffers.char[nativeIndex]) continue
            const position = info.lineStartCols[row] + source.scrollX + col
            if (statusRanges !== undefined && statusRanges.some((range) => position >= range.start && position < range.end)) {
              inlineStatusCells.add(index)
            }
            const range = entry.ranges.find((range) => position >= range.start && position < range.end)
            let linkId = links.attributesGetLinkId(attributes[index])
            if (linkId === 0 && range !== undefined) {
              if (new TextEncoder().encode(range.url).byteLength > 512) {
                diagnostic(source, "url-too-long", "Native link URLs are limited to 512 UTF-8 bytes")
                continue
              }
              linkId = links.linkAlloc(range.url) // Native pool deduplicates URLs.
              if (linkId === 0) {
                diagnostic(source, "link-pool-full", "Native link allocation returned 0")
                continue
              }
              // Assigning attributes[index] directly bypasses native LinkTracker
              // refcounts. Re-draw the identical packed glyph through the tracked
              // public method. Opaque colors bypass blending; restore them below.
              // Same glyph => no span cleanup; wide continuation refs are tracked.
              setCellLink(x, y, linkId)
            }
            if (linkId === 0) { nativeRun = null; continue }
            let url = urlsById.get(linkId)
            if (url === undefined) { url = links.linkGetUrl(linkId, 512); urlsById.set(linkId, url) }
            const start: number = nativeRun !== null && nativeRun.id === linkId && nativeRun.end === position
              ? nativeRun.start : position
            nativeRun = { id: linkId, start, end: position + 1 }
            nextCells.set(index, { x, y, linkId, url, source,
              bounds: { x, y, width: 1, height: 1 },
              occurrence: `${source.num}:${range === undefined ? `native:${start}` : `literal:${range.start}`}` })
          }
        }
      }
      if (ownedText.size > 0 || inlineStatusCells.size > 0) {
        // FALLBACK: OpenTUI 0.4.5 misreads a row-1, column>1 startup CPR as
        // OSC 66 support even when both actual probes reject it. Ghostty 1.1.3
        // and cmux terminals can then discard status symbols. Public drawChar
        // accepts Unicode scalars: normalize ONLY owned visible status cells,
        // without changing terminal capabilities, source buffers or host text.
        // terminal.zig:1077–1126; renderer.zig:1420–1450; buffer.ts:560–562.
        const encoded = lib.encodeUnicode(STATUS_GLYPHS.join(""), renderer.widthMethod)
        if (encoded === null) throw new Error("Unable to encode native PR status glyphs")
        try {
          if (encoded.data.length !== STATUS_GLYPHS.length || encoded.data.some(cell => cell.width !== 1)) {
            throw new Error("Expected single-cell native PR status glyphs")
          }
          const scalars = new Map(encoded.data.map((cell, index) => [cell.char, STATUS_GLYPHS[index].codePointAt(0)!]))
          for (let index = 0; index < raw.char.length; index++) {
            if (!ownedText.has(owners[index]) && !inlineStatusCells.has(index)) continue
            const scalar = scalars.get(raw.char[index])
            if (scalar === undefined || scalar === raw.char[index]) continue
            redrawCell(index % buffer.width, Math.floor(index / buffer.width), scalar, raw.attributes[index])
          }
        } finally { lib.freeUnicode(encoded) }
      }
    } finally {
      // Raw colors and low style bits have no reference tracking. Restore them
      // byte-for-byte, including continuation-cell colors and palette encoding.
      if (original.value !== null) {
        raw.fg.set(original.value.fg)
        raw.bg.set(original.value.bg)
        for (let index = 0; index < raw.attributes.length; index++) {
          raw.attributes[index] = links.attributesWithLink(original.value.styles[index], links.attributesGetLinkId(raw.attributes[index]))
        }
      }
      for (const raster of rasters.values()) raster.buffer.destroy()
    }
    const bounds = new Map<string, Rect>()
    for (const hit of nextCells.values()) {
      const previous = bounds.get(hit.occurrence)
      const x = previous === undefined ? hit.x : Math.min(previous.x, hit.x)
      const y = previous === undefined ? hit.y : Math.min(previous.y, hit.y)
      bounds.set(hit.occurrence, { x, y,
        width: (previous === undefined ? hit.x + 1 : Math.max(previous.x + previous.width, hit.x + 1)) - x,
        height: (previous === undefined ? hit.y + 1 : Math.max(previous.y + previous.height, hit.y + 1)) - y })
    }
    for (const [index, hit] of nextCells) nextCells.set(index, { ...hit, bounds: bounds.get(hit.occurrence)! })
    cells = nextCells
  }
  // Observe SGR mouse without consuming it; native mouse dispatch, selection and
  // click handlers continue. addInputHandler is NOT called for handled mouse.
  // Raw stdin also sees events stopped by descendant onMouse handlers.
  const input = (chunk: Buffer | string): void => {
    pendingInput += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
    for (const match of pendingInput.matchAll(pattern)) {
      const button = Number(match[1])
      const renderOffset: unknown = Reflect.get(renderer, "renderOffset")
      if (typeof renderOffset !== "number") {
        diagnostic(renderer.root, "unsupported-runtime", "renderer.renderOffset changed shape")
        pointer = null
        updateHover()
        continue
      }
      const position = { x: Number(match[2]) - 1, y: Number(match[3]) - 1 - renderOffset }
      if ((button & 32) !== 0 && (button & 3) === 3) {
        pointer = position
        updateHover()
      } else if ((button & 64) !== 0) {
        pointer = position // Refresh at the stationary pointer after the scrolled frame.
        if (hover !== null) { hover = null; hoverGeometry = ""; options.onHover(null) }
      } else {
        pointer = null // Hide while selecting / scrolling.
        updateHover()
      }
    }
    // Keep only an unfinished SGR sequence, bounded so arbitrary input cannot grow it.
    const last = pendingInput.lastIndexOf("\x1b[<")
    const tail = last < 0 ? "" : pendingInput.slice(last)
    pendingInput = /^\x1b\[<[\d;]*$/.test(tail) && tail.length < 64 ? tail : ""
  }
  const frame = (): void => {
    const occurrences = new Map<string, LinkHit>()
    const stripOccurrences = new Map<string, LinkHit>()
    for (const hit of cells.values()) {
      if (linkAt(hit.x, hit.y) === null) continue
      const target = !hasOwnedAncestor(hit.source) ? occurrences : isPrStripSource(hit.source) ? stripOccurrences : null
      if (target !== null && !target.has(hit.occurrence)) target.set(hit.occurrence, hit)
    }
    options.onVisible([...occurrences.values()], [...stripOccurrences.values()])
    updateHover() // Re-evaluate stationary pointer after scroll/reflow.
  }
  const blur = (): void => { press = null; pointer = null; updateHover() }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    press = null
    if (restoreMouseDispatch !== null) restoreMouseDispatch()
    renderer.removePostProcessFn(postProcess)
    renderer.stdin.off("data", input)
    renderer.off("frame", frame)
    renderer.off("blur", blur)
    renderer.off("destroy", dispose)
    measure.destroy()
    cells.clear()
    pointer = null
    updateHover()
    renderer.requestRender()
  }
  renderer.addPostProcessFn(postProcess)
  renderer.stdin.on("data", input)
  renderer.on("frame", frame)
  renderer.on("blur", blur)
  renderer.on("destroy", dispose)
  if (options.commandPressed !== undefined || options.onActivate !== undefined) {
    const commandPressed = options.commandPressed
    const onActivate = options.onActivate
    const key = "processSingleMouseEvent"
    const originalDispatch: unknown = Reflect.get(renderer, key)
    const ownDescriptor = Object.getOwnPropertyDescriptor(renderer, key)
    if (typeof commandPressed !== "function" || typeof onActivate !== "function") {
      diagnostic(renderer.root, "unsupported-runtime", "Command activation requires both commandPressed and onActivate callbacks")
    } else if (typeof originalDispatch !== "function" || (ownDescriptor !== undefined
      && (!Object.hasOwn(ownDescriptor, "value") || ownDescriptor.writable !== true))) {
      diagnostic(renderer.root, "unsupported-runtime", "Command activation requires writable stock processSingleMouseEvent dispatch")
    } else {
      // 0.4.5 handleStdinEvent calls this BEFORE hit testing, selection and mouse
      // bubbling. addInputHandler is called only AFTER an unhandled mouse event.
      // https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/renderer.ts#L3306-L3338
      const dispatch = (event: unknown): boolean => {
        const forward = (): boolean => {
          const result: unknown = Reflect.apply(originalDispatch, renderer, [event])
          if (typeof result !== "boolean") throw new Error("Stock mouse dispatch returned a non-boolean result")
          return result
        }
        if (disposed) return forward()
        if (!isParsedPointer(event)) { press = null; return forward() }
        const offset: unknown = Reflect.get(renderer, "renderOffset")
        if (typeof offset !== "number") {
          press = null
          diagnostic(renderer.root, "unsupported-runtime", "Command activation renderOffset changed shape")
          return forward()
        }
        const x = event.x
        const y = event.y - offset
        const hit = linkAt(x, y)
        const finish = (result: boolean): boolean => { observePointer(event.type, x, y); return result }
        if (event.type === "down" && event.button === 0) {
          if (hit !== null && /^https?:\/\//i.test(hit.url) && commandPressed()) {
            press = { hit, x, y, cancelled: false }
            return finish(true) // Do not begin selection or message actions on an owned press.
          }
          press = null
        } else if (press !== null) {
          if (event.type === "up" && event.button === 0) {
            const candidate = press
            press = null // Clear before callback to make reentry/repeated releases inert.
            if (!candidate.cancelled && commandPressed() && hit !== null
              && hit.occurrence === candidate.hit.occurrence && hit.url === candidate.hit.url
              && Math.abs(x - candidate.x) <= 1 && Math.abs(y - candidate.y) <= 1) onActivate(hit)
            return finish(true) // A cancelled owned gesture must not open parent MessageActions.
          }
          if (event.type === "drag" || event.type === "scroll" || event.type === "down"
            || Math.abs(x - press.x) > 1 || Math.abs(y - press.y) > 1) press.cancelled = true
          if (event.type === "drag" || event.type === "move") return finish(true)
        }
        return finish(forward()) // Ordinary input retains the original object and dispatcher.
      }
      if (Reflect.set(renderer, key, dispatch)) {
        // The native parser already assembles fragmented mouse input. Use that
        // single parsed timing for hover/activation instead of a late raw reparse.
        renderer.stdin.off("data", input)
        restoreMouseDispatch = (): void => {
          if (Reflect.get(renderer, key) !== dispatch) return
          if (ownDescriptor === undefined) Reflect.deleteProperty(renderer, key)
          else Object.defineProperty(renderer, key, ownDescriptor)
        }
      } else diagnostic(renderer.root, "unsupported-runtime", "Unable to install Command activation at stock mouse dispatch")
    }
  }
  renderer.requestRender()
  return { linkAt, dispose }
}

export type PrBadge = Readonly<{ url: string; label: string }>
const strips = new WeakMap<Renderable, { node: TextRenderable; signature: string }>()

function isColumn(node: Renderable): boolean {
  return node.getLayoutNode().getFlexDirection() === Yoga.FlexDirection.Column
}

/** Caller supplies the closest source block. Layout
 * insertion is explicit: the parent must be a column container accepting a
 * sibling. Never append badge bytes to the source's TextBuffer or StyledText.
 */
export function attachBadgeStrip(
  renderer: CliRenderer, source: Renderable, badges: readonly PrBadge[],
  onDiagnostic: (diagnostic: Diagnostic) => void,
): TextRenderable | null {
  if (source.parent === null || source.isDestroyed || !isColumn(source.parent)) {
    onDiagnostic({ code: "unsupported-layout", detail: `${source.id}: badge strip requires an attached direct child of a column` })
    return null
  }
  if (badges.some((badge) => new TextEncoder().encode(badge.url).byteLength > 512)) {
    onDiagnostic({ code: "url-too-long", detail: `${source.id}: badge URLs exceed native 512-byte limit` })
    return null
  }
  const parent = source.parent
  const index = parent.getChildren().indexOf(source)
  const signature = JSON.stringify(badges.map((badge) => [badge.url, badge.label]))
  const existing = strips.get(source)
  if (existing !== undefined && !existing.node.isDestroyed && existing.node.parent === parent
    && existing.signature === signature) {
    if (parent.getChildren()[index + 1] !== existing.node) parent.add(existing.node, index + 1)
    return existing.node
  }
  const content = new StyledText(badges.flatMap((badge, index): TextChunk[] => [
    { __isChunk: true, text: index === 0 ? "" : "  " },
    { __isChunk: true, text: badge.label, link: { url: badge.url } },
  ]))
  if (existing !== undefined && !existing.node.isDestroyed && existing.node.parent === parent) {
    existing.node.content = content
    existing.signature = signature
    if (parent.getChildren()[index + 1] !== existing.node) parent.add(existing.node, index + 1)
    return existing.node
  }
  if (existing !== undefined && !existing.node.isDestroyed) existing.node.destroy()
  const strip = new TextRenderable(renderer, { id: `${PR_STRIP_PREFIX}-${source.num}`, content,
    selectable: false, flexShrink: 0, height: 1, wrapMode: "none" })
  parent.add(strip, index + 1)
  strips.set(source, { node: strip, signature })
  const removeWithSource = (): void => strip.destroy()
  source.once(RenderableEvents.DESTROYED, removeWithSource)
  strip.once(RenderableEvents.DESTROYED, () => source.off(RenderableEvents.DESTROYED, removeWithSource))
  return strip // strip.destroy() removes it from its parent.
}

const markdownAnchors = new WeakMap<Renderable, BoxRenderable>()

export function sourceBlock(source: Renderable): Renderable {
  let block = source
  // A tool/list marker can be in a row. Attach after that row, never inside it.
  while (block.parent !== null && !isColumn(block.parent)) block = block.parent
  const parent = block.parent
  if (parent === null || block.isDestroyed || markdownAnchors.get(block) === parent) return block
  let inMarkdown = false
  for (let node: Renderable | null = parent; node !== null; node = node.parent) {
    if (node instanceof MarkdownRenderable) { inMarkdown = true; break }
  }
  if (!inMarkdown) return block
  // Markdown reconciliation counts native child slots, including nested list
  // paragraphs. A loose badge sibling corrupts those indices when text streams.
  // Give this paragraph/code/row ONE slot, retaining the original source object
  // inside a column. The controller can add a nonselectable sibling in that
  // column without changing Markdown's child count, source bytes or callbacks.
  // OpenTUI 0.4.5 Markdown.ts:819–856,1757–1854. Use public reparenting only;
  // its block-state references continue to update/destroy the original source.
  const anchor = new BoxRenderable(block.ctx, { id: `acq-pr-anchor-${block.num}`, flexShrink: 0, flexDirection: "column" })
  const index = parent.getChildren().indexOf(block)
  parent.add(anchor, index)
  anchor.add(block)
  markdownAnchors.set(block, anchor)
  block.once(RenderableEvents.DESTROYED, () => anchor.destroyRecursively())
  return block
}

export type TooltipStyle = Readonly<{
  foreground: string | RGBA
  background: string | RGBA
  border: string | RGBA
}>
export type TooltipLayout = Readonly<{ clipped: boolean; totalRows: number; visibleRows: number }>

function tooltipAnchor(hit: LinkHit, width: number, height: number): Rect {
  const viewport = { x: 0, y: 0, width, height }
  let bounds = intersect(hit.bounds, viewport)
  for (let source: Renderable | null = hit.source; source !== null && source.parent !== null; source = source.parent) {
    const id = `${PR_STRIP_PREFIX}-${source.num}`
    const strip = source.parent.getChildren().find(node => node.id === id)
    if (strip === undefined) continue
    let visible = intersect({ x: strip.screenX, y: strip.screenY, width: strip.width, height: strip.height }, viewport)
    for (let node: Renderable | null = strip; node !== null; node = node.parent) {
      if (!node.visible) { visible = { ...visible, height: 0 }; break }
      if (node.getLayoutNode().getOverflow() === Yoga.Overflow.Hidden) {
        visible = intersect(visible, { x: node.screenX, y: node.screenY, width: node.width, height: node.height })
      }
    }
    if (visible.width > 0 && visible.height > 0) {
      const x = Math.min(bounds.x, visible.x), y = Math.min(bounds.y, visible.y)
      bounds = { x, y, width: Math.max(bounds.x + bounds.width, visible.x + visible.width) - x,
        height: Math.max(bounds.y + bounds.height, visible.y + visible.height) - y }
    }
    break
  }
  return bounds
}

/** App-level absolute overlay. An actual plugin may mount it via the public
 * `app` slot instead; root.add is directly runnable without Solid compilation.
 */
export function createTooltipOverlay(renderer: CliRenderer): Readonly<{
  node: BoxRenderable
  text: TextRenderable
  /** Up to 8 content rows plus border, bounded by the available non-link viewport.
   * Oversize content ends with an explicit omitted-row marker; callers can inspect
   * clipped/totalRows to prioritize a failure reason in their presentation.
   */
  show: (hit: LinkHit | null, description: string, theme?: TooltipStyle) => TooltipLayout
  dispose: () => void
}> {
  // Explicit built-in palette; show(theme) overrides all three colors and an
  // omitted theme retains the current palette (including parent-applied styles).
  const node = new BoxRenderable(renderer, { id: `${OWNED_PREFIX}-tooltip`, position: "absolute",
    left: 0, top: 0, width: 40, height: 2, zIndex: 10000, backgroundColor: "#202632",
    border: true, borderColor: "#7d8799", visible: false, overflow: "hidden" })
  const text = new TextRenderable(renderer, { id: `${OWNED_PREFIX}-tooltip-text`, width: "100%", height: "100%",
    fg: "#ffffff", selectable: false, wrapMode: "word" })
  const measure = TextBuffer.create(renderer.widthMethod)
  const view = TextBufferView.create(measure)
  view.setWrapMode("word")
  node.add(text)
  renderer.root.add(node)
  let disposed = false
  const release = (): void => {
    if (disposed) return
    disposed = true
    view.destroy()
    measure.destroy()
    renderer.off("destroy", release)
  }
  node.once(RenderableEvents.DESTROYED, release)
  renderer.once("destroy", release)
  const show = (hit: LinkHit | null, description: string, theme?: TooltipStyle): TooltipLayout => {
    if (disposed) return { clipped: false, totalRows: 0, visibleRows: 0 }
    if (hit === null) { node.visible = false; return { clipped: false, totalRows: 0, visibleRows: 0 } }
    if (theme !== undefined) {
      node.backgroundColor = theme.background
      node.borderColor = theme.border
      text.fg = theme.foreground
    }
    let width = Math.min(72, renderer.width)
    let border = renderer.width >= 3 && renderer.height >= 3 ? 2 : 0
    measure.setText(description)
    view.setWrapWidth(Math.max(1, width - border))
    let totalRows = view.logicalLineInfo.lineStartCols.length
    // Use the full viewport width before dropping wrapped text such as a failure reason.
    if (totalRows > 8 && width < renderer.width) {
      width = renderer.width
      view.setWrapWidth(Math.max(1, width - border))
      totalRows = view.logicalLineInfo.lineStartCols.length
    }
    let height = Math.min(totalRows, 8) + border
    let x = Math.max(0, Math.min(hit.x, renderer.width - width))
    let y: number
    // The adjacent status is part of the hover anchor too: otherwise the popup
    // hides the very strip that was moved next to this paragraph/code block.
    const link = tooltipAnchor(hit, renderer.width, renderer.height)
    const below = renderer.height - link.y - link.height
    const right = renderer.width - link.x - link.width
    if (height <= below) y = link.y + link.height
    else if (height <= link.y) y = link.y - height
    else if (width <= right || width <= link.x) {
      x = width <= right ? link.x + link.width : link.x - width
      height = Math.min(height, renderer.height)
      y = Math.max(0, Math.min(hit.y, renderer.height - height))
    } else if (Math.max(link.y, below) === 0 && Math.max(link.x, right) > 0) {
      width = Math.max(link.x, right)
      border = width >= 3 && renderer.height >= 3 ? 2 : 0
      view.setWrapWidth(Math.max(1, width - border))
      totalRows = view.logicalLineInfo.lineStartCols.length
      height = Math.min(Math.min(totalRows, 8) + border, renderer.height)
      x = right >= link.x ? link.x + link.width : link.x - width
      y = 0
    } else {
      height = Math.min(height, Math.max(link.y, below))
      y = below >= link.y ? link.y + link.height : link.y - height
    }
    if (height <= border) {
      border = 0 // Tiny viewport: give the limited rows to content.
      view.setWrapWidth(Math.max(1, width))
      totalRows = view.logicalLineInfo.lineStartCols.length
    }
    if (height === 0) {
      node.visible = false
      return { clipped: true, totalRows, visibleRows: 0 }
    }
    const capacity = height - border
    const clipped = totalRows > capacity
    let display = description
    if (clipped) {
      const keep = Math.max(0, capacity - 1)
      const end = view.logicalLineInfo.lineStartCols[keep]
      view.setSelection(0, end)
      const prefix = view.getSelectedText().trimEnd()
      const omitted = totalRows - keep
      const marker = width - border >= 22 ? `… ${omitted} rows not shown` : "…"
      display = keep === 0 ? marker : `${prefix}\n${marker}`
      view.resetSelection()
    }
    node.border = border > 0
    node.width = width
    node.height = height
    node.left = x
    node.top = y
    if (text.plainText !== display) text.content = display
    node.visible = true
    return { clipped, totalRows, visibleRows: Math.min(totalRows, capacity) }
  }
  return { node, text, show, dispose: () => { release(); if (!node.isDestroyed) node.destroyRecursively() } }
}
