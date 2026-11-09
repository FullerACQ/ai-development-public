/** Run with the exact deps in a scratch directory (see final research report).
 * bun build opencode/tui/chat-links/renderer.ts --target=bun --packages=external --outfile=<scratch>/renderer.ts
 * bun build opencode/tui/chat-links/renderer.test.ts --target=bun --packages=external --outfile=<scratch>/renderer.test.js
 * bun test <scratch>/renderer.test.js
 * No config or core patches, no dependency installation in this repository.
 */
import { afterEach, expect, test } from "bun:test"
import { Readable, Writable } from "node:stream"
import { dirname, join } from "node:path"
import {
  BoxRenderable, CodeRenderable, MarkdownRenderable, RGBA, StyledText, SyntaxStyle,
  TextAttributes, TextBuffer, TextBufferView, TextNodeRenderable, TextRenderable, TreeSitterClient, createCliRenderer,
  type CliRenderer,
} from "@opentui/core"
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing"
import {
  attachBadgeStrip, createTooltipOverlay, installLinkRenderer, sourceBlock, textSources,
  nativeLinks,
  PR_STRIP_PREFIX,
   type Diagnostic, type LinkHit, type LinkRendererController, type InlineStatusRange,
} from "./renderer"
import { extractUrls } from "./urls"

const renderers: CliRenderer[] = []
const clients: TreeSitterClient[] = []
const styles: SyntaxStyle[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
  for (const client of clients.splice(0)) await client.destroy()
  for (const style of styles.splice(0)) style.destroy()
})

async function setup(width: number, height: number) {
  const setup = await createTestRenderer({ width, height, useMouse: true })
  renderers.push(setup.renderer)
  return setup
}
function install(renderer: CliRenderer, onHover: (hit: LinkHit | null) => void): LinkRendererController {
  return installLinkRenderer({ app: { version: "1.18.34" }, renderer }, {
    onHover, onDiagnostic: (diagnostic) => { throw new Error(JSON.stringify(diagnostic)) },
    onVisible: () => {},
  })
}
const links = nativeLinks()
if (links === null) throw new Error("Expected native OpenTUI 0.4.5 link API")
function at(renderer: CliRenderer, x: number, y: number): string | null {
  const id = links!.attributesGetLinkId(renderer.currentRenderBuffer.buffers.attributes[y * renderer.width + x])
  return id === 0 ? null : links!.linkGetUrl(id, 65536)
}
function syntax() {
  const style = SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#ff0000"), bold: true },
    string: { fg: RGBA.fromHex("#00ff00"), italic: true },
    "markup.strong": { fg: RGBA.fromHex("#0000ff"), bold: true },
    "markup.link": { fg: RGBA.fromHex("#00ffff"), underline: true },
    "markup.link.url": { fg: RGBA.fromHex("#00ffff"), underline: true },
  })
  styles.push(style)
  return style
}
function mockClient() {
  const client = new MockTreeSitterClient()
  clients.push(client)
  return client
}

