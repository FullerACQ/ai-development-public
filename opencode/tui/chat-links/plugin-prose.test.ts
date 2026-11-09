/** Controller + real OpenTUI Markdown integration; no direct prose-helper calls. */
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { dirname, join } from "node:path"
import { ScrollBoxRenderable, SyntaxStyle, TreeSitterClient, type CliRenderer, type CodeRenderable, type Renderable,
  type TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { HOVER_REENTRY_THROTTLE_MS } from "./cache"
import type { GitHubPrClient, GitHubPrResult, GitHubPrStatus, GitHubPrTarget } from "./github"
import { installChatLinks, type ChatLinksApi, type ChatLinksOptions } from "./plugin"
import { nativeLinks, PR_STRIP_PREFIX, rendererCore, textSources } from "./renderer"

const { BoxRenderable: Box, CodeRenderable: Code, MarkdownRenderable: Markdown, TextRenderable: Text, RGBA } = rendererCore
const canonical = "https://github.com/octo-org-sample/alpha/pull/224"
const originalUrl = `${canonical}/files?diff=split#diff-界`
const epoch = Date.UTC(2026, 9, 8, 12, 34, 56)
const palette: ChatLinksApi["theme"]["current"] = {
  primary: RGBA.fromHex("#44bbff"), text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#8899aa"),
  success: RGBA.fromHex("#11cc33"), error: RGBA.fromHex("#ee2244"), warning: RGBA.fromHex("#ffbb22"),
  backgroundPanel: RGBA.fromHex("#202632"), border: RGBA.fromHex("#7d8799"),
}
const renderers: CliRenderer[] = []
const clients: TreeSitterClient[] = []
const styles: SyntaxStyle[] = []
const controllers: ReturnType<typeof installChatLinks>[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose()
  mock.restore()
  for (const renderer of renderers.splice(0)) renderer.destroy()
  for (const client of clients.splice(0)) await client.destroy()
  for (const style of styles.splice(0)) style.destroy()
})

function success(target: GitHubPrTarget, lifecycle: GitHubPrStatus["lifecycle"], ci: GitHubPrStatus["ci"]): GitHubPrResult {
  return { ok: true, value: { target, url: target.canonicalUrl, title: "Synthetic title for hover only", lifecycle,
    ci, ciReason: null, checks: [{ name: "native integration", outcome: ci, url: null }] } }
}
function descendants(node: Renderable): Renderable[] { return [node, ...node.getChildren().flatMap(descendants)] }
async function settle(): Promise<void> { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }
async function setup(content: string, width = 80) {
  const s = await createTestRenderer({ width, height: 40, useMouse: true })
  renderers.push(s.renderer)
  const client = new TreeSitterClient({ dataPath: join(dirname(import.meta.path), "parser-cache") })
  clients.push(client)
  await client.initialize()
  const style = SyntaxStyle.fromStyles({ default: { fg: palette.text },
    "markup.link": { fg: palette.primary }, "markup.link.label": { fg: palette.primary, underline: true },
    "markup.link.url": { fg: palette.primary }, "markup.raw": { fg: palette.textMuted } })
  styles.push(style)
  const parent = new Box(s.renderer, { id: "assistant-message", flexDirection: "column", flexShrink: 0 })
  const mouseUp = mock(() => {})
  parent.onMouseUp = mouseUp
  const md = new Markdown(s.renderer, { id: "assistant-markdown", content, syntaxStyle: style,
    treeSitterClient: client, conceal: true, streaming: true, internalBlockMode: "top-level" })
  parent.add(md); s.renderer.root.add(parent)
  const toast = mock<ChatLinksApi["ui"]["toast"]>(() => {})
  const log = mock(async () => Response.json(true))
  const sdk = createOpencodeClient({ baseUrl: "https://test.invalid", fetch: Object.assign(log,
    { preconnect: globalThis.fetch.preconnect }) })
  const theme = { current: palette }
  const clock = { now: epoch }
  const sources = () => textSources(md).filter((source): source is CodeRenderable => source instanceof Code)
  const strips = () => descendants(s.renderer.root).filter((node): node is TextRenderable =>
    node instanceof Text && node.id.startsWith(PR_STRIP_PREFIX))
  const draw = async (frames = 6) => {
    for (let frame = 0; frame < frames; frame++) {
      await s.renderOnce()
      for (const source of sources()) await source.highlightingDone
      await settle()
    }
  }
  const install = (fetch: GitHubPrClient["fetch"], activation?: ChatLinksOptions["activation"]) => {
    const controller = installChatLinks({ app: { version: "1.18.34" }, renderer: s.renderer,
      theme, ui: { toast }, client: { app: sdk.app } }, { client: { fetch }, now: () => clock.now, activation })
    controllers.push(controller)
    return controller
  }
  const copyAll = (source: CodeRenderable | TextRenderable): string => {
    s.renderer.clearSelection()
    s.renderer.startSelection(source, source.screenX, source.screenY)
    s.renderer.updateSelection(source, source.screenX + source.width, source.screenY + source.height - 1,
      { finishDragging: true })
    return s.renderer.getSelection()!.getSelectedText()
  }
  const tooltip = (): TextRenderable => {
    const box = s.renderer.root.getChildren().find((node) => node.id === "acq-chat-links-tooltip")!
    const text = box.getChildren().find((node): node is TextRenderable => node instanceof Text)!
    return text
  }
  const healthy = () => { expect(toast).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled() }
  return { ...s, md, parent, mouseUp, clock, theme, sources, strips, draw, install, copyAll, tooltip, healthy }
}
type Setup = Awaited<ReturnType<typeof setup>>
function linkAt(s: Setup, x: number, y: number): string | null {
  const links = nativeLinks()!
  const id = links.attributesGetLinkId(s.renderer.currentRenderBuffer.buffers.attributes[y * s.renderer.width + x])
  return id === 0 ? null : links.linkGetUrl(id, 512)
}
function linkedCell(s: Setup, source: CodeRenderable | TextRenderable, url: string): { x: number; y: number } {
  for (let y = Math.max(0, source.screenY); y < Math.min(s.renderer.height, source.screenY + source.height); y++) {
    for (let x = Math.max(0, source.screenX); x < Math.min(s.renderer.width, source.screenX + source.width); x++) {
      if (linkAt(s, x, y) === url) return { x, y }
    }
  }
  throw new Error(`No visible native cells for ${url}`)
}
function symbolColor(s: Setup, source: CodeRenderable, symbol: string) {
  const spans = s.captureSpans().lines.slice(source.screenY, source.screenY + source.height).flatMap((line) => line.spans)
  const span = spans.find((span) => span.text.includes(symbol))
  if (span === undefined) throw new Error(`Missing rendered symbol ${symbol}`)
  return span.fg
}
function wireClick(s: Setup, x: number, y: number, button: 0 | 16 = 0): void {
  const down = `\x1b[<${button};${x + 1};${y + 1}M`
  const up = `\x1b[<${button};${x + 1};${y + 1}m`
  s.renderer.stdin.emit("data", Buffer.from(down + up))
}

test("first visible prose and the same code-fence PR deduplicate fetches, with one chip and only a code strip", async () => {
  const content = `[Alpha PR #224](${originalUrl})\n\n\`\`\`text\n${originalUrl}\n\`\`\``
  const s = await setup(content)
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  s.install(fetch); await s.draw()
  const [prose, code] = s.sources()
  expect(prose!.plainText).toBe("Alpha #224 ◆✕")
  expect(code!.plainText).toBe(originalUrl)
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual([canonical])
  expect(s.strips()).toHaveLength(1)
  expect(s.strips()[0]!.id).toBe(`${PR_STRIP_PREFIX}-${code!.num}`)
  expect(s.strips()[0]!.screenY).toBe(code!.screenY + code!.height)
  expect(s.copyAll(code!)).toBe(originalUrl)
  expect(s.copyAll(prose!)).toBe(`Alpha PR #224 (${originalUrl})`)
  expect(prose!.content).toBe(`[Alpha PR #224](${originalUrl})`)
  expect(code!.content).toBe(originalUrl)
  expect(s.md.content).toBe(content)
  expect(linkAt(s, prose!.screenX, prose!.screenY)).toBe(originalUrl)
  s.healthy()
}, 15000)