test("stock-style host runtime exports win over a transitive duplicate Core import without weakening instanceof", async () => {
  // A fresh process is necessary: the defect is module-load order/class identity.
  const sourcePath = new URL("./renderer.ts", import.meta.url).href
  const script = `
    import * as hostCore from "@opentui/core";
    import {createTestRenderer} from "@opentui/core/testing";
    import {plugin} from "bun";
    const foreign = {...hostCore,
      Renderable: class LocalRenderable extends hostCore.Renderable {},
      TextRenderable: class LocalTextRenderable extends hostCore.TextRenderable {},
      CodeRenderable: class LocalCodeRenderable extends hostCore.CodeRenderable {},
      MarkdownRenderable: class LocalMarkdownRenderable extends hostCore.MarkdownRenderable {},
      BoxRenderable: class LocalBoxRenderable extends hostCore.BoxRenderable {},
      TextBuffer: class LocalTextBuffer extends hostCore.TextBuffer {},
      TextBufferView: class LocalTextBufferView extends hostCore.TextBufferView {}};
    plugin({name:"transitive-duplicate-core", setup(build) {
      build.module("fixture:duplicate-core", () => ({exports:foreign, loader:"object"}));
      build.onResolve({filter:/^@opentui\\/core$/}, () => ({path:"fixture:duplicate-core"}));
    }});
    globalThis[Symbol.for("opentui.solid.runtime-plugin-support")] = {core:hostCore};
    const subject = await import(Bun.argv.at(-1));
    const setup = await createTestRenderer({width:60,height:8});
    const diagnostics = [], visible = [];
    const source = new hostCore.TextRenderable(setup.renderer,{id:"host-text",content:"copy https://example.org"});
    setup.renderer.root.add(source);
    await setup.renderOnce();
    const textBefore = source.plainText;
    const colorsBefore = [...setup.renderer.currentRenderBuffer.buffers.fg];
    const controller = subject.installLinkRenderer({app:{version:"1.18.34"},renderer:setup.renderer}, {
      onHover() {}, onDiagnostic(d) {diagnostics.push(d)}, onVisible(hits) {visible.push(hits.map(h=>h.url))}
    });
    await setup.renderOnce();
    const tooltip = subject.createTooltipOverlay(setup.renderer);
    const packet = {foreignIdentity: setup.renderer.root instanceof foreign.Renderable,
      hostIdentity: setup.renderer.root instanceof hostCore.Renderable, diagnostics, visible,
      canonicalCore:subject.rendererCore.Renderable===hostCore.Renderable,
      hit:controller.linkAt(6,0)?.url, sourceFound:subject.textSources(setup.renderer.root).includes(source),
      hostTooltipConstructor:tooltip.node.constructor===hostCore.BoxRenderable,
      copyUnchanged:source.plainText===textBefore,
      colorsUnchanged:JSON.stringify([...setup.renderer.currentRenderBuffer.buffers.fg])===JSON.stringify(colorsBefore)};
    controller.dispose(); tooltip.dispose(); setup.renderer.destroy();
    process.stdout.write(JSON.stringify(packet));
  `
  const child = Bun.spawn([process.execPath, "--eval", script, sourcePath], {
    cwd: dirname(import.meta.path), stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  const result: unknown = JSON.parse(stdout)
  expect(result).toMatchObject({ foreignIdentity: false, hostIdentity: true, canonicalCore: true, diagnostics: [],
    visible: [["https://example.org"]], hit: "https://example.org", sourceFound: true,
    hostTooltipConstructor: true, copyUnchanged: true, colorsUnchanged: true })
}, 15000)

test("public frame callbacks precede drawing; post-process follows drawing; removal unregisters both", async () => {
  const s = await setup(40, 5)
  const text = new TextRenderable(s.renderer, { id: "ordering", content: "old" })
  s.renderer.root.add(text)
  const order: string[] = []
  const pre = async (): Promise<void> => { order.push("pre"); text.content = "https://example.org" }
  const post = (): void => { order.push("post"); expect(text.plainText).toBe("https://example.org") }
  s.renderer.setFrameCallback(pre)
  s.renderer.addPostProcessFn(post)
  await s.renderOnce()
  expect(order).toEqual(["pre", "post"])
  expect(s.captureCharFrame()).toContain("https://example.org")
  s.renderer.removeFrameCallback(pre)
  s.renderer.removePostProcessFn(post)
  await s.renderOnce()
  expect(order).toEqual(["pre", "post"])
})

test("actual post-process cells preserve styles, bytes, copy and update after content/resize/dispose", async () => {
  const s = await setup(64, 12)
  const text = new TextRenderable(s.renderer, { id: "plain", width: 64,
    content: new StyledText([
      { __isChunk: true, text: "before https://exa", fg: RGBA.fromHex("#ff0000"), attributes: TextAttributes.BOLD },
      { __isChunk: true, text: "mple.org tail", fg: RGBA.fromHex("#00ff00"), attributes: TextAttributes.ITALIC },
    ]) })
  s.renderer.root.add(text)
  await s.renderOnce()
  const original = text.plainText
  const frame = s.captureCharFrame()
  const fg = [...s.renderer.currentRenderBuffer.buffers.fg]
  const bg = [...s.renderer.currentRenderBuffer.buffers.bg]
  const attrs = [...s.renderer.currentRenderBuffer.buffers.attributes].map((n) => n & 0xff)
  await s.mockMouse.drag(0, 0, original.length, 0, 0, { delayMs: 0 })
  const copy = s.renderer.getSelection()!.getSelectedText()
  expect(copy).toBe(original)
  s.renderer.clearSelection()
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect(s.captureCharFrame()).toBe(frame)
  expect([...s.renderer.currentRenderBuffer.buffers.fg]).toEqual(fg)
  expect([...s.renderer.currentRenderBuffer.buffers.bg]).toEqual(bg)
  expect([...s.renderer.currentRenderBuffer.buffers.attributes].map((n) => n & 0xff)).toEqual(attrs)
  expect(at(s.renderer, 7, 0)).toBe("https://example.org")
  expect(at(s.renderer, 26, 0)).toBeNull()
  const linkId = s.renderer.currentRenderBuffer.buffers.attributes[7] >>> 8
  for (let x = 7; x < 26; x++) expect(s.renderer.currentRenderBuffer.buffers.attributes[x] >>> 8).toBe(linkId)
  await s.renderOnce()
  expect(s.renderer.currentRenderBuffer.buffers.attributes[7] >>> 8).toBe(linkId)
  await s.mockMouse.drag(0, 0, original.length, 0, 0, { delayMs: 0 })
  await s.renderOnce()
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(copy)
  expect(at(s.renderer, 7, 0)).toBe("https://example.org")
  s.renderer.clearSelection()
  text.content = "https://new.example.org"
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBe("https://new.example.org")
  s.resize(20, 12)
  text.width = 20
  await s.renderOnce()
  expect(at(s.renderer, 0, 1)).toBe("https://new.example.org")
  controller.dispose()
  controller.dispose()
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBeNull()
  expect(text.plainText).toBe("https://new.example.org")
})

test("native columns cover Unicode, tabs, multiline char/word wrap and partial scroll viewport", async () => {
  const s = await setup(20, 8)
  const text = new TextRenderable(s.renderer, { id: "unicode", width: 20, height: 2, wrapMode: "char",
    content: "界 🙂\thttps://example.com/abc\nnext https://example.org" })
  s.renderer.root.add(text)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect(at(s.renderer, 7, 0)).toBe("https://example.com/abc")
  expect(at(s.renderer, 0, 1)).toBe("https://example.com/abc")
  expect(at(s.renderer, 10, 1)).toBeNull()
  text.scrollY = 2
  await s.renderOnce()
  expect(at(s.renderer, 5, 0)).toBe("https://example.org")
  expect(at(s.renderer, 0, 1)).toBe("https://example.org")
  expect(controller.linkAt(0, 1)?.url).toBe("https://example.org")
  text.wrapMode = "word"
  text.scrollY = 0
  await s.renderOnce()
  const linkedCells = [...s.renderer.currentRenderBuffer.buffers.attributes].filter((n) => links.attributesGetLinkId(n) > 0)
  expect(linkedCells.length).toBeGreaterThan(0)
  text.wrapMode = "none"
  text.content = "prefix https://example.com/abc"
  text.height = 1
  text.scrollX = 10
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBe("https://example.com/abc")
  expect(at(s.renderer, 19, 0)).toBe("https://example.com/abc")
  expect(controller.linkAt(20, 0)).toBeNull()
})

test("Solid-style TextNodes remain reactive: content getter is not authoritative for child spans", async () => {
  const s = await setup(50, 5)
  const text = new TextRenderable(s.renderer, { id: "nodes" })
  const bold = new TextNodeRenderable({ attributes: TextAttributes.BOLD })
  bold.add("https://exa")
  const italic = new TextNodeRenderable({ attributes: TextAttributes.ITALIC })
  italic.add("mple.org")
  text.add(bold)
  text.add(italic)
  s.renderer.root.add(text)
  install(s.renderer, () => {})
  await s.renderOnce()
  expect(text.content.chunks.map((c) => c.text).join("")).toBe("")
  expect(text.plainText).toBe("https://example.org")
  expect(at(s.renderer, 12, 0)).toBe("https://example.org")
  italic.clear()
  italic.add("mple.net")
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBe("https://example.net")
  expect(s.renderer.currentRenderBuffer.buffers.attributes[0] & 0xff).toBe(TextAttributes.BOLD)
})

test("CodeRenderable native highlights, existing hooks and conceal source mapping survive", async () => {
  const s = await setup(70, 8)
  const client = mockClient()
  const content = 'const u = "https://example.org"'
  client.setMockResult({ highlights: [[0, 5, "keyword"], [10, content.length, "string"]] })
  const code = new CodeRenderable(s.renderer, { id: "code", content, filetype: "typescript",
    syntaxStyle: syntax(), treeSitterClient: client, conceal: false })
  s.renderer.root.add(code)
  await s.renderOnce()
  client.resolveAllHighlightOnce()
  await code.highlightingDone
  await s.renderOnce()
  const before = s.captureSpans()
  const sourceInfo = code.lineInfo
  const hook = code.onChunks
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect(s.captureSpans()).toEqual(before)
  expect(code.content).toBe(content)
  expect(code.plainText).toBe(content)
  expect(code.lineInfo).toEqual(sourceInfo)
  expect(code.onChunks).toBe(hook)
  expect(at(s.renderer, 11, 0)).toBe("https://example.org")
  controller.dispose()
})

test("Markdown traversal covers built-in labels, fenced code, renderNode and streaming reconciliation", async () => {
  const s = await setup(72, 18)
  const client = mockClient()
  // Deterministic grammar result; real Markdown/Code native chunk rendering runs.
  client.highlightOnce = async (content) => {
    const range = extractUrls(content)[0]
    return { highlights: content.startsWith("[label]") && range !== undefined
      ? [[1, 6, "markup.link.label"], [range.start, range.end, "markup.link.url"]] : [] }
  }
  const md = new MarkdownRenderable(s.renderer, { id: "md", syntaxStyle: syntax(), treeSitterClient: client,
    internalBlockMode: "top-level", content: "[label](https://example.org)\n\n```txt\nhttps://code.example.org\n```",
    renderNode: (token) => token.type === "heading"
      ? new TextRenderable(s.renderer, { id: "custom", content: "https://custom.example.org" }) : undefined })
  s.renderer.root.add(md)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  client.resolveAllHighlightOnce()
  for (const node of textSources(md)) if (node instanceof CodeRenderable) await node.highlightingDone
  await s.renderOnce()
  expect(at(s.renderer, 1, 0)).toBe("https://example.org")
  const code = textSources(md).find((node) => node instanceof CodeRenderable && node.content.includes("code.example"))!
  expect(controller.linkAt(code.screenX, code.screenY)?.url).toBe("https://code.example.org")
  expect(sourceBlock(code)).toBe(code)
  const snapshot = textSources(md).map((node) => node.plainText)
  md.content += "\n\n# new heading"
  await s.renderOnce()
  expect(textSources(md).some((node) => node.id === "custom")).toBeTrue()
  const custom = textSources(md).find((node) => node.id === "custom")!
  expect(controller.linkAt(custom.screenX, custom.screenY)?.url).toBe("https://custom.example.org")
  expect(textSources(md).slice(0, snapshot.length).map((node) => node.plainText)).toEqual(snapshot)
})

test("current-frame ownership excludes clipped and overlaid URLs even when characters match", async () => {
  const s = await setup(50, 8)
  const clip = new BoxRenderable(s.renderer, { id: "clip", width: 12, height: 2, overflow: "hidden" })
  const text = new TextRenderable(s.renderer, { id: "clipped", content: "https://example.org", width: 30,
    wrapMode: "none", flexShrink: 0 })
  clip.add(text)
  s.renderer.root.add(clip)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect(controller.linkAt(1, 0)?.url).toBe("https://example.org")
  expect(at(s.renderer, 13, 0)).toBeNull()
  const cover = new TextRenderable(s.renderer, { id: "cover", content: "https://", selectable: false,
    position: "absolute", left: 0, top: 0, width: 8, height: 1, zIndex: 100 })
  s.renderer.root.add(cover)
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBeNull()
  expect(controller.linkAt(0, 0)).toBeNull()
  expect(at(s.renderer, 8, 0)).toBe("https://example.org")
  cover.destroy()
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBe("https://example.org")
})

test("stock translucent app overlay preserves glyph ownership and recovers native label links without altering tinted colors/copy", async () => {
  const s = await setup(80, 12)
  const url = "https://github.com/octo-org-sample/alpha/pull/224"
  const source = new TextRenderable(s.renderer, { id: "stock-overlay-source", content: new StyledText([
    { __isChunk: true, text: "plain https://example.org\n" },
    { __isChunk: true, text: "Native label", link: { url }, attributes: TextAttributes.BOLD },
  ]) })
  s.renderer.root.add(source)
  const overlay = new BoxRenderable(s.renderer, { id: "stock-box-3", position: "absolute", left: 0, top: 0,
    width: "100%", height: "100%", zIndex: 100, border: false, shouldFill: true,
    backgroundColor: RGBA.fromInts(0, 0, 0, 150) })
  s.renderer.root.add(overlay)
  await s.renderOnce()
  const frame = s.captureCharFrame()
  const glyphs = [...s.renderer.currentRenderBuffer.buffers.char]
  const fg = [...s.renderer.currentRenderBuffer.buffers.fg]
  const bg = [...s.renderer.currentRenderBuffer.buffers.bg]
  const styles = [...s.renderer.currentRenderBuffer.buffers.attributes].map((n) => n & 0xff)
  const copy = source.plainText
  // Exact native 0.4.5 blend behavior: glyph survives but its link is cleared.
  expect(frame).toContain("Native label")
  expect(at(s.renderer, 0, 1)).toBeNull()
  const visible: (readonly LinkHit[])[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: (hits) => visible.push(hits), onDiagnostic: (d) => { throw new Error(d.detail) },
  })
  await s.renderOnce()
  expect(at(s.renderer, 6, 0)).toBe("https://example.org")
  expect(at(s.renderer, 0, 1)).toBe(url)
  expect(controller.linkAt(2, 1)!.source).toBe(source)
  expect(new Set(visible.at(-1)!.map((hit) => hit.url))).toEqual(new Set(["https://example.org", url]))
  expect(s.captureCharFrame()).toBe(frame)
  expect([...s.renderer.currentRenderBuffer.buffers.char]).toEqual(glyphs)
  expect([...s.renderer.currentRenderBuffer.buffers.fg]).toEqual(fg)
  expect([...s.renderer.currentRenderBuffer.buffers.bg]).toEqual(bg)
  expect([...s.renderer.currentRenderBuffer.buffers.attributes].map((n) => n & 0xff)).toEqual(styles)
  expect(source.plainText).toBe(copy)
  overlay.backgroundColor = "#000000"
  await s.renderOnce()
  expect(controller.linkAt(6, 0)).toBeNull()
  expect(visible.at(-1)).toEqual([])
})

test("onVisible separates verified PR-strip cells and excludes both arrays under an opaque overlay", async () => {
  const s = await setup(80, 12)
  const sourceUrl = "https://example.org/source"
  const stripUrl = "https://github.com/octo-org-sample/alpha/pull/224"
  const source = new TextRenderable(s.renderer, { id: "poll-source", content: sourceUrl })
  const strip = new TextRenderable(s.renderer, { id: `${PR_STRIP_PREFIX}-${source.num}`, selectable: false,
    content: new StyledText([{ __isChunk: true, text: "alpha#224 OPEN", link: { url: stripUrl } }]) })
  s.renderer.root.add(source)
  s.renderer.root.add(strip)
  const frames: { sources: readonly LinkHit[]; strips: readonly LinkHit[] }[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    onVisible: (sources, strips) => frames.push({ sources, strips }),
  })
  await s.renderOnce()
  expect(frames.at(-1)!.sources.map((hit) => hit.url)).toEqual([sourceUrl])
  expect(frames.at(-1)!.strips.map((hit) => hit.url)).toEqual([stripUrl])
  expect(frames.at(-1)!.strips[0].source).toBe(strip)
  const cover = new BoxRenderable(s.renderer, { id: "poll-cover", position: "absolute", left: 0, top: 0,
    width: "100%", height: "100%", zIndex: 100, backgroundColor: "#202020" })
  s.renderer.root.add(cover)
  await s.renderOnce()
  expect(frames.at(-1)).toEqual({ sources: [], strips: [] })
  expect(controller.linkAt(0, source.screenY)).toBeNull()
  expect(controller.linkAt(0, strip.screenY)).toBeNull()
  cover.backgroundColor = RGBA.fromInts(32, 32, 32, 150)
  await s.renderOnce()
  expect(frames.at(-1)!.sources.map((hit) => hit.url)).toEqual([sourceUrl])
  expect(frames.at(-1)!.strips.map((hit) => hit.url)).toEqual([stripUrl])
  expect(controller.linkAt(2, strip.screenY)!.source).toBe(strip)
  const tooltip = createTooltipOverlay(s.renderer)
  tooltip.show(controller.linkAt(2, source.screenY)!, "https://tooltip.example.org")
  await s.renderOnce()
  expect(frames.at(-1)!.sources.every((hit) => hit.source === source)).toBeTrue()
  expect(frames.at(-1)!.strips.every((hit) => hit.source === strip)).toBeTrue()
  tooltip.dispose()
})