test("live draft/failing to merged/passing updates inline colors and hover freshness without an extra row", async () => {
  const s = await setup(`Alpha PR #224 (${originalUrl})`)
  let lifecycle: GitHubPrStatus["lifecycle"] = "draft"
  let ci: GitHubPrStatus["ci"] = "failed"
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, lifecycle, ci))
  s.install(fetch); await s.draw()
  const prose = s.sources()[0]!
  expect(prose.plainText).toBe("Alpha #224 ◇✕")
  expect(symbolColor(s, prose, "◇")).toEqual(palette.textMuted)
  expect(symbolColor(s, prose, "✕")).toEqual(palette.error)
  const height = prose.height
  const first = linkedCell(s, prose, originalUrl)
  await s.mockMouse.moveTo(first.x, first.y); await s.draw()
  expect(s.tooltip().plainText).toContain("Draft · CI failing")
  expect(s.tooltip().plainText).toContain(`Last fetched: ${new Date(epoch).toLocaleString()}`)
  await s.mockMouse.moveTo(79, 39); await s.draw()
  lifecycle = "merged"; ci = "passed"
  s.clock.now += HOVER_REENTRY_THROTTLE_MS + 1
  await s.mockMouse.moveTo(first.x, first.y); await s.draw()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(prose.plainText).toBe("Alpha #224 ◆✓")
  expect(symbolColor(s, prose, "◆")).toEqual(RGBA.fromHex("#a78bfa"))
  expect(symbolColor(s, prose, "✓")).toEqual(palette.success)
  expect(s.tooltip().plainText).toContain("Merged · CI passing")
  expect(s.tooltip().plainText).toContain(`Last fetched: ${new Date(s.clock.now).toLocaleString()}`)
  expect(prose.height).toBe(height)
  expect(s.md.height).toBe(height)
  expect(s.strips()).toHaveLength(0)
  expect(prose.plainText).not.toContain("Synthetic title")
  s.healthy()
}, 15000)

test("30-column Unicode wrapping copies the original full line and label/query/fragment from the chip", async () => {
  const original = `界 🙂 é before Alpha PR #224 (${originalUrl}), after 界.`
  const s = await setup(original, 30)
  s.install(async (target) => success(target, "merged", "failed")); await s.draw()
  const prose = s.sources()[0]!
  expect(prose.plainText).toBe("界 🙂 é before Alpha #224 ◆✕, after 界.")
  expect(prose.height).toBeGreaterThan(1)
  expect(s.strips()).toHaveLength(0)
  expect(s.copyAll(prose)).toBe(original)
  s.renderer.clearSelection()
  const chip = linkedCell(s, prose, originalUrl)
  s.renderer.startSelection(prose, chip.x, chip.y)
  s.renderer.updateSelection(prose, chip.x + 1, chip.y, { finishDragging: true })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(`Alpha PR #224 (${originalUrl})`)
  expect(prose.content).toBe(original)
  expect(s.md.content).toBe(original)
  s.healthy()
}, 15000)