test("partial pixel clipping reports only genuinely visible strips, including a strip whose source scrolled out", async () => {
  const s = await setup(60, 10)
  const clip = new BoxRenderable(s.renderer, { id: "poll-clip", width: 12, height: 1, overflow: "hidden" })
  const source = new TextRenderable(s.renderer, { id: "clip-source", width: 40, height: 1, flexShrink: 0,
    wrapMode: "none", content: "https://example.org/source" })
  const strip = new TextRenderable(s.renderer, { id: `${PR_STRIP_PREFIX}-${source.num}`, width: 40, height: 1,
    flexShrink: 0, selectable: false, wrapMode: "none", content: new StyledText([
      { __isChunk: true, text: "alpha#224 OPEN LONG LABEL", link: { url: "https://github.com/octo-org-sample/alpha/pull/224" } },
    ]) })
  clip.add(source)
  clip.add(strip)
  s.renderer.root.add(clip)
  const frames: { sources: readonly LinkHit[]; strips: readonly LinkHit[] }[] = []
  installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    onVisible: (sources, strips) => frames.push({ sources, strips }),
  })
  await s.renderOnce()
  expect(frames.at(-1)!.sources).toHaveLength(1)
  expect(frames.at(-1)!.strips).toEqual([])
  clip.height = 2
  await s.renderOnce()
  expect(frames.at(-1)!.strips).toHaveLength(1)
  const hit = frames.at(-1)!.strips[0]
  expect(hit.bounds.width).toBe(12)
  expect(hit.bounds.x + hit.bounds.width).toBeLessThanOrEqual(clip.screenX + clip.width)
  clip.translateY = -1
  await s.renderOnce()
  expect(frames.at(-1)!.sources).toEqual([])
  expect(frames.at(-1)!.strips).toHaveLength(1)
  expect(frames.at(-1)!.strips[0].y).toBe(0)
  clip.translateY = -2
  await s.renderOnce()
  expect(frames.at(-1)).toEqual({ sources: [], strips: [] })
})

test("raw SGR gives per-link hover within one text block, fragmented input and stationary-pointer refresh", async () => {
  const s = await setup(60, 8)
  const text = new TextRenderable(s.renderer, { id: "hover", content: "https://one.org https://two.org" })
  text.onMouseMove = (event) => event.stopPropagation()
  s.renderer.root.add(text)
  const hits: (LinkHit | null)[] = []
  const controller = install(s.renderer, (hit) => hits.push(hit))
  let inputHandlers = 0
  s.renderer.addInputHandler(() => { inputHandlers++; return false })
  await s.renderOnce()
  await s.mockMouse.moveTo(1, 0)
  expect(hits.at(-1)?.url).toBe("https://one.org")
  await s.mockMouse.moveTo(18, 0)
  expect(hits.at(-1)?.url).toBe("https://two.org")
  expect(inputHandlers).toBe(0)
  await s.mockMouse.moveTo(15, 0)
  expect(hits.at(-1)).toBeNull()
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<35;2;"))
  s.renderer.stdin.emit("data", Buffer.from("1M"))
  expect(hits.at(-1)?.url).toBe("https://one.org")
  text.content = "https://new.org"
  await s.renderOnce()
  expect(hits.at(-1)?.url).toBe("https://new.org")
  expect(controller.linkAt(-1, 0)).toBeNull()
  expect(controller.linkAt(0.5, 0)).toBeNull()
  text.destroy()
  await s.renderOnce()
  expect(hits.at(-1)).toBeNull()
})

test("Command left click is consumed at parsed dispatch before native selection and parent mouse-up", async () => {
  const s = await setup(80, 12)
  const parent = new BoxRenderable(s.renderer, { id: "message-actions-parent", width: 80 })
  let parentUps = 0
  parent.onMouseUp = () => { parentUps++ }
  const source = new TextRenderable(s.renderer, { id: "click-source", content: "https://example.org/one https://example.org/two" })
  parent.add(source)
  s.renderer.root.add(parent)
  let command = true
  const activated: LinkHit[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    commandPressed: () => command, onActivate: (hit) => activated.push(hit),
  })
  await s.renderOnce()
  // Actual parser receives Cmd-lost SGR cb=0 for both events, not a direct hook call.
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<0;3;1M\x1b[<0;3;1m"))
  expect(activated).toHaveLength(1)
  expect(activated[0].url).toBe("https://example.org/one")
  expect([activated[0].x, activated[0].y]).toEqual([2, 0])
  expect(parentUps).toBe(0)
  expect(s.renderer.getSelection()).toBeNull()
  command = false
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<0;3;1M\x1b[<0;3;1m"))
  expect(parentUps).toBe(1)
  expect(activated).toHaveLength(1)
  s.renderer.clearSelection()
  await s.mockMouse.drag(0, 0, 12, 0, 0, { delayMs: 0 })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(source.plainText.slice(0, 12))
  expect(parentUps).toBe(2)
  expect(activated).toHaveLength(1)
  controller.dispose()
})

test("Command activation requires both edges, same occurrence and <=1-cell release jitter; drag/wheel/other buttons cancel", async () => {
  const s = await setup(80, 12)
  const parent = new BoxRenderable(s.renderer, { id: "activation-cancel-parent", width: 80 })
  const source = new TextRenderable(s.renderer, { id: "activation-cancel-source", content: "https://example.org/one https://example.org/two" })
  parent.add(source)
  s.renderer.root.add(parent)
  let command = false
  const activated: LinkHit[] = []
  installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    commandPressed: () => command, onActivate: (hit) => activated.push(hit),
  })
  await s.renderOnce()
  const wire = (value: string): void => { s.renderer.stdin.emit("data", Buffer.from(value)) }
  wire("\x1b[<0;3;1M") // Not Command at press.
  command = true
  wire("\x1b[<0;3;1m")
  expect(activated).toHaveLength(0)
  s.renderer.clearSelection()
  wire("\x1b[<0;3;1M")
  command = false // Not Command at release.
  wire("\x1b[<0;3;1m")
  expect(activated).toHaveLength(0)
  command = true
  wire("\x1b[<0;3;1M\x1b[<0;4;1m") // Release-only one-cell jitter is accepted.
  expect(activated).toHaveLength(1)
  expect(activated[0].x).toBe(3)
  wire("\x1b[<0;3;1M\x1b[<0;7;1m") // Large motion even within the same URL.
  wire("\x1b[<0;3;1M\x1b[<0;28;1m") // Different URL/occurrence.
  wire("\x1b[<0;3;1M\x1b[<32;4;1M\x1b[<0;4;1m") // Parsed drag, even tiny.
  wire("\x1b[<0;3;1M\x1b[<64;3;1M\x1b[<0;3;1m") // Wheel during the gesture.
  wire("\x1b[<1;3;1M\x1b[<1;3;1m") // Middle.
  wire("\x1b[<2;3;1M\x1b[<2;3;1m") // Right.
  wire("\x1b[<0;3;1M\x1b[<1;3;1M\x1b[<1;3;1m\x1b[<0;3;1m")
  expect(activated).toHaveLength(1)
  wire("\x1b[<0;3;1M")
  source.content = "https://replacement.example.org"
  await s.renderOnce()
  wire("\x1b[<0;3;1m")
  expect(activated).toHaveLength(1)
  wire("\x1b[<0;3;1M")
  s.renderer.emit("blur")
  wire("\x1b[<0;3;1m")
  expect(activated).toHaveLength(1)
})

test("fragmented Command SGR is parsed once, works behind a translucent mouse target, and suppresses parent actions", async () => {
  const s = await setup(80, 12)
  const source = new TextRenderable(s.renderer, { id: "behind-mouse-target", content: "https://example.org" })
  s.renderer.root.add(source)
  const cover = new BoxRenderable(s.renderer, { id: "translucent-mouse-target", position: "absolute", left: 0, top: 0,
    width: 80, height: 12, backgroundColor: RGBA.fromInts(0, 0, 0, 150), zIndex: 100 })
  let coverUps = 0
  cover.onMouseUp = () => { coverUps++ }
  s.renderer.root.add(cover)
  let command = true
  const activated: LinkHit[] = []
  const hover: (LinkHit | null)[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: (hit) => hover.push(hit), onVisible: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    commandPressed: () => command, onActivate: (hit) => activated.push(hit),
  })
  await s.renderOnce()
  expect(s.renderer.hitTest(2, 0)).toBe(cover.num)
  expect(controller.linkAt(2, 0)!.source).toBe(source)
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<35;3;"))
  s.renderer.stdin.emit("data", Buffer.from("1M"))
  expect(hover).toHaveLength(1)
  expect(hover[0]!.x).toBe(2)
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<0;3;"))
  expect(activated).toHaveLength(0)
  s.renderer.stdin.emit("data", Buffer.from("1M\x1b[<0;3;"))
  s.renderer.stdin.emit("data", Buffer.from("1m"))
  expect(activated).toHaveLength(1)
  expect(coverUps).toBe(0)
  command = false
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<0;3;1M\x1b[<0;3;1m"))
  expect(coverUps).toBe(1)
})

test("mouse dispatch wrapper cleanup restores only its own method, is idempotent and becomes inert under later wrappers", async () => {
  const s = await setup(60, 8)
  const source = new TextRenderable(s.renderer, { id: "restore-click-source", content: "https://example.org" })
  s.renderer.root.add(source)
  const key = "processSingleMouseEvent"
  const original: unknown = Reflect.get(s.renderer, key)
  const before = Object.getOwnPropertyDescriptor(s.renderer, key)
  const options = { onHover: () => {}, onVisible: () => {}, onDiagnostic: (d: Diagnostic) => { throw new Error(d.detail) },
    commandPressed: () => true, onActivate: (_hit: LinkHit) => {} }
  const first = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, options)
  expect(Reflect.get(s.renderer, key)).not.toBe(original)
  first.dispose()
  first.dispose()
  expect(Reflect.get(s.renderer, key)).toBe(original)
  expect(Object.getOwnPropertyDescriptor(s.renderer, key)).toEqual(before)
  let activations = 0
  const second = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    ...options, onActivate: () => { activations++ },
  })
  const installed: unknown = Reflect.get(s.renderer, key)
  if (typeof installed !== "function") throw new Error("Expected wrapped dispatch")
  const laterWrapper = (event: unknown): unknown => Reflect.apply(installed, s.renderer, [event])
  Reflect.set(s.renderer, key, laterWrapper)
  second.dispose()
  expect(Reflect.get(s.renderer, key)).toBe(laterWrapper)
  await s.renderOnce()
  s.renderer.stdin.emit("data", Buffer.from("\x1b[<0;3;1M\x1b[<0;3;1m"))
  expect(activations).toBe(0)
  Reflect.deleteProperty(s.renderer, key)
})

test("unavailable click dispatch reports a diagnostic and leaves ordinary input unmodified", async () => {
  const s = await setup(60, 8)
  const key = "processSingleMouseEvent"
  const original: unknown = Reflect.get(s.renderer, key)
  Reflect.set(s.renderer, key, undefined)
  const diagnostics: Diagnostic[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => diagnostics.push(d),
    commandPressed: () => true, onActivate: () => { throw new Error("must not activate") },
  })
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0].detail).toContain("processSingleMouseEvent")
  expect(Reflect.get(s.renderer, key)).toBeUndefined()
  controller.dispose()
  Reflect.set(s.renderer, key, original)
})

test("repeated labels sharing one interned URL still have separate hover occurrences", async () => {
  const s = await setup(50, 5)
  const url = "https://example.org"
  const source = new TextRenderable(s.renderer, { id: "repeat", content: new StyledText([
    { __isChunk: true, text: "first", link: { url } },
    { __isChunk: true, text: " " },
    { __isChunk: true, text: "second", link: { url } },
  ]) })
  s.renderer.root.add(source)
  const hits: (LinkHit | null)[] = []
  install(s.renderer, (hit) => hits.push(hit))
  await s.renderOnce()
  await s.mockMouse.moveTo(0, 0)
  const first = hits.at(-1)!
  await s.mockMouse.moveTo(6, 0)
  const second = hits.at(-1)!
  expect(first.linkId).toBe(second.linkId)
  expect(first.occurrence).not.toBe(second.occurrence)
  expect(first.url).toBe(url)
  expect(second.url).toBe(url)
})

test("copy-safe PR strip and tooltip are separate nonselectable renderables", async () => {
  const s = await setup(64, 10)
  const url = "https://github.com/octo-org-sample/alpha/pull/123"
  const source = new TextRenderable(s.renderer, { id: "message", content: url })
  s.renderer.root.add(source)
  const strip = attachBadgeStrip(s.renderer, source, [{ url, label: "[PR #123 · OPEN]" }],
    (d) => { throw new Error(d.detail) })!
  const overlay = createTooltipOverlay(s.renderer)
  const controller = install(s.renderer, (hit) => overlay.show(hit, "PR #123 — example title\nOPEN · checks pending"))
  await s.renderOnce()
  expect(strip.screenY).toBe(source.screenY + source.height)
  expect(at(s.renderer, 1, strip.screenY)).toBe(url)
  expect(strip.selectable).toBeFalse()
  await s.mockMouse.moveTo(2, 0)
  await s.renderOnce()
  expect(overlay.node.visible).toBeTrue()
  expect(overlay.node.selectable).toBeFalse()
  expect(s.captureCharFrame()).toContain("PR #123 — example title")
  overlay.show(null, "")
  await s.mockMouse.drag(0, 0, strip.width - 1, strip.screenY, 0, { delayMs: 0 })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(url)
  expect(source.plainText).toBe(url)
  expect(controller.linkAt(2, 0)?.source).toBe(source)
  controller.dispose()
  strip.destroy()
  overlay.dispose()
})