test("markdown-language fences and inline code commands retain visible original URLs and attached strips", async () => {
  const command = `gh pr view ${originalUrl}`
  const content = `Use \`${command}\`.\n\n\`\`\`markdown\nAlpha PR #224 (${originalUrl})\n\`\`\``
  const s = await setup(content)
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install(fetch); await s.draw()
  const [inline, fence] = s.sources()
  expect(inline!.plainText).toBe(`Use ${command}.`)
  expect(fence!.plainText).toBe(`Alpha PR #224 (${originalUrl})`)
  expect(s.copyAll(inline!)).toBe(`Use ${command}.`)
  expect(s.copyAll(fence!)).toBe(`Alpha PR #224 (${originalUrl})`)
  expect(s.strips().map((strip) => strip.id).sort()).toEqual([
    `${PR_STRIP_PREFIX}-${inline!.num}`, `${PR_STRIP_PREFIX}-${fence!.num}`,
  ].sort())
  expect(s.sources().every((source) => !source.plainText.includes("Alpha #224 ◇✕"))).toBeTrue()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test.each([{ label: "plain SGR", button: 0 as const }, { label: "Ctrl=true SGR", button: 16 as const }])(
  "native parsed $label with configured Command activation preserves URL/hover and restores dispatch on dispose", async ({ button }) => {
  const content = `[Alpha PR #224](${originalUrl})`
  const s = await setup(content)
  await s.draw()
  const prose = s.sources()[0]!
  const originalText = prose.plainText
  const originalHook = prose.onChunks
  const originalCopy = prose.getSelectedText
  const originalDispatch: unknown = Reflect.get(s.renderer, "processSingleMouseEvent")
  const listeners = { data: s.renderer.stdin.listenerCount("data"), frame: s.renderer.listenerCount("frame"),
    blur: s.renderer.listenerCount("blur"), destroy: s.renderer.listenerCount("destroy") }
  const opened: string[] = []
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  const controller = s.install(fetch, { commandPressed: () => true,
    openHttpUrl: async (url) => { opened.push(url); return { ok: true, value: undefined } } })
  await s.draw()
  const chip = linkedCell(s, prose, originalUrl)
  await s.mockMouse.moveTo(chip.x, chip.y); await s.draw()
  expect(linkAt(s, chip.x, chip.y)).toBe(originalUrl)
  expect(s.tooltip().plainText).toContain("octo-org-sample/alpha #224")
  expect(s.tooltip().plainText).toContain("Merged · CI failing")
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual([canonical])
  wireClick(s, chip.x, chip.y, button); await settle()
  expect(opened).toEqual([originalUrl])
  expect(s.mouseUp).not.toHaveBeenCalled()
  expect(s.renderer.getSelection()).toBeNull()
  controller.dispose(); controller.dispose(); await s.draw()
  expect(prose.plainText).toBe(originalText)
  expect(prose.onChunks).toBe(originalHook)
  expect(prose.getSelectedText).toBe(originalCopy)
  expect(Reflect.get(s.renderer, "processSingleMouseEvent")).toBe(originalDispatch)
  expect({ data: s.renderer.stdin.listenerCount("data"), frame: s.renderer.listenerCount("frame"),
    blur: s.renderer.listenerCount("blur"), destroy: s.renderer.listenerCount("destroy") }).toEqual(listeners)
  expect(s.strips()).toHaveLength(0)
  expect(s.renderer.root.getChildren().some((node) => node.id === "acq-chat-links-tooltip")).toBeFalse()
  wireClick(s, prose.screenX + 1, prose.screenY); await settle()
  expect(s.mouseUp).toHaveBeenCalledTimes(1)
  expect(opened).toEqual([originalUrl])
  expect(s.copyAll(prose)).toBe(originalText)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test("failed stale refresh clears old success and settled redraws do not grow rows, nodes or redraw requests", async () => {
  const s = await setup(originalUrl)
  let available = true
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => available ? success(target, "open", "passed")
    : { ok: false, error: { kind: "authentication", message: "GitHub authentication expired" } })
  s.install(fetch); await s.draw()
  const prose = s.sources()[0]!
  expect(prose.plainText).toBe("Alpha #224 ✓")
  const height = prose.height
  available = false
  s.clock.now += HOVER_REENTRY_THROTTLE_MS + 1
  const chip = linkedCell(s, prose, originalUrl)
  await s.mockMouse.moveTo(chip.x, chip.y); await s.draw()
  expect(prose.plainText).toBe("Alpha #224 ?")
  expect(symbolColor(s, prose, "?")).toEqual(palette.textMuted)
  expect(s.tooltip().plainText).toContain("GitHub authentication expired")
  expect(s.tooltip().plainText).toContain(`Last fetched: ${new Date(epoch).toLocaleString()}`)
  await s.mockMouse.moveTo(79, 39); await s.draw()
  const nodes = descendants(s.renderer.root)
  const frame = s.captureCharFrame()
  const redraw = spyOn(s.renderer, "requestRender")
  await s.draw(20)
  expect(redraw).not.toHaveBeenCalled()
  expect(descendants(s.renderer.root)).toEqual(nodes)
  expect(s.captureCharFrame()).toBe(frame)
  expect(prose.height).toBe(height)
  expect(s.strips()).toHaveLength(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(s.copyAll(prose)).toBe(originalUrl)
  s.healthy()
}, 15000)

test("controller theme changes refresh inline label and CI colors without refetching or adding rows", async () => {
  const s = await setup(originalUrl)
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "open", "passed"))
  s.install(fetch); await s.draw()
  const prose = s.sources()[0]!
  const before = s.renderer.currentRenderBuffer.buffers.fg.slice(0, 4)
  const next = { ...palette, primary: RGBA.fromHex("#ffaa33"), success: RGBA.fromHex("#44ffff") }
  s.theme.current = next
  await s.draw()
  expect(prose.plainText).toBe("Alpha #224 ✓")
  expect(s.renderer.currentRenderBuffer.buffers.fg.slice(0, 4)).not.toEqual(before)
  expect(symbolColor(s, prose, "✓")).toEqual(next.success)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.strips()).toHaveLength(0)
  expect(s.md.height).toBe(prose.height)
  expect(s.copyAll(prose)).toBe(originalUrl)
  s.healthy()
}, 15000)

test("streamed label and exact destination changes keep the same chip and update native activation/copy mappings", async () => {
  const s = await setup(`[First label](${originalUrl})`)
  const opened: string[] = []
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  s.install(fetch, { commandPressed: () => true,
    openHttpUrl: async (url) => { opened.push(url); return { ok: true, value: undefined } } })
  await s.draw()
  const prose = s.sources()[0]!
  const height = prose.height
  expect(s.copyAll(prose)).toBe(`First label (${originalUrl})`)
  for (let iteration = 1; iteration <= 4; iteration++) {
    const nextUrl = `${canonical}/checks?check=${iteration}#changed-界`
    const content = `[Updated label ${iteration}](${nextUrl})`
    s.renderer.clearSelection()
    s.md.content = content
    await s.draw()
    expect(s.sources()[0]).toBe(prose)
    expect(prose.plainText).toBe("Alpha #224 ◆✕")
    expect(prose.content).toBe(content)
    expect(s.md.content).toBe(content)
    expect(s.copyAll(prose)).toBe(`Updated label ${iteration} (${nextUrl})`)
    s.renderer.clearSelection()
    const chip = linkedCell(s, prose, nextUrl)
    wireClick(s, chip.x, chip.y); await settle()
    expect(opened.at(-1)).toBe(nextUrl)
    expect(prose.height).toBe(height)
    expect(s.strips()).toHaveLength(0)
  }
  expect(fetch).toHaveBeenCalledTimes(1)
  s.healthy()
}, 15000)

test("plain user Text retains its full URL, native copy and fallback strip while assistant Markdown compacts", async () => {
  const content = `[Alpha PR #224](${originalUrl})`
  const s = await setup(content)
  const userText = `Please review ${originalUrl}`
  const user = new Text(s.renderer, { id: "plain-user-message", content: userText, flexShrink: 0 })
  s.renderer.root.add(user, 0)
  const originalCopy = user.getSelectedText
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  s.install(fetch); await s.draw()
  expect(user.plainText).toBe(userText)
  expect(user.getSelectedText).toBe(originalCopy)
  expect(s.copyAll(user)).toBe(userText)
  expect(s.sources()[0]!.plainText).toBe("Alpha #224 ◆✕")
  expect(s.strips()).toHaveLength(1)
  expect(s.strips()[0]!.id).toBe(`${PR_STRIP_PREFIX}-${user.num}`)
  expect(s.strips()[0]!.plainText).toBe("alpha#224 ◆ ✕")
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test("queued native highlighting defers prose strips until committed compaction, preserving the first-sight fetch", async () => {
  const content = `[Alpha PR #224](${originalUrl})`
  const s = await setup(content)
  const prose = s.sources()[0]!
  const native = prose.onChunks!
  let release: () => void = () => { throw new Error("Highlight gate not initialized") }
  const gate = new Promise<void>((resolve) => { release = resolve })
  prose.onChunks = async (chunks, context) => { await gate; return native(chunks, context) }
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  s.install(fetch)
  await s.renderOnce(); await settle()
  try {
    // Initial native StyledText/raw prose is permitted; no fallback may create
    // an anchor around the pending paragraph before its parser hook commits.
    expect(s.strips()).toHaveLength(0)
    expect(prose.parent).toBe(s.md)
    expect(prose.content).toBe(content)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { release() }
  await s.draw()
  expect(prose.plainText).toBe("Alpha #224 ◆✕")
  expect(s.strips()).toHaveLength(0)
  expect(s.copyAll(prose)).toBe(`Alpha PR #224 (${originalUrl})`)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test("mixed compact prose and an exact-distinct inline command URL retain only the command fallback strip across refresh", async () => {
  const command = `gh pr view ${originalUrl}`
  const content = `Use \`${command}\`, then Alpha PR #224 (${canonical}).`
  const s = await setup(content)
  let ci: GitHubPrStatus["ci"] = "failed"
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", ci))
  s.install(fetch); await s.draw()
  const prose = s.sources()[0]!
  expect(prose.plainText).toBe(`Use ${command}, then Alpha #224 ◆✕.`)
  expect(s.strips()).toHaveLength(1)
  expect(s.strips()[0]!.id).toBe(`${PR_STRIP_PREFIX}-${prose.num}`)
  expect(s.strips()[0]!.plainText).toBe("alpha#224 ◆ ✕")
  expect(s.copyAll(prose)).toBe(`Use ${command}, then Alpha PR #224 (${canonical}).`)
  const cell = linkedCell(s, prose, canonical)
  s.clock.now += HOVER_REENTRY_THROTTLE_MS + 1
  ci = "passed"
  await s.mockMouse.moveTo(cell.x, cell.y); await s.draw()
  expect(prose.plainText).toBe(`Use ${command}, then Alpha #224 ◆✓.`)
  expect(s.strips()).toHaveLength(1)
  expect(s.strips()[0]!.plainText).toBe("alpha#224 ◆ ✓")
  expect(s.copyAll(prose)).toBe(`Use ${command}, then Alpha PR #224 (${canonical}).`)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

async function setupReferenceViewport() {
  const reference = "[Alpha PR#224][pr]"
  const content = `${reference}\n\n[pr]: ${originalUrl}`
  const s = await setup(content)
  const [prose, definition] = s.sources()
  if (prose === undefined || definition === undefined) throw new Error("Expected native reference and definition blocks")
  // In stock 0.4.5, visible=false leaves an unlaid-out definition at (0,0)
  // with a 1x1 layout; copyAll's full-row gesture selects that hidden buffer too.
  // A real chat ScrollBox keeps its AST/URL available but clips its glyphs below
  // the selected row, so neither literal-source hits nor aggregate copy see it.
  const scroll = new ScrollBoxRenderable(s.renderer, { id: "reference-chat-viewport", width: 80, height: 1 })
  scroll.add(s.parent)
  s.renderer.root.add(scroll)
  return { ...s, scroll, prose, definition, reference, content }
}

test("reference-style stock full-row and bounded selection exclude a viewport-clipped definition", async () => {
  const s = await setupReferenceViewport()
  const { prose, definition, scroll } = s
  await s.draw()
  expect(prose.plainText).toBe("Alpha PR#224")
  expect(definition.visible).toBeTrue()
  expect(definition.screenY).toBeGreaterThanOrEqual(scroll.screenY + scroll.height)
  expect(s.captureCharFrame()).not.toContain("[pr]:")
  expect(s.copyAll(prose)).toBe("Alpha PR#224")
  expect(prose.getSelectedText()).toBe("Alpha PR#224")
  expect(definition.getSelection()).toBeNull()
  s.renderer.clearSelection()
  s.renderer.startSelection(prose, prose.screenX + 2, prose.screenY)
  s.renderer.updateSelection(prose, prose.screenX + 5, prose.screenY, { finishDragging: true })
  expect(prose.getSelectedText()).toBe("pha")
  expect(s.renderer.getSelection()!.getSelectedText()).toBe("pha")
  expect(definition.getSelection()).toBeNull()
  s.healthy()
}, 15000)

test("reference-style PR prose compacts without a raw source URL, preserving exact activation and atomic copy", async () => {
  const s = await setupReferenceViewport()
  const { prose, definition, reference, content, scroll } = s
  expect(prose!.content).toBe(reference)
  expect(prose!.content).not.toContain("https://")
  expect(definition!.content).toBe(`[pr]: ${originalUrl}`)
  const opened: string[] = []
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "merged", "failed"))
  s.install(fetch, { commandPressed: () => true,
    openHttpUrl: async (url) => { opened.push(url); return { ok: true, value: undefined } } })
  await s.draw()
  expect(prose!.plainText).toBe("Alpha #224 ◆✕")
  expect(definition.screenY).toBeGreaterThanOrEqual(scroll.screenY + scroll.height)
  expect(s.captureCharFrame()).not.toContain("[pr]:")
  expect(s.strips()).toHaveLength(0)
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual([canonical])
  for (let col = 0; col < prose!.plainText.length; col++) {
    expect(linkAt(s, prose!.screenX + col, prose!.screenY)).toBe(originalUrl)
  }
  wireClick(s, prose!.screenX + 2, prose!.screenY); await settle()
  expect(opened).toEqual([originalUrl])
  expect(s.copyAll(prose!)).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(prose.getSelectedText()).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(definition.getSelection()).toBeNull()
  s.renderer.clearSelection()
  s.renderer.startSelection(prose!, prose!.screenX + 2, prose!.screenY)
  s.renderer.updateSelection(prose!, prose!.screenX + 5, prose!.screenY, { finishDragging: true })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(prose.getSelectedText()).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(definition.getSelection()).toBeNull()
  expect(prose!.content).toBe(reference)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test("reference-style PR status replies between native staging and publication refresh first sight and later hover", async () => {
  const s = await setupReferenceViewport()
  const { prose, definition, reference, content, scroll } = s
  expect(prose!.content).toBe(reference)
  expect(prose!.content).not.toContain("https://")
  expect(definition!.content).toBe(`[pr]: ${originalUrl}`)
  let lifecycle: GitHubPrStatus["lifecycle"] = "draft"
  let ci: GitHubPrStatus["ci"] = "failed"
  let pending: Readonly<{ target: GitHubPrTarget; resolve: (result: GitHubPrResult) => void }> | null = null
  const fetch = mock<GitHubPrClient["fetch"]>((target) => {
    if (pending !== null) throw new Error("Reference status fetch was not deduplicated")
    const deferred = Promise.withResolvers<GitHubPrResult>()
    pending = { target, resolve: deferred.resolve }
    return deferred.promise
  })
  const buffer: unknown = Reflect.get(prose!, "textBuffer")
  if (!(buffer instanceof rendererCore.TextBuffer)) throw new Error("Expected native reference prose TextBuffer")
  const nativeSetStyledText = buffer.setStyledText.bind(buffer)
  const staged: Readonly<{ text: string; highlighting: boolean }>[] = []
  spyOn(buffer, "setStyledText").mockImplementation((value) => {
    nativeSetStyledText(value)
    if (pending === null || !prose!.plainText.startsWith("Alpha #224 ")) return
    const reply = pending
    pending = null
    // The native buffer now holds the old status, but highlightingDone (and the
    // compact view's publication) is still pending. Cache completion runs first.
    staged.push({ text: prose!.plainText, highlighting: prose!.isHighlighting })
    reply.resolve(success(reply.target, lifecycle, ci))
  })
  s.install(fetch); await s.draw()
  expect(staged).toEqual([{ text: "Alpha #224 ?", highlighting: true }])
  expect(pending).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(prose!.plainText).toBe("Alpha #224 ◇✕")
  expect(definition.screenY).toBeGreaterThanOrEqual(scroll.screenY + scroll.height)
  expect(s.captureCharFrame()).not.toContain("[pr]:")
  expect(symbolColor(s, prose!, "◇")).toEqual(palette.textMuted)
  expect(symbolColor(s, prose!, "✕")).toEqual(palette.error)
  expect(s.strips()).toHaveLength(0)
  const chip = linkedCell(s, prose!, originalUrl)
  await s.mockMouse.moveTo(chip.x, chip.y); await s.draw()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.tooltip().plainText).toContain("Draft · CI failing")
  await s.mockMouse.moveTo(79, 39); await s.draw()
  s.clock.now += HOVER_REENTRY_THROTTLE_MS + 1
  lifecycle = "merged"; ci = "passed"
  await s.mockMouse.moveTo(chip.x, chip.y); await s.draw()
  expect(staged).toEqual([
    { text: "Alpha #224 ?", highlighting: true },
    { text: "Alpha #224 ◇✕", highlighting: true },
  ])
  expect(pending).toBeNull()
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual([canonical, canonical])
  expect(prose!.plainText).toBe("Alpha #224 ◆✓")
  expect(symbolColor(s, prose!, "◆")).toEqual(RGBA.fromHex("#a78bfa"))
  expect(symbolColor(s, prose!, "✓")).toEqual(palette.success)
  expect(s.tooltip().plainText).toContain("Merged · CI passing")
  expect(s.tooltip().plainText).toContain(`Last fetched: ${new Date(s.clock.now).toLocaleString()}`)
  expect(s.strips()).toHaveLength(0)
  expect(linkAt(s, chip.x, chip.y)).toBe(originalUrl)
  expect(s.copyAll(prose!)).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(prose.getSelectedText()).toBe(`Alpha PR#224 (${originalUrl})`)
  expect(definition.getSelection()).toBeNull()
  expect(prose!.content).toBe(reference)
  expect(s.md.content).toBe(content)
  s.healthy()
}, 15000)

test("reference-style streamed definitions update exact destinations on a reused source through an in-flight status refresh", async () => {
  const s = await setupReferenceViewport()
  const { prose, reference, scroll } = s
  const nextCanonical = "https://github.com/octo-org-sample/alpha/pull/225"
  const changed = `${canonical}/files?diff=unified&view=2#changed-界`
  const latest = `${canonical}/checks?view=3#latest-界`
  const nextPr = `${nextCanonical}/files?diff=split#next-界`
  const refreshStarted = Promise.withResolvers<GitHubPrTarget>()
  const refreshReply = Promise.withResolvers<GitHubPrResult>()
  let originalFetches = 0
  const fetch = mock<GitHubPrClient["fetch"]>((target) => {
    if (target.canonicalUrl === canonical) {
      originalFetches++
      if (originalFetches === 1) return Promise.resolve(success(target, "draft", "failed"))
      if (originalFetches === 2) { refreshStarted.resolve(target); return refreshReply.promise }
      throw new Error("Reference definition changes unexpectedly refetched the same PR")
    }
    if (target.canonicalUrl === nextCanonical) return Promise.resolve(success(target, "closed", "pending"))
    throw new Error(`Unexpected reference target: ${target.canonicalUrl}`)
  })
  const opened: string[] = []
  s.install(fetch, { commandPressed: () => true,
    openHttpUrl: async (url) => { opened.push(url); return { ok: true, value: undefined } } })
  await s.draw()
  const height = prose.height
  const assertDestination = async (url: string, label: string) => {
    expect(s.sources()[0]).toBe(prose)
    expect(prose.content).toBe(reference)
    expect(prose.content).not.toContain("https://")
    expect(prose.plainText).toBe(label)
    expect(prose.height).toBe(height)
    expect(scroll.height).toBe(1)
    expect(s.strips()).toHaveLength(0)
    expect(s.md.content).toBe(`${reference}\n\n[pr]: ${url}`)
    const definition = s.sources().find((source) => source.content === `[pr]: ${url}`)
    if (definition === undefined) throw new Error("Expected the updated native reference definition")
    expect(definition.screenY).toBeGreaterThanOrEqual(scroll.screenY + scroll.height)
    expect(s.captureCharFrame()).not.toContain("[pr]:")
    for (let col = 0; col < prose.plainText.length; col++) {
      expect(linkAt(s, prose.screenX + col, prose.screenY)).toBe(url)
    }
    const previousOpens = opened.length
    wireClick(s, prose.screenX + 2, prose.screenY); await settle()
    expect(opened.slice(previousOpens)).toEqual([url])
    expect(s.copyAll(prose)).toBe(`Alpha PR#224 (${url})`)
    expect(prose.getSelectedText()).toBe(`Alpha PR#224 (${url})`)
    expect(definition.getSelection()).toBeNull()
    s.renderer.clearSelection()
    s.renderer.startSelection(prose, prose.screenX + 2, prose.screenY)
    s.renderer.updateSelection(prose, prose.screenX + 5, prose.screenY, { finishDragging: true })
    expect(s.renderer.getSelection()!.getSelectedText()).toBe(`Alpha PR#224 (${url})`)
    expect(definition.getSelection()).toBeNull()
    s.renderer.clearSelection()
  }
  await assertDestination(originalUrl, "Alpha #224 ◇✕")
  s.md.content = `${reference}\n\n[pr]: ${changed}`
  await s.draw()
  await assertDestination(changed, "Alpha #224 ◇✕")
  expect(fetch).toHaveBeenCalledTimes(1)

  // Begin a hover fetch while the old definition is displayed, then change only
  // its resolved href before that same-canonical status response completes.
  const chip = linkedCell(s, prose, changed)
  s.clock.now += HOVER_REENTRY_THROTTLE_MS + 1
  await s.mockMouse.moveTo(chip.x, chip.y); await s.draw()
  expect(fetch).toHaveBeenCalledTimes(2)
  const refreshingTarget = await refreshStarted.promise
  s.md.content = `${reference}\n\n[pr]: ${latest}`
  await s.draw()
  await assertDestination(latest, "Alpha #224 ◇✕")
  expect(fetch).toHaveBeenCalledTimes(2)
  refreshReply.resolve(success(refreshingTarget, "merged", "passed"))
  await settle(); await s.draw()
  await assertDestination(latest, "Alpha #224 ◆✓")
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(symbolColor(s, prose, "◆")).toEqual(RGBA.fromHex("#a78bfa"))
  expect(symbolColor(s, prose, "✓")).toEqual(palette.success)

  // The original reference body/label remains unchanged even for a new PR.
  s.md.content = `${reference}\n\n[pr]: ${nextPr}`
  await s.draw()
  await assertDestination(nextPr, "Alpha #225 ⊘◷")
  expect(symbolColor(s, prose, "⊘")).toEqual(palette.error)
  expect(symbolColor(s, prose, "◷")).toEqual(palette.warning)
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual([canonical, canonical, nextCanonical])
  expect(opened).toEqual([originalUrl, changed, latest, latest, nextPr])
  s.healthy()
}, 15000)