test("onVisible fires once per rendered frame, deduplicates wrapped occurrences and excludes owned renderables", async () => {
  const s = await setup(32, 10)
  const url = "https://example.org/long-path/12345"
  const source = new TextRenderable(s.renderer, { id: "visible", width: 32, content: `${url}\n${url}`, wrapMode: "char" })
  s.renderer.root.add(source)
  const strip = attachBadgeStrip(s.renderer, source, [{ url, label: "[PR #1]" }], (d) => { throw new Error(d.detail) })!
  const tooltip = createTooltipOverlay(s.renderer)
  const visible: (readonly LinkHit[])[] = []
  let frames = 0
  s.renderer.on("frame", () => frames++)
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) }, onVisible: (hits) => visible.push(hits),
  })
  await s.renderOnce()
  expect(visible).toHaveLength(frames)
  expect(visible.at(-1)).toHaveLength(2)
  expect(new Set(visible.at(-1)!.map((hit) => hit.occurrence)).size).toBe(2)
  expect(visible.at(-1)!.every((hit) => hit.source === source && hit.url === url)).toBeTrue()
  expect(controller.linkAt(1, strip.screenY)!.source).toBe(strip)
  const hit = controller.linkAt(1, 0)!
  tooltip.show(hit, "https://tooltip.example.org")
  await s.renderOnce()
  expect(visible).toHaveLength(frames)
  expect(textSources(s.renderer.root)).not.toContain(tooltip.text)
  expect(textSources(s.renderer.root)).not.toContain(strip)
  expect(tooltip.text.plainText).toBe("https://tooltip.example.org")
  expect(at(s.renderer, tooltip.text.screenX, tooltip.text.screenY)).toBeNull()
  controller.dispose()
  const calls = visible.length
  await s.renderOnce()
  expect(visible).toHaveLength(calls)
  tooltip.dispose()
})

test("parent-colored PR strips hover each independent label with pointer coordinates but never appear in onVisible", async () => {
  const s = await setup(80, 12)
  const originalUrl = "https://github.com/octo-org-sample/alpha/pull/1"
  const secondUrl = "https://github.com/octo-org-sample/alpha/pull/2"
  const source = new TextRenderable(s.renderer, { id: "badge-source", content: originalUrl })
  s.renderer.root.add(source)
  const strip = new TextRenderable(s.renderer, { id: `${PR_STRIP_PREFIX}-${sourceBlock(source).num}`,
    selectable: false, content: new StyledText([
      { __isChunk: true, text: "PR #1 OPEN", fg: RGBA.fromHex("#00ff00"), link: { url: originalUrl } },
      { __isChunk: true, text: "  " },
      { __isChunk: true, text: "PR #2 FAILED", fg: RGBA.fromHex("#ff0000"), link: { url: secondUrl } },
    ]) })
  s.renderer.root.add(strip)
  const hover: (LinkHit | null)[] = []
  const visible: (readonly LinkHit[])[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: (hit) => hover.push(hit), onVisible: (hits) => visible.push(hits),
    onDiagnostic: (d) => { throw new Error(d.detail) },
  })
  await s.renderOnce()
  const fg = [...s.renderer.currentRenderBuffer.buffers.fg]
  const original = source.plainText
  await s.mockMouse.moveTo(2, strip.screenY)
  const first = hover.at(-1)!
  expect(first.url).toBe(originalUrl)
  expect(first.source).toBe(strip)
  expect([first.x, first.y]).toEqual([2, strip.screenY])
  await s.mockMouse.moveTo(5, strip.screenY)
  const moved = hover.at(-1)!
  expect(moved.occurrence).toBe(first.occurrence)
  expect([moved.x, moved.y]).toEqual([5, strip.screenY])
  expect(hover).toHaveLength(2)
  await s.mockMouse.moveTo(10, strip.screenY)
  expect(hover.at(-1)).toBeNull()
  await s.mockMouse.moveTo(15, strip.screenY)
  const second = hover.at(-1)!
  expect(second.url).toBe(secondUrl)
  expect(second.occurrence).not.toBe(first.occurrence)
  expect([second.x, second.y]).toEqual([15, strip.screenY])
  expect(controller.linkAt(15, strip.screenY)).toEqual(second)
  expect(visible.at(-1)!.map((hit) => hit.url)).toEqual([originalUrl])
  expect(textSources(s.renderer.root)).not.toContain(strip)
  expect(strip.selectable).toBeFalse()
  await s.renderOnce()
  expect(hover.at(-1)!.occurrence).toBe(second.occurrence)
  expect([...s.renderer.currentRenderBuffer.buffers.fg]).toEqual(fg)
  expect(source.plainText).toBe(original)
  await s.mockMouse.drag(0, source.screenY, strip.width - 1, strip.screenY, 0, { delayMs: 0 })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(original)
  expect(visible.every((hits) => hits.every((hit) => hit.source === source))).toBeTrue()
})

test("native tooltip links remain wholly excluded even when a child does not use the owned id prefix", async () => {
  const s = await setup(50, 8)
  const tooltip = new BoxRenderable(s.renderer, { id: "acq-chat-links-custom-tooltip", width: 50 })
  const child = new TextRenderable(s.renderer, { id: "custom-tooltip-content", selectable: false,
    content: new StyledText([{ __isChunk: true, text: "tooltip link", link: { url: "https://example.org" } }]) })
  tooltip.add(child)
  s.renderer.root.add(tooltip)
  const hover: (LinkHit | null)[] = []
  const visible: (readonly LinkHit[])[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: (hit) => hover.push(hit), onVisible: (hits) => visible.push(hits),
    onDiagnostic: (d) => { throw new Error(d.detail) },
  })
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBe("https://example.org")
  expect(controller.linkAt(0, 0)).toBeNull()
  await s.mockMouse.moveTo(2, 0)
  expect(hover).toHaveLength(0)
  expect(visible.at(-1)).toEqual([])
})

test("truncated and first-line-offset native labels support hover without literal URL mapping", async () => {
  const s = await setup(60, 10)
  const url = "https://github.com/octo-org-sample/alpha/pull/7"
  const truncated = new TextRenderable(s.renderer, { id: "sidebar-truncated", width: 16, height: 1, truncate: true,
    wrapMode: "none", content: new StyledText([{ __isChunk: true, text: "independently linked long sidebar label", link: { url } }]) })
  const offset = new TextRenderable(s.renderer, { id: "offset-native", width: 30, height: 1,
    content: new StyledText([{ __isChunk: true, text: "offset link", link: { url } }]) })
  // Configure the real native first-line-offset layout in the pinned runtime.
  const view: unknown = Reflect.get(offset, "textBufferView")
  if (!(view instanceof TextBufferView)) throw new Error("Expected native view")
  Reflect.set(offset, "_firstLineOffset", 3)
  view.setFirstLineOffset(3)
  s.renderer.root.add(truncated)
  s.renderer.root.add(offset)
  const diagnostics: Diagnostic[] = []
  const hover: (LinkHit | null)[] = []
  const visible: (readonly LinkHit[])[] = []
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: (hit) => hover.push(hit), onVisible: (hits) => visible.push(hits), onDiagnostic: (d) => diagnostics.push(d),
  })
  await s.renderOnce()
  for (const source of [truncated, offset]) {
    const hit = visible.at(-1)!.find((hit) => hit.source === source)!
    expect(hit).toBeDefined()
    expect(hit.url).toBe(url)
    expect(controller.linkAt(hit.x, hit.y)!.source).toBe(source)
    await s.mockMouse.moveTo(hit.x, hit.y)
    expect(hover.at(-1)!.source).toBe(source)
  }
  expect(diagnostics).toHaveLength(0)
  expect(truncated.plainText).toBe("independently linked long sidebar label")
  expect(offset.plainText).toBe("offset link")
})

test("shared extractor links HTTP only while native linked labels retain other protocols", async () => {
  const s = await setup(80, 8)
  const source = new TextRenderable(s.renderer, { id: "http-only", content: new StyledText([
    { __isChunk: true, text: "ftp://example.org mailto:a@b.org\n(https://e.org/a(b)), " },
    { __isChunk: true, text: "native label", link: { url: "mailto:someone@example.org" } },
  ]) })
  s.renderer.root.add(source)
  install(s.renderer, () => {})
  await s.renderOnce()
  expect(at(s.renderer, 0, 0)).toBeNull()
  expect(at(s.renderer, 18, 0)).toBeNull()
  expect(at(s.renderer, 1, 1)).toBe("https://e.org/a(b)")
  const label = source.plainText.split("\n")[1].indexOf("native label")
  expect(at(s.renderer, label, 1)).toBe("mailto:someone@example.org")
})

test("root strip insertion preserves active selection and updates idempotently", async () => {
  const s = await setup(80, 10)
  const url = "https://github.com/octo-org-sample/alpha/pull/1"
  const source = new TextRenderable(s.renderer, { id: "selected", content: `original ${url}` })
  const next = new TextRenderable(s.renderer, { id: "next", content: "next original" })
  s.renderer.root.add(source)
  s.renderer.root.add(next)
  await s.renderOnce()
  await s.mockMouse.drag(0, 0, next.plainText.length, next.screenY, 0, { delayMs: 0 })
  const copy = s.renderer.getSelection()!.getSelectedText()
  const diagnostics: Diagnostic[] = []
  const strip = attachBadgeStrip(s.renderer, sourceBlock(source), [{ url, label: "OPEN" }], (d) => diagnostics.push(d))!
  await s.renderOnce()
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(copy)
  expect(strip.screenY).toBe(source.screenY + source.height)
  expect(attachBadgeStrip(s.renderer, source, [{ url, label: "OPEN" }], (d) => diagnostics.push(d))).toBe(strip)
  expect(attachBadgeStrip(s.renderer, source, [{ url, label: "MERGED" }], (d) => diagnostics.push(d))).toBe(strip)
  await s.renderOnce()
  expect(strip.plainText).toBe("MERGED")
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(copy)
  expect(diagnostics).toHaveLength(0)
  source.destroy()
  expect(strip.isDestroyed).toBeTrue()
})

test("actual Markdown column parents preserve active native selection under PR strip insertion", async () => {
  const s = await setup(80, 14)
  const client = new TreeSitterClient({ dataPath: join(dirname(import.meta.path), "parser-cache") })
  clients.push(client)
  await client.initialize()
  const parent = new BoxRenderable(s.renderer, { id: "stock-text-part", paddingLeft: 3, flexShrink: 0 })
  const md = new MarkdownRenderable(s.renderer, { id: "selected-md", syntaxStyle: syntax(), treeSitterClient: client,
    internalBlockMode: "top-level", conceal: true, content: "**Original** [PR](https://github.com/octo-org-sample/alpha/pull/1)\n\nsecond paragraph" })
  parent.add(md)
  s.renderer.root.add(parent)
  await s.renderOnce()
  for (const source of textSources(md)) if (source instanceof CodeRenderable) await source.highlightingDone
  await s.renderOnce()
  const sources = textSources(md)
  const first = sources[0]
  const last = sources.at(-1)!
  await s.mockMouse.drag(first.screenX, first.screenY, last.screenX + last.width,
    last.screenY + last.height - 1, 0, { delayMs: 0 })
  const copy = s.renderer.getSelection()!.getSelectedText()
  expect(copy).toContain("Original")
  expect(copy).toContain("second paragraph")
  const strip = attachBadgeStrip(s.renderer, sourceBlock(first), [{ url: "https://github.com/octo-org-sample/alpha/pull/1",
    label: "OPEN · CI failed" }], (d) => { throw new Error(d.detail) })!
  await s.renderOnce()
  expect(strip.parent).toBe(first.parent)
  expect(first.parent!.getChildren()).toEqual([first, strip])
  expect(parent.getChildren()).toEqual([md])
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(copy)
  expect(copy).not.toContain("CI failed")
  expect(textSources(md)).toEqual(sources)
}, 15000)

test("sourceBlock climbs stock-style rows; badge helper diagnoses direct row insertion", async () => {
  const s = await setup(80, 8)
  const column = new BoxRenderable(s.renderer, { id: "column", flexDirection: "column" })
  const row = new BoxRenderable(s.renderer, { id: "tool-label-row", flexDirection: "row" })
  const source = new TextRenderable(s.renderer, { id: "tool-label", content: "https://example.org" })
  row.add(source)
  column.add(row)
  s.renderer.root.add(column)
  expect(sourceBlock(source)).toBe(row)
  const diagnostics: Diagnostic[] = []
  expect(attachBadgeStrip(s.renderer, source, [{ url: "https://example.org", label: "PR" }], (d) => diagnostics.push(d))).toBeNull()
  expect(diagnostics[0].code).toBe("unsupported-layout")
  expect(row.getChildren()).toEqual([source])
  const strip = attachBadgeStrip(s.renderer, sourceBlock(source), [{ url: "https://example.org", label: "PR" }],
    (d) => diagnostics.push(d))!
  expect(column.getChildren()).toEqual([row, strip])
  expect(row.getChildren()).toEqual([source])
})

test("scroll wheel refreshes hover and visible links at a stationary pointer after native render", async () => {
  const s = await setup(50, 8)
  const source = new TextRenderable(s.renderer, { id: "scroll-hover", width: 50, height: 1,
    content: ["one", "two", "three", "four", "five"].map((name) => `https://${name}.org`).join("\n") })
  s.renderer.root.add(source)
  const hover: (LinkHit | null)[] = []
  const visible: (readonly LinkHit[])[] = []
  installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: (hit) => hover.push(hit), onVisible: (hits) => visible.push(hits),
    onDiagnostic: (d) => { throw new Error(d.detail) },
  })
  await s.renderOnce()
  await s.mockMouse.moveTo(2, 0)
  expect(hover.at(-1)!.url).toBe("https://one.org")
  await s.mockMouse.scroll(2, 0, "down")
  await s.renderOnce()
  expect(source.scrollY).toBeGreaterThan(0)
  expect(hover.at(-1)!.url).not.toBe("https://one.org")
  expect(hover.at(-1)!.url).toBe(visible.at(-1)![0].url)
})

test("tooltip fits eight metadata rows including CI failure reason and last fetch, with theme and no link overlap", async () => {
  const s = await setup(90, 24)
  const source = new TextRenderable(s.renderer, { id: "tooltip-source", content: "https://example.org" })
  s.renderer.root.add(source)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  const hit = controller.linkAt(1, 0)!
  const tooltip = createTooltipOverlay(s.renderer)
  const description = ["Improve migrations", "Lifecycle: OPEN", "CI: FAILED", "Failing checks: unit-tests",
    "Reason: migration requires tenant id", "Author: builder", "Updated: today", "Last fetched: just now"].join("\n")
  const layout = tooltip.show(hit, description, { foreground: "#ffeeee", background: "#102030", border: "#f00000" })
  await s.renderOnce()
  expect(layout).toEqual({ clipped: false, totalRows: 8, visibleRows: 8 })
  expect(tooltip.text.plainText).toBe(description)
  expect(s.captureCharFrame()).toContain("Reason: migration requires tenant id")
  expect(s.captureCharFrame()).toContain("Last fetched: just now")
  expect(tooltip.node.screenY).toBeGreaterThan(hit.y)
  expect(tooltip.node.screenX + tooltip.node.width).toBeLessThanOrEqual(s.renderer.width)
  expect(tooltip.node.screenY + tooltip.node.height).toBeLessThanOrEqual(s.renderer.height)
  expect(tooltip.text.fg).toEqual(RGBA.fromHex("#ffeeee"))
  expect(tooltip.node.backgroundColor).toEqual(RGBA.fromHex("#102030"))
  expect(tooltip.node.borderColor).toEqual(RGBA.fromHex("#f00000"))
  expect(tooltip.node.selectable).toBeFalse()
  expect(s.renderer.currentFocusedRenderable).toBeNull()
  expect(at(s.renderer, hit.x, hit.y)).toBe(hit.url)
  tooltip.dispose()
})

test("long tooltip text wraps with an explicit omission marker, and tiny viewport never covers the link", async () => {
  const s = await setup(35, 6)
  const source = new TextRenderable(s.renderer, { id: "tooltip-small-source", content: "https://example.org", width: 35 })
  s.renderer.root.add(source)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  const tooltip = createTooltipOverlay(s.renderer)
  const hit = controller.linkAt(1, 0)!
  const description = `A very long PR title that has to wrap across several rows\nFAILED\n${"failure reason ".repeat(20)}\nLast fetched: now`
  const layout = tooltip.show(hit, description)
  await s.renderOnce()
  expect(layout.clipped).toBeTrue()
  expect(layout.totalRows).toBeGreaterThan(layout.visibleRows)
  expect(tooltip.text.plainText).toContain("rows not shown")
  expect(s.captureCharFrame()).toContain("rows not shown")
  expect(tooltip.node.screenY).toBeGreaterThan(hit.y)
  expect(tooltip.node.screenY + tooltip.node.height).toBeLessThanOrEqual(s.renderer.height)
  s.resize(1, 1)
  const tiny = tooltip.show({ ...hit, x: 0, y: 0 }, description)
  await s.renderOnce()
  expect(tiny.visibleRows).toBe(0)
  expect(tooltip.node.visible).toBeFalse()
  tooltip.dispose()
})

test("tooltip avoids the whole wrapped URL rather than only its hovered cell", async () => {
  const s = await setup(24, 12)
  const source = new TextRenderable(s.renderer, { id: "wrapped-tooltip-source", content: "https://example.org/a/long/path",
    width: 24, wrapMode: "char" })
  s.renderer.root.add(source)
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  const hit = controller.linkAt(2, 0)!
  expect(hit.bounds.height).toBe(2)
  const tooltip = createTooltipOverlay(s.renderer)
  tooltip.show(hit, "OPEN\nCI failed\nReason: migration invalid")
  await s.renderOnce()
  expect(tooltip.node.screenY).toBeGreaterThanOrEqual(hit.bounds.y + hit.bounds.height)
  expect(at(s.renderer, 0, 1)).toBe(hit.url)
  tooltip.dispose()
})

test("unsupported runtime/version/layout reports exact diagnostics", async () => {
  const s = await setup(40, 5)
  const startup: Diagnostic[] = []
  const options = { onHover: () => {}, onVisible: () => {}, onDiagnostic: (d: Diagnostic) => startup.push(d) }
  const inactive = installLinkRenderer({ app: { version: "1.18.35" }, renderer: s.renderer }, options)
  expect(startup[0].code).toBe("unsupported-version")
  expect(inactive.linkAt(0, 0)).toBeNull()
  inactive.dispose()
  const diagnostics: Diagnostic[] = []
  const text = new TextRenderable(s.renderer, { id: "unsupported", content: "https://example.org", truncate: true })
  s.renderer.root.add(text)
  const result = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => diagnostics.push(d),
  })
  expect(typeof result.dispose).toBe("function")
  await s.renderOnce()
  await s.renderOnce()
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0].code).toBe("unsupported-layout")
  const list: unknown = Reflect.get(s.renderer.root, "renderList")
  Reflect.set(s.renderer.root, "renderList", null)
  installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, options)
  expect(startup.at(-1)!.code).toBe("unsupported-runtime")
  Reflect.set(s.renderer.root, "renderList", list)
})

test("native tracked cell rewrite preserves Unicode URL glyphs, continuations, syntax and reports >512-byte links", async () => {
  const s = await setup(60, 5)
  const original = "https://example.org/界/é/🙂"
  const text = new TextRenderable(s.renderer, { id: "wide-url", content: original })
  s.renderer.root.add(text)
  await s.renderOnce()
  const chars = [...s.renderer.currentRenderBuffer.buffers.char]
  const fg = [...s.renderer.currentRenderBuffer.buffers.fg]
  const bg = [...s.renderer.currentRenderBuffer.buffers.bg]
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect([...s.renderer.currentRenderBuffer.buffers.char]).toEqual(chars)
  expect([...s.renderer.currentRenderBuffer.buffers.fg]).toEqual(fg)
  expect([...s.renderer.currentRenderBuffer.buffers.bg]).toEqual(bg)
  expect(at(s.renderer, 20, 0)).toBe(original)
  expect(at(s.renderer, 21, 0)).toBe(original)
  expect(text.plainText).toBe(original)
  controller.dispose()
  const diagnostics: Diagnostic[] = []
  installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => diagnostics.push(d),
  })
  text.content = `https://example.org/${"x".repeat(600)}`
  await s.renderOnce()
  expect(diagnostics.some((d) => d.code === "url-too-long")).toBeTrue()
  expect(at(s.renderer, 0, 0)).toBeNull()
})

test("real bundled Tree-sitter parsers preserve highlighted/concealed Markdown and code selection", async () => {
  const s = await setup(80, 20)
  const client = new TreeSitterClient({ dataPath: join(dirname(import.meta.path), "parser-cache") })
  clients.push(client)
  await client.initialize()
  const content = 'const u = "https://example.org"'
  const highlights = await client.highlightOnce(content, "typescript")
  expect(highlights.highlights!.length).toBeGreaterThan(0)
  const code = new CodeRenderable(s.renderer, { id: "real-code", content, syntaxStyle: syntax(),
    filetype: "typescript", conceal: false, treeSitterClient: client })
  const md = new MarkdownRenderable(s.renderer, { id: "real-md", syntaxStyle: syntax(), treeSitterClient: client,
    conceal: true, content: "**bold** [label](https://label.example.org)\n\n```typescript\nconst u = 'https://fenced.example.org'\n```" })
  s.renderer.root.add(code)
  s.renderer.root.add(md)
  await s.renderOnce()
  for (const source of textSources(s.renderer.root)) if (source instanceof CodeRenderable) await source.highlightingDone
  await s.renderOnce()
  const sources = textSources(s.renderer.root)
  const before = sources.map((node) => ({ plain: node.plainText, info: node.lineInfo,
    onChunks: node instanceof CodeRenderable ? node.onChunks : undefined }))
  const styles = s.captureSpans()
  s.renderer.startSelection(code, code.screenX, code.screenY)
  s.renderer.updateSelection(code, code.screenX + content.length, code.screenY)
  const originalCopy = s.renderer.getSelection()!.getSelectedText()
  expect(originalCopy).toBe(content)
  s.renderer.clearSelection()
  const controller = install(s.renderer, () => {})
  await s.renderOnce()
  expect(s.captureSpans()).toEqual(styles)
  expect(sources.map((node) => ({ plain: node.plainText, info: node.lineInfo,
    onChunks: node instanceof CodeRenderable ? node.onChunks : undefined }))).toEqual(before)
  const urls = new Set<string>()
  for (let y = 0; y < s.renderer.height; y++) for (let x = 0; x < s.renderer.width; x++) {
    const hit = controller.linkAt(x, y)
    if (hit !== null) urls.add(hit.url)
  }
  expect(urls.has("https://example.org")).toBeTrue()
  expect(urls.has("https://label.example.org")).toBeTrue()
  expect(urls.has("https://fenced.example.org")).toBeTrue()
  s.renderer.startSelection(code, code.screenX, code.screenY)
  s.renderer.updateSelection(code, code.screenX + content.length, code.screenY)
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(originalCopy)
}, 15000)

test("createCliRenderer native output emits OSC 8 from post-process attributes, without changing copy", async () => {
  const output: Buffer[] = []
  const stdin = new Readable({ read() {} })
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback() } })
  const renderer = await createCliRenderer({
    // @ts-expect-error 0.4.5 config types demand a tty ReadStream; runtime supports plain custom streams.
    stdin,
    // @ts-expect-error 0.4.5 config types demand a tty WriteStream; runtime supports plain custom streams.
    stdout, remote: true, useThread: false,
    screenMode: "alternate-screen", consoleMode: "disabled", useConsole: false, exitOnCtrlC: false })
  renderers.push(renderer)
  renderer.resize(40, 6)
  // Public input/capability mechanism; no private capability flag mutation.
  stdin.emit("data", Buffer.from("\x1bP>|ghostty 1.2.3\x1b\\"))
  expect(renderer.capabilities?.hyperlinks).toBeTrue()
  const original = "copy https://example.org"
  const text = new TextRenderable(renderer, { id: "native-output", content: original })
  renderer.root.add(text)
  const controller = install(renderer, () => {})
  // Public frame event and requestRender, rather than invoking private loop().
  const frame = new Promise<void>((resolve) => renderer.once("frame", resolve))
  renderer.requestRender()
  await frame
  await renderer.idle()
  const bytes = Buffer.concat(output).toString("utf8")
  expect(bytes).toMatch(/\x1b\]8;id=\d+;https:\/\/example\.org\x1b\\/)
  expect(bytes).toContain("\x1b]8;;\x1b\\")
  expect(text.plainText).toBe(original)
  const count = output.length
  const nextFrame = new Promise<void>((resolve) => renderer.once("frame", resolve))
  renderer.requestRender()
  await nextFrame
  await renderer.idle()
  expect(Buffer.concat(output.slice(count)).toString("utf8")).not.toContain("\x1b]8;")
  renderer.startSelection(text, 0, 0)
  renderer.updateSelection(text, original.length, 0)
  stdin.emit("data", Buffer.from(`\x1b[<0;${original.length + 1};1m`))
  expect(renderer.getSelection()!.getSelectedText()).toBe(original)
  controller.dispose()
}, 10000)

test("serialized native PR symbols remain ordinary Unicode with a false startup explicit-width capability", async () => {
  const output: Buffer[] = []
  const stdin = new Readable({ read() {} })
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback() } })
  const renderer = await createCliRenderer({
    // @ts-expect-error 0.4.5 types require tty streams; the runtime supports custom streams.
    stdin,
    // @ts-expect-error 0.4.5 types require tty streams; this exercises the actual native output feed.
    stdout, remote: true, useThread: false,
    screenMode: "alternate-screen", consoleMode: "disabled", useConsole: false, exitOnCtrlC: false,
  })
  renderers.push(renderer)
  renderer.resize(80, 24)
  // Only the unrelated pre-home CPR reports column 2; both OSC 66 probes report no support.
  stdin.emit("data", Buffer.from("\x1bP>|ghostty 1.1.3\x1b\\\x1b[1;2R\x1b[1;1R\x1b[1;1R"))
  expect(renderer.capabilities?.explicit_width).toBeTrue()
  const url = "https://github.com/octo-org-sample/alpha/pull/224"
  const source = new TextRenderable(renderer, { id: "native-symbol-source", content: url, flexShrink: 0 })
  renderer.root.add(source)
  const strip = attachBadgeStrip(renderer, sourceBlock(source), [{ url, label: "alpha#224 ◆ ✕" }],
    (diagnostic) => { throw new Error(diagnostic.detail) })!
  const unrelated = new TextRenderable(renderer, { id: "unrelated-native-symbol", content: "Unrelated ◆", flexShrink: 0 })
  renderer.root.add(unrelated)
  const tooltip = createTooltipOverlay(renderer)
  const controller = install(renderer, (hit) => tooltip.show(hit, "Merged · CI failing"))
  const draw = async (): Promise<void> => {
    const frame = new Promise<void>(resolve => renderer.once("frame", resolve))
    renderer.requestRender()
    await frame
    await renderer.idle()
  }
  await draw()
  const bytes = Buffer.concat(output).toString("utf8")
  // An unsupported terminal discards OSC payloads, including OSC 66 text. This
  // checks actual Zig-serialized output, not getRealCharBytes()/captureCharFrame().
  const visibleText = bytes.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  expect(visibleText).toContain("alpha#224 ◆ ✕")
  expect(bytes).toContain("\x1b]66;w=1;◆\x1b\\") // Unrelated host widgets retain their width policy.
  expect(strip.selectable).toBeFalse()
  expect(source.plainText).toBe(url)
  stdin.emit("data", Buffer.from(`\x1b[<63;2;${source.screenY + 1}M`))
  await draw()
  expect(tooltip.node.visible).toBeTrue()
  renderer.startSelection(source, source.screenX, source.screenY)
  renderer.updateSelection(source, source.screenX + url.length, source.screenY, { finishDragging: true })
  expect(renderer.getSelection()!.getSelectedText()).toBe(url)
  controller.dispose()
  tooltip.dispose()
  expect(renderer.capabilities?.explicit_width).toBeTrue()
}, 10000)

test("committed onChunks Code status ranges normalize only owned columns while preserving copy/styles/link bounds", async () => {
  const s = await setup(80, 12)
  const url = "https://github.com/octo-org-sample/alpha/pull/224"
  const original = `Original ordinary ◇ and ${url}`
  const prefix = "界 ordinary ◇ label "
  const symbols = "◇◆✓✕◷⊘?⟳·…"
  const projected = `${prefix}${symbols}`
  const client = mockClient()
  client.setMockResult({ highlights: [] })
  const onChunks = () => [
    { __isChunk: true as const, text: prefix, fg: RGBA.fromHex("#ffffff"), attributes: TextAttributes.BOLD },
    { __isChunk: true as const, text: symbols, fg: RGBA.fromHex("#a78bfa"), attributes: TextAttributes.ITALIC, link: { url } },
  ]
  const code = new CodeRenderable(s.renderer, { id: "projected-code", content: original, syntaxStyle: syntax(),
    filetype: "markdown", conceal: false, treeSitterClient: client, onChunks })
  s.renderer.root.add(code)
  await s.renderOnce()
  client.resolveAllHighlightOnce()
  await code.highlightingDone
  await s.renderOnce()
  const measure = TextBuffer.create(s.renderer.widthMethod)
  measure.setText(prefix)
  const start = measure.length
  measure.destroy()
  expect(start).not.toBe(prefix.length) // Producer offsets are native columns, not UTF-16.
  const ranges: readonly InlineStatusRange[] = [{ start, end: start + symbols.length, text: symbols, url }]
  const originalGlyph = s.renderer.currentRenderBuffer.buffers.char["界 ordinary ".length + 1]
  const fg = [...s.renderer.currentRenderBuffer.buffers.fg]
  const bg = [...s.renderer.currentRenderBuffer.buffers.bg]
  const attributes = [...s.renderer.currentRenderBuffer.buffers.attributes].map((value) => value & 0xff)
  let producerCalls = 0
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    statusRanges: (source) => {
      if (source !== code || code.plainText !== projected) return []
      producerCalls++
      return ranges
    },
  })
  await s.renderOnce()
  expect(producerCalls).toBe(1)
  for (let offset = 0; offset < symbols.length; offset++) {
    expect(s.renderer.currentRenderBuffer.buffers.char[start + offset]).toBe(symbols.codePointAt(offset)!)
    expect(controller.linkAt(start + offset, 0)!.url).toBe(url)
  }
  expect(s.renderer.currentRenderBuffer.buffers.char["界 ordinary ".length + 1]).toBe(originalGlyph)
  expect([...s.renderer.currentRenderBuffer.buffers.fg]).toEqual(fg)
  expect([...s.renderer.currentRenderBuffer.buffers.bg]).toEqual(bg)
  expect([...s.renderer.currentRenderBuffer.buffers.attributes].map((value) => value & 0xff)).toEqual(attributes)
  expect(code.content).toBe(original)
  expect(code.plainText).toBe(projected)
  expect(code.onChunks).toBe(onChunks)
  s.renderer.startSelection(code, 0, 0)
  s.renderer.updateSelection(code, start + symbols.length, 0, { finishDragging: true })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(projected)
  const cover = new TextRenderable(s.renderer, { id: "inline-status-cover", content: "◆", position: "absolute",
    left: start, top: 0, width: 1, height: 1, zIndex: 100, selectable: false })
  s.renderer.root.add(cover)
  await s.renderOnce()
  expect(s.renderer.currentRenderBuffer.buffers.char[start]).not.toBe("◆".codePointAt(0)!)
  expect(controller.linkAt(start, 0)).toBeNull()
})

test("native serializer emits owned inline Code statuses as Unicode while an unmarked Code diamond stays OSC 66", async () => {
  const output: Buffer[] = []
  const stdin = new Readable({ read() {} })
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback() } })
  const renderer = await createCliRenderer({
    // @ts-expect-error 0.4.5 config requires tty types but supports custom streams.
    stdin,
    // @ts-expect-error Public custom stdout feed verifies real native serialization.
    stdout, remote: true, useThread: false, screenMode: "alternate-screen", consoleMode: "disabled", useConsole: false, exitOnCtrlC: false,
  })
  renderers.push(renderer)
  renderer.resize(100, 12)
  stdin.emit("data", Buffer.from("\x1bP>|ghostty 1.1.3\x1b\\\x1b[1;2R\x1b[1;1R\x1b[1;1R"))
  expect(renderer.capabilities?.explicit_width).toBeTrue()
  const url = "https://github.com/octo-org-sample/alpha/pull/224"
  const original = `Ordinary diamond ◆ before ${url}`
  const prefix = "ordinary ◆ compact label "
  const symbols = "◇◆✓✕◷⊘?⟳·…"
  const projected = `${prefix}${symbols}`
  const client = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  clients.push(client)
  client.setMockResult({ highlights: [] })
  const code = new CodeRenderable(renderer, { id: "native-inline-code", content: original, filetype: "markdown",
    treeSitterClient: client, syntaxStyle: syntax(), conceal: false,
    onChunks: () => [
      { __isChunk: true, text: prefix },
      { __isChunk: true, text: symbols, fg: RGBA.fromHex("#a78bfa"), link: { url } },
    ] })
  renderer.root.add(code)
  const controller = installLinkRenderer({ app: { version: "1.18.34" }, renderer }, {
    onHover: () => {}, onVisible: () => {}, onDiagnostic: (d) => { throw new Error(d.detail) },
    statusRanges: (source) => source === code && code.plainText === projected
      ? [{ start: prefix.length, end: projected.length, text: symbols, url }] : [],
  })
  const draw = async (): Promise<void> => {
    const frame = new Promise<void>((resolve) => renderer.once("frame", resolve))
    renderer.requestRender()
    await frame
    await renderer.idle()
  }
  await draw()
  await code.highlightingDone
  await draw()
  const bytes = Buffer.concat(output).toString("utf8")
  const visible = bytes.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  // Native diff output can omit unchanged label spaces; the owned status run
  // itself must remain printable after an unsupported terminal strips OSCs.
  expect(visible).toContain(symbols)
  expect(bytes).toContain("\x1b]66;w=1;◆\x1b\\")
  expect(code.content).toBe(original)
  expect(code.plainText).toBe(projected)
  expect(controller.linkAt(prefix.length, 0)!.source).toBe(code)
  expect(renderer.capabilities?.explicit_width).toBeTrue()
  controller.dispose()
}, 10000)
