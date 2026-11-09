import { afterEach, expect, test } from "bun:test"
import { dirname, join } from "node:path"
// Test-only parser/style construction. All renderable/native buffer values use
// the same rendererCore bindings as the helper and the stock plugin renderer.
import { SyntaxStyle, TreeSitterClient, type CliRenderer, type CodeRenderable,
  type Renderable, type TextChunk } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { compactProseUrls, installCompactProse, type CompactProseSource, type CompactProseTheme } from "./prose"
import { rendererCore, installLinkRenderer, nativeLinks, textSources, sourceBlock, attachBadgeStrip, type LinkHit } from "./renderer"
import type { StatusSymbol } from "./presentation"

const { CodeRenderable: Code, MarkdownRenderable: Markdown, TextRenderable: Text, TextBuffer,
  RGBA, BoxRenderable, StyledText } = rendererCore
const url = "https://github.com/octo-org-sample/alpha/pull/224"
const destination = `${url}/files?diff=split#diff-界`
const mergedFailed: readonly StatusSymbol[] = [{ text: "◆", color: "merged" }, { text: "✕", color: "error" }]
const theme: CompactProseTheme = {
  link: RGBA.fromHex("#55bbff"), symbols: { muted: RGBA.fromHex("#888888"), success: RGBA.fromHex("#00ff00"),
    error: RGBA.fromHex("#ff0000"), warning: RGBA.fromHex("#ffaa00"), merged: RGBA.fromHex("#bb88ff") },
}
const renderers: CliRenderer[] = []
const clients: TreeSitterClient[] = []
const styles: SyntaxStyle[] = []
const disposers: (() => void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const renderer of renderers.splice(0)) renderer.destroy()
  for (const client of clients.splice(0)) await client.destroy()
  for (const style of styles.splice(0)) style.destroy()
})

async function setup(content: string, width = 100, blockMode: "top-level" | "coalesced" | "default" = "top-level") {
  const s = await createTestRenderer({ width, height: 40, useMouse: true })
  renderers.push(s.renderer)
  const client = new TreeSitterClient({ dataPath: join(dirname(import.meta.path), "parser-cache") })
  clients.push(client)
  await client.initialize()
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex("#eeeeee") },
    "markup.link.label": { fg: theme.link, underline: true }, "markup.link.url": { fg: theme.link },
    "markup.strong": { fg: RGBA.fromHex("#ffdd88"), bold: true },
    "markup.raw": { fg: RGBA.fromHex("#cccccc") } })
  styles.push(style)
  const md = new Markdown(s.renderer, { id: "compact-fixture", content, syntaxStyle: style,
    treeSitterClient: client, conceal: true, streaming: true,
    ...(blockMode === "default" ? {} : { internalBlockMode: blockMode }) })
  s.renderer.root.add(md)
  let status = mergedFailed
  let colors = theme
  const handles = new Map<Renderable, CompactProseSource>()
  const options = { widthMethod: s.renderer.widthMethod, readStatus: () => status, readTheme: () => colors }
  const sync = () => {
    for (const source of textSources(md)) {
      if (handles.has(source)) continue
      const handle = installCompactProse(source, options)
      if (handle === null) continue
      handles.set(source, handle)
      disposers.push(handle.dispose)
    }
  }
  const settle = async () => {
    for (const source of textSources(md)) if (source instanceof Code) await source.highlightingDone
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  }
  const draw = async () => {
    for (let frame = 0; frame < 3; frame++) { await s.renderOnce(); await settle() }
  }
  const refresh = async () => { await Promise.all([...handles.values()].map((handle) => handle.refresh())); await draw() }
  const sources = () => textSources(md).filter((source): source is CodeRenderable => source instanceof Code)
  const copyAll = (source: CodeRenderable): string => {
    s.renderer.clearSelection()
    s.renderer.startSelection(source, source.screenX, source.screenY)
    s.renderer.updateSelection(source, source.screenX + source.width, source.screenY + source.height - 1,
      { finishDragging: true })
    return s.renderer.getSelection()!.getSelectedText()
  }
  return { ...s, md, sources, options, handles, sync, draw, refresh, copyAll,
    status: (value: readonly StatusSymbol[]) => { status = value },
    theme: (value: CompactProseTheme) => { colors = value }, style, client }
}
function selected(source: CodeRenderable, start: number, end: number): string {
  // Public native selection API exercises real column offsets, not JS substring.
  const view = Reflect.get(source, "textBufferView") as InstanceType<typeof rendererCore.TextBufferView>
  view.setSelection(start, end)
  return source.getSelectedText()
}

test("offscreen reference prose exposes its resolved PR href before any native cells or helper installation", async () => {
  const reference = "[Alpha ref][id]"
  const content = `${reference}\n\n[id]: ${destination}`
  const s = await setup(content, 30)
  const source = s.sources().find((source) => source.content === reference)!
  expect(source).toBeDefined()
  expect(source.content).not.toContain(destination)
  const hook = source.onChunks
  const copy = source.getSelectedText
  const spacer = new BoxRenderable(s.renderer, { id: "offscreen-reference-spacer", height: 45, flexShrink: 0 })
  s.renderer.root.add(spacer, 0)
  const links = nativeLinks()!
  expect([...s.renderer.currentRenderBuffer.buffers.attributes].every((attributes) => links.attributesGetLinkId(attributes) === 0)).toBeTrue()
  expect(compactProseUrls(source)).toEqual([destination])
  await s.draw()
  expect(source.screenY).toBeGreaterThanOrEqual(s.renderer.height)
  expect(compactProseUrls(source)).toEqual([destination])
  expect(source.onChunks).toBe(hook)
  expect(source.getSelectedText).toBe(copy)
  expect(source.content).toBe(reference)
  expect(s.md.content).toBe(content)
  // Discovery can now install the helper while still offscreen. The native
  // reference hook need not have supplied any valid destination attributes.
  s.sync()
  spacer.destroy(); await s.draw()
  expect(source.plainText).toBe("Alpha #224 ◆✕")
  expect(s.handles.get(source)!.ready()).toBeTrue()
  expect(s.handles.get(source)!.urls()).toEqual([destination])
  const id = links.attributesGetLinkId(s.renderer.currentRenderBuffer.buffers.attributes[source.screenY * s.renderer.width + source.screenX])
  expect(links.linkGetUrl(id, 512)).toBe(destination)
  expect(s.copyAll(source)).toContain(destination)
  expect(s.copyAll(source)).toContain("Alpha ref")
  expect(source.content).toBe(reference)
  expect(s.md.content).toBe(content)
}, 15000)

test("resolved prose destinations preserve exact query/fragment hrefs and exclude protected labels, images, bare literals and unsafe targets", async () => {
  const content = `[Alpha ref][id] and [Custom](${url}) and ${url}.\n\n` +
    `[\`gh pr view ${url}\`][id] ![Alpha image][id] \`${destination}\`\n\n` +
    `[Documentation](https://example.org) [Unsafe](javascript:alert(1))\n\n[id]: ${destination}`
  const s = await setup(content)
  const [positive, protectedSource, unsupported] = s.sources()
  expect(compactProseUrls(positive!)).toEqual([destination, url])
  expect(compactProseUrls(protectedSource!)).toEqual([])
  expect(compactProseUrls(unsupported!)).toEqual([])
  const hook = positive!.onChunks
  const copy = positive!.getSelectedText
  expect(compactProseUrls(positive!)).toEqual([destination, url])
  expect(positive!.onChunks).toBe(hook)
  expect(positive!.getSelectedText).toBe(copy)
  expect(s.md.content).toBe(content)
  await s.draw()
}, 15000)

test("reference destinations follow native heading/list AST tokens, known anchors and parsed streaming updates", async () => {
  const reference = "[Alpha ref][id]"
  const s = await setup(`## ${reference}\n\n- ${reference}\n\n[id]: ${destination}`)
  const sources = s.sources().filter((source) => source.content.includes(reference))
  expect(sources).toHaveLength(2)
  for (const source of sources) {
    sourceBlock(source)
    expect(compactProseUrls(source)).toEqual([destination])
  }
  const next = `${url}/checks?check=42#changed-界`
  s.md.content = `[Updated reference][id]\n\n[id]: ${next}`
  const current = s.sources().find((source) => source.content === "[Updated reference][id]")!
  expect(compactProseUrls(current)).toEqual([next])
  expect(compactProseUrls(sources[0]!)).toEqual([])
  expect(compactProseUrls(sources[1]!)).toEqual([])
  await s.draw()
}, 15000)

test.each(["coalesced", "default"] as const)("%s can discover reference hrefs when its canonical raw prose block matches uniquely", async (mode) => {
  const reference = "[Alpha ref][id]"
  const s = await setup(`## Definitions\n\n[id]: ${destination}\n\n\`\`\`text\nseparator\n\`\`\`\n\n${reference}`, 80, mode)
  const source = s.sources().find((source) => source.content.replace(/[\r\n]+$/u, "") === reference)!
  expect(source).toBeDefined()
  expect(compactProseUrls(source)).toEqual([destination])
  await s.draw()
}, 15000)

test("resolved destination discovery rejects code fences, standalone Code and plain Text despite PR reference bytes", async () => {
  const fenced = `[Alpha ref][id]\n\n[id]: ${destination}`
  const s = await setup(`\`\`\`markdown\n${fenced}\n\`\`\``)
  const fence = s.sources()[0]!
  expect(compactProseUrls(fence)).toEqual([])
  sourceBlock(fence)
  expect(compactProseUrls(fence)).toEqual([])
  const code = new Code(s.renderer, { content: fenced, filetype: "markdown", syntaxStyle: s.style, treeSitterClient: s.client })
  const text = new Text(s.renderer, { content: destination })
  s.renderer.root.add(code); s.renderer.root.add(text)
  expect(compactProseUrls(code)).toEqual([])
  expect(compactProseUrls(text)).toEqual([])
  expect(s.md.content).toBe(`\`\`\`markdown\n${fenced}\n\`\`\``)
  await s.draw()
  await code.highlightingDone
}, 15000)

test("whole human label + parenthetical becomes one inline chip, with exact destination and original copy", async () => {
  const original = `Before Alpha PR #224 (${destination}), after.`
  const s = await setup(original)
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe("Before Alpha #224 ◆✕, after.")
  expect(s.captureCharFrame()).toContain("Before Alpha #224 ◆✕, after.")
  expect(s.md.content).toBe(original)
  expect(source.content).toBe(original)
  expect(s.handles.get(source)!.owns(source)).toBeTrue()
  expect(s.handles.get(source)!.urls()).toEqual([destination])
  expect(s.handles.get(source)!.ready()).toBeTrue()
  expect(s.handles.get(source)!.compactRanges()).toEqual([{ start: 7, end: 20, url: destination }])
  expect(s.copyAll(source)).toBe(original)
  expect(selected(source, 7, 19)).toBe(`Alpha PR #224 (${destination})`)
  expect(selected(source, 9, 12)).toBe(`Alpha PR #224 (${destination})`)
  expect(selected(source, 0, 6)).toBe("Before")
}, 15000)

test("custom Markdown labels, bare URLs, headings and nested list prose compact without duplicate labels", async () => {
  const original = `## [A custom title](${destination})\n\nBare ${url}.\n\n- [Alpha PR #224](${url})\n  - Alpha PR#224 (${url})`
  const s = await setup(original)
  s.sync(); await s.draw()
  expect(s.sources().map((source) => source.plainText)).toEqual([
    "Alpha #224 ◆✕", "Bare Alpha #224 ◆✕.", "Alpha #224 ◆✕", "Alpha #224 ◆✕",
  ])
  expect(s.copyAll(s.sources()[0]!)).toContain(destination)
  expect(s.copyAll(s.sources()[1]!)).toBe(`Bare ${url}.`)
  expect(s.md.content).toBe(original)
}, 15000)

test("ordinary and markdown-tagged code fences, nested fences and inline commands retain URL bytes", async () => {
  const command = `gh pr view ${destination}`
  const original = `Prose ${url}\n\nUse \`${command}\` then ${url}.\n\n\`\`\`bash\n${command}\n\`\`\`\n\n\`\`\`markdown\nAlpha PR #224 (${destination})\n\`\`\`\n\n- Prose ${url}\n\n  \`\`\`markdown\n  ${command}\n  \`\`\``
  const s = await setup(original)
  const fences = s.sources().filter((source) => source.onChunks === undefined)
  const hooks = fences.map((source) => source.onChunks)
  for (const source of fences) {
    sourceBlock(source)
    expect(installCompactProse(source, s.options)).toBeNull()
  }
  s.sync(); await s.draw()
  expect(fences).toHaveLength(3)
  expect(fences.map((source) => source.onChunks)).toEqual(hooks)
  expect(fences.map((source) => source.plainText)).toEqual([command, `Alpha PR #224 (${destination})`, command])
  for (const source of fences) {
    expect(s.handles.has(source)).toBeFalse()
    expect(s.copyAll(source)).toBe(source.content)
  }
  const inline = s.sources().find((source) => source.content.startsWith("Use"))!
  expect(inline.plainText).toBe(`Use ${command} then Alpha #224 ◆✕.`)
  expect(s.copyAll(inline)).toBe(`Use ${command} then ${url}.`)
}, 15000)

test("unsupported targets and unsafe schemes retain native labels; user Text/Solid and standalone Code are ineligible", async () => {
  const original = `[Other](https://example.org/x) [Issue](https://github.com/octo-org-sample/alpha/issues/224) [Unsafe](javascript:alert(1))`
  const s = await setup(original)
  await s.draw()
  const source = s.sources()[0]!
  const before = source.plainText
  s.sync(); await s.draw()
  expect(source.plainText).toBe(before)
  expect(s.handles.get(source)!.owns(source)).toBeFalse()
  const text = new Text(s.renderer, { content: url })
  const code = new Code(s.renderer, { content: url, filetype: "markdown", syntaxStyle: s.style, treeSitterClient: s.client })
  s.renderer.root.add(text); s.renderer.root.add(code)
  const hook = code.onChunks
  expect(installCompactProse(text, s.options)).toBeNull()
  expect(installCompactProse(code, s.options)).toBeNull()
  expect(code.onChunks).toBe(hook)
}, 15000)

test("live cached status and theme updates rehighlight unchanged bytes and preserve native destination", async () => {
  const s = await setup(url)
  s.status([{ text: "?", color: "muted" }]); s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe("Alpha #224 ?")
  const originalFg = s.renderer.currentRenderBuffer.buffers.fg.slice(0, 4)
  s.status(mergedFailed)
  const next = { ...theme, link: RGBA.fromHex("#44ff88") }
  s.theme(next); await s.refresh()
  expect(source.plainText).toBe("Alpha #224 ◆✕")
  expect(source.content).toBe(url)
  expect(s.handles.get(source)!.urls()).toEqual([url])
  expect(s.renderer.currentRenderBuffer.buffers.fg.slice(0, 4)).not.toEqual(originalFg)
  expect(s.handles.get(source)!.statusRanges()).toEqual([
    { start: 11, end: 12, text: "◆", url }, { start: 12, end: 13, text: "✕", url },
  ])
  const attrs = s.renderer.currentRenderBuffer.buffers.attributes
  const links = nativeLinks()!
  for (let x = 0; x < source.plainText.length; x++) {
    expect(links.linkGetUrl(links.attributesGetLinkId(attrs[x]), 512)).toBe(url)
  }
  const buffer = Reflect.get(source, "textBuffer") as InstanceType<typeof TextBuffer>
  expect(buffer.getPlainText()).toBe(source.plainText)
  expect(s.copyAll(source)).toBe(url)
}, 15000)

test("unicode, combining marks, tabs, newlines and native wrapping preserve original full and partial copy", async () => {
  const original = `界 🙂 é\tbefore ${url}, after 界.\nNext ${destination} tail.`
  const s = await setup(original, 23)
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe("界 🙂 é\tbefore Alpha #224 ◆✕, after 界.\nNext Alpha #224 ◆✕ tail.")
  expect(source.height).toBeGreaterThan(2)
  expect(s.copyAll(source)).toBe(original)
  const measure = TextBuffer.create(s.renderer.widthMethod)
  try {
    const prefix = "界 🙂 é\tbefore "
    measure.setText(prefix)
    const column = measure.length
    expect(selected(source, column, column + 13)).toBe(url)
    expect(selected(source, 0, column)).toBe(prefix)
    const visiblePrefix = "界 🙂 é\tbefore Alpha #224 ◆✕, after 界.\nNext "
    measure.setText(visiblePrefix)
    const second = measure.length + 1
    expect(selected(source, second, second + 13)).toBe(destination)
    expect(selected(source, second + 13, second + 19)).toBe(" tail.")
  } finally { measure.destroy() }
}, 15000)

test("equal destinations are separate occurrences, adjacent differing destinations preserve exact copy", async () => {
  const second = "https://github.com/octo-org-sample/beta/pull/9?foo=bar#x"
  const original = `${url} / ${url} / ${second}`
  const s = await setup(original)
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe("Alpha #224 ◆✕ / Alpha #224 ◆✕ / Beta #9 ◆✕")
  expect(s.handles.get(source)!.urls()).toEqual([url, url, second])
  expect(s.copyAll(source)).toBe(original)
  expect(selected(source, 16, 29)).toBe(url)
}, 15000)

test("original async hook is composed once, unchanged chunks/styles are retained and cleanup restores hook/copy", async () => {
  const original = `**Before** ${url} after.`
  const s = await setup(original)
  const source = s.sources()[0]!
  const native = source.onChunks!
  let inputs: readonly TextChunk[] = []
  let calls = 0
  const originalHook: NonNullable<typeof source.onChunks> = async (chunks, context) => {
    calls++
    await Promise.resolve()
    const output = await native(chunks, context)
    inputs = output === undefined ? chunks : output
    return output
  }
  source.onChunks = originalHook
  const copy = source.getSelectedText
  s.sync(); await s.draw()
  expect(calls).toBe(1)
  const prefix = inputs.find((chunk) => chunk.text === "Before")!
  expect(prefix).toBeDefined()
  expect(source.plainText).toBe("Before Alpha #224 ◆✕ after.")
  const firstAttributes = s.renderer.currentRenderBuffer.buffers.attributes[0] & 0xff
  expect(firstAttributes).toBe(prefix.attributes!)
  const handle = s.handles.get(source)!
  handle.dispose(); handle.dispose(); await s.draw()
  expect(source.onChunks).toBe(originalHook)
  expect(source.getSelectedText).toBe(copy)
  expect(Object.hasOwn(source, "getSelectedText")).toBeFalse()
  expect(source.plainText).toBe(`Before ${url} after.`)
  expect(handle.owns(source)).toBeFalse()
}, 15000)

test("streaming updates, token replacement/removal and disposal preserve new content and other owners", async () => {
  const s = await setup(url)
  s.sync(); await s.draw()
  const first = s.sources()[0]!
  s.md.content = `${url}\n\nNew Alpha PR #224 (${destination})`
  s.sync(); await s.draw()
  expect(s.sources().map((source) => source.plainText)).toEqual(["Alpha #224 ◆✕", "New Alpha #224 ◆✕"])
  s.md.content = "No links remain."
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe("No links remain.")
  expect(s.handles.get(source)!.owns(source)).toBeFalse()
  expect(s.copyAll(source)).toBe("No links remain.")
  const replacement = () => undefined
  const replacementCopy = () => "another owner"
  source.onChunks = replacement; source.getSelectedText = replacementCopy
  s.handles.get(source)!.dispose()
  expect(source.onChunks).toBe(replacement)
  expect(source.getSelectedText).toBe(replacementCopy)
  await s.handles.get(first)!.refresh()
  s.md.content = "```markdown\n" + url + "\n```"
  s.sync(); await s.draw()
  expect(s.sources()[0]!.plainText).toBe(url)
  expect(installCompactProse(s.sources()[0]!, s.options)).toBeNull()
}, 15000)

test("existing renderer sees chip links on first original-source channel and supports Cmd click callbacks", async () => {
  const s = await setup(`Alpha PR #224 (${destination})`, 24)
  let visible: readonly LinkHit[] = []
  let stripLinks: readonly LinkHit[] = []
  const activated: string[] = []
  const renderer = installLinkRenderer({ app: { version: "1.18.34" }, renderer: s.renderer }, {
    onHover: () => {}, onDiagnostic: (value) => { throw new Error(value.detail) },
    onVisible: (first, second) => { visible = first; stripLinks = second },
    commandPressed: () => true, onActivate: (hit) => { activated.push(hit.url) },
  })
  disposers.push(renderer.dispose)
  s.sync(); await s.draw()
  expect(visible.some((hit) => hit.url === destination)).toBeTrue()
  expect(stripLinks).toEqual([])
  const source = s.sources()[0]!
  for (let x = 0; x < 13; x++) expect(renderer.linkAt(x, source.screenY)?.url).toBe(destination)
  await s.mockMouse.click(1, source.screenY)
  expect(activated).toEqual([destination])
  expect(s.copyAll(source)).toBe(`Alpha PR #224 (${destination})`)
}, 15000)

test("long PR URLs remain visible and unowned; no destination truncation", async () => {
  const long = `${url}?x=${"a".repeat(512)}`
  const s = await setup(long)
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe(long)
  expect(s.handles.get(source)!.ready()).toBeTrue()
  expect(s.handles.get(source)!.owns(source)).toBeFalse()
  expect(s.handles.get(source)!.urls()).toEqual([])
  expect(s.handles.get(source)!.compactRanges()).toEqual([])
  expect(s.copyAll(source)).toBe(long)
}, 15000)

test("coalesced prose remains usable but blockquotes and tool-like boxes are not compacted", async () => {
  const s = await setup(`Use \`gh pr view ${url}\` then ${url}.\n\n> ${url}`, 100, "coalesced")
  s.sync(); await s.draw()
  expect(s.sources().map((source) => source.plainText)).toEqual([`Use gh pr view ${url} then Alpha #224 ◆✕.`, url])
  const box = new BoxRenderable(s.renderer, {})
  const text = new Text(s.renderer, { content: new StyledText([{ __isChunk: true, text: url }]) })
  box.add(text); s.renderer.root.add(box)
  expect(installCompactProse(text, s.options)).toBeNull()
}, 15000)

test.each((["coalesced", "default"] as const).flatMap((mode) => [
  { mode, kind: "command link", content: `[\`gh pr view ${url}\`](${destination})` },
  { mode, kind: "image", content: `![Alpha PR #224](${destination})` },
]))("$mode native $kind preserves its entire displayed occurrence and copy", async ({ mode, content }) => {
  const s = await setup(content, 80, mode)
  await s.draw()
  const source = s.sources()[0]!
  const before = source.plainText
  const copy = s.copyAll(source)
  s.renderer.clearSelection()
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(source.plainText).toBe(before)
  expect(s.copyAll(source)).toBe(copy)
  expect(source.content).toBe(content)
  expect(s.md.content).toBe(content)
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(handle.compactRanges()).toEqual([])
  expect(handle.statusRanges()).toEqual([])
  s.status([{ text: "✓", color: "success" }]); await s.refresh()
  expect(source.plainText).toBe(before)
  expect(s.copyAll(source)).toBe(copy)
  handle.dispose(); await s.draw()
  expect(source.plainText).toBe(before)
  expect(s.copyAll(source)).toBe(copy)
}, 15000)

test.each((["coalesced", "default"] as const).flatMap((mode) => [
  { mode, kind: "command link", protectedContent: `[\`gh pr view ${url}\`](${destination})` },
  { mode, kind: "image", protectedContent: `![Alpha PR #224](${destination})` },
]))("$mode resolves the canonical $kind AST and compacts only neighboring bare prose", async ({ mode, protectedContent }) => {
  const content = `${protectedContent} then ${url}.`
  const s = await setup(content, 50, mode)
  await s.draw()
  const source = s.sources()[0]!
  const originalVisual = source.plainText
  const originalCopy = s.copyAll(source)
  s.renderer.clearSelection()
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(source.plainText).toBe(originalVisual.slice(0, -`${url}.`.length) + "Alpha #224 ◆✕.")
  expect(handle.ready()).toBeTrue()
  expect(handle.urls()).toEqual([url])
  expect(handle.compactRanges()).toHaveLength(1)
  const chip = handle.compactRanges()[0]!
  expect(selected(source, chip.start + 1, chip.end - 1)).toBe(url)
  expect(s.copyAll(source)).toBe(originalCopy)
  expect(source.content).toBe(content)
  expect(s.md.content).toBe(content)
}, 15000)

test.each(["coalesced", "default"] as const)("%s preserves an ambiguous combined image/prose block without inventing an inline AST", async (mode) => {
  const content = `![Alpha PR #224](${destination})\n\nOrdinary ${url}.`
  const s = await setup(content, 50, mode)
  await s.draw()
  expect(s.sources()).toHaveLength(1)
  const source = s.sources()[0]!
  const originalVisual = source.plainText
  const originalCopy = s.copyAll(source)
  s.renderer.clearSelection()
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(handle.compactRanges()).toEqual([])
  expect(source.plainText).toBe(originalVisual)
  expect(s.copyAll(source)).toBe(originalCopy)
  expect(source.content).toBe(content)
  expect(s.md.content).toBe(content)
}, 15000)

test("coalesced custom link chunks without an associated inline AST remain native", async () => {
  const content = `${url}\n\n${destination}`
  const s = await setup(content, 50, "coalesced")
  const source = s.sources()[0]!
  source.onChunks = () => [{ __isChunk: true, text: "Custom image/link presentation", link: { url: destination } }]
  await s.draw()
  const originalVisual = source.plainText
  const originalCopy = s.copyAll(source)
  s.renderer.clearSelection()
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(source.plainText).toBe(originalVisual)
  expect(s.copyAll(source)).toBe(originalCopy)
  expect(source.content).toBe(content)
  expect(s.md.content).toBe(content)
}, 15000)

test.each(["coalesced", "default"] as const)("%s still compacts unambiguous bare PRs across combined paragraphs", async (mode) => {
  const content = `${url}\n\n${destination}`
  const s = await setup(content, 50, mode)
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  const handle = s.handles.get(source)!
  expect(source.plainText).toBe("Alpha #224 ◆✕\n\nAlpha #224 ◆✕")
  expect(handle.ready()).toBeTrue()
  expect(handle.urls()).toEqual([url, destination])
  expect(handle.compactRanges()).toHaveLength(2)
  expect(s.copyAll(source)).toBe(content)
  expect(source.content).toBe(content)
  expect(s.md.content).toBe(content)
}, 15000)

test("hidden native label metadata still gets one chip and copies its exact URL without changing external destinations", async () => {
  const original = `[Custom title](${destination}) [Other](${url})`
  const s = await setup(original)
  const source = s.sources()[0]!
  source.onChunks = () => [
    { __isChunk: true, text: "Custom title", link: { url: destination } },
    { __isChunk: true, text: " / " },
    { __isChunk: true, text: "Other", link: { url: "https://example.org/original#unchanged" } },
  ]
  s.sync(); await s.draw()
  expect(source.plainText).toBe("Alpha #224 ◆✕ / Other")
  expect(s.copyAll(source)).toBe(`Custom title (${destination}) / Other`)
  expect(s.handles.get(source)!.urls()).toEqual([destination])
  expect(source.content).toBe(original)
}, 15000)

test("dispose during native highlight commit restores the native buffer on the next draw", async () => {
  const s = await setup(url)
  const source = s.sources()[0]!
  let handle: CompactProseSource | null = null
  const installed = installCompactProse(source, { ...s.options,
    readTheme: () => { queueMicrotask(() => handle!.dispose()); return theme },
  })
  expect(installed).not.toBeNull()
  handle = installed!
  disposers.push(handle.dispose)
  await s.draw()
  expect(source.plainText).toBe(url)
  expect(handle.owns(source)).toBeFalse()
  expect(handle.ready()).toBeFalse()
  expect(handle.statusRanges()).toEqual([])
  expect(s.copyAll(source)).toBe(url)
}, 15000)

test("partial wrapped selection and selection across native paragraph/list children preserve original URLs", async () => {
  const original = `界 before ${url} after.\n\n- ${destination}`
  const s = await setup(original, 18)
  s.sync(); await s.draw()
  const first = s.sources()[0]!
  const last = s.sources().at(-1)!
  // Native visual-coordinate selection crosses a wrapped chip; no JS range mock.
  s.renderer.startSelection(first, first.screenX + 10, first.screenY)
  s.renderer.updateSelection(first, first.screenX + 4, first.screenY + 1, { finishDragging: true })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(url)
  s.renderer.clearSelection()
  s.renderer.startSelection(first, first.screenX, first.screenY)
  s.renderer.updateSelection(last, last.screenX + last.width, last.screenY + last.height - 1, { finishDragging: true })
  const copy = s.renderer.getSelection()!.getSelectedText()
  expect(copy).toContain(`界 before ${url} after.`)
  expect(copy).toContain(destination)
  expect(copy).not.toContain("◆")
}, 15000)

test("streaming retains the displayed copy URL until the new same-label destination actually commits", async () => {
  const s = await setup(url)
  const source = s.sources()[0]!
  const native = source.onChunks!
  let pause = false
  let release: () => void = () => { throw new Error("Gate not initialized") }
  const gate = new Promise<void>((resolve) => { release = resolve })
  source.onChunks = async (chunks, context) => {
    if (pause) await gate
    return native(chunks, context)
  }
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(handle.ready()).toBeTrue()
  pause = true
  source.drawUnstyledText = false
  source.content = destination
  source.requestRender()
  expect(handle.ready()).toBeFalse()
  await s.renderOnce()
  try {
    expect(source.plainText).toBe("Alpha #224 ◆✕")
    expect(selected(source, 0, 13)).toBe(url)
    expect(handle.ready()).toBeFalse()
    expect(handle.owns(source)).toBeFalse()
    expect(handle.urls()).toEqual([])
    expect(handle.compactRanges()).toEqual([])
  } finally { release() }
  await s.draw()
  expect(source.plainText).toBe("Alpha #224 ◆✕")
  expect(selected(source, 0, 13)).toBe(destination)
  expect(handle.ready()).toBeTrue()
  expect(s.handles.get(source)!.urls()).toEqual([destination])
}, 15000)

test("ready distinguishes pending highlighting from committed prose with no compact matches", async () => {
  const command = `gh pr view ${destination}`
  const s = await setup(`Use \`${command}\`.`)
  const source = s.sources()[0]!
  s.sync()
  const handle = s.handles.get(source)!
  expect(handle.ready()).toBeFalse()
  expect(handle.owns(source)).toBeFalse()
  expect(handle.urls()).toEqual([])
  await s.draw()
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(handle.compactRanges()).toEqual([])
  expect(source.plainText).toBe(`Use ${command}.`)
  const pending = handle.refresh()
  expect(handle.ready()).toBeFalse()
  await pending
  expect(handle.ready()).toBeFalse()
  await s.draw()
  expect(handle.ready()).toBeTrue()
  s.md.content = "No URLs remain."
  expect(handle.ready()).toBeFalse()
  await s.draw()
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeFalse()
  expect(source.plainText).toBe("No URLs remain.")
  handle.dispose()
  expect(handle.ready()).toBeFalse()
  expect(handle.urls()).toEqual([])
}, 15000)

test("a paragraph wrapped by sourceBlock before installation still compacts at its native token slot", async () => {
  const original = `Before Alpha PR #224 (${destination}) after.`
  const s = await setup(original)
  const source = s.sources()[0]!
  sourceBlock(source)
  const anchor = source.parent!
  expect(anchor.id).toBe(`acq-pr-anchor-${source.num}`)
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(handle).toBeDefined()
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeTrue()
  expect(source.plainText).toBe("Before Alpha #224 ◆✕ after.")
  expect(s.captureCharFrame()).toContain("Before Alpha #224 ◆✕ after.")
  expect(handle.urls()).toEqual([destination])
  expect(s.copyAll(source)).toBe(original)
  expect(s.md.content).toBe(original)
  expect(source.content).toBe(original)
  expect(source.parent).toBe(anchor)
}, 15000)

test("known anchors preserve nested list native child indices, including protected-only fallback strips", async () => {
  const command = `gh pr view ${destination}`
  const original = `- First ${url}\n\n  \`${command}\`\n\n  Last [Custom](${url})\n\n  - Nested ${destination}`
  const s = await setup(original)
  const list = s.md._blockStates[0]!.renderable
  for (const source of s.sources()) sourceBlock(source)
  sourceBlock(list)
  s.sync(); await s.draw()
  const sources = s.sources()
  expect(sources.map((source) => source.plainText)).toEqual([
    "First Alpha #224 ◆✕", command, "Last Alpha #224 ◆✕", "Nested Alpha #224 ◆✕",
  ])
  const protectedSource = sources[1]!
  const protectedHandle = s.handles.get(protectedSource)!
  expect(protectedHandle.ready()).toBeTrue()
  expect(protectedHandle.owns(protectedSource)).toBeFalse()
  const strip = attachBadgeStrip(s.renderer, sourceBlock(protectedSource), [{ url: destination, label: "alpha#224 ◆ ✕" }],
    (value) => { throw new Error(value.detail) })!
  expect(strip).not.toBeNull()
  s.status([{ text: "✓", color: "success" }]); await s.refresh()
  expect(s.sources().map((source) => source.plainText)).toEqual([
    "First Alpha #224 ✓", command, "Last Alpha #224 ✓", "Nested Alpha #224 ✓",
  ])
  expect(protectedHandle.ready()).toBeTrue()
  expect(protectedHandle.owns(protectedSource)).toBeFalse()
  expect(protectedHandle.urls()).toEqual([])
  expect(s.copyAll(protectedSource)).toBe(command)
  expect(s.md.content).toBe(original)
}, 15000)

test("mixed protected and compact destinations survive a fallback strip anchor and status refresh", async () => {
  const command = `gh pr view ${destination}`
  const original = `界 Use \`${command}\` then Alpha PR #224 (${url}).`
  const s = await setup(original, 38)
  const source = s.sources()[0]!
  sourceBlock(source)
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  expect(handle.ready()).toBeTrue()
  expect(handle.urls()).toEqual([url])
  expect(source.plainText).toBe(`界 Use ${command} then Alpha #224 ◆✕.`)
  const measure = TextBuffer.create(s.renderer.widthMethod)
  try {
    measure.setText(`界 Use ${command} then `)
    expect(handle.compactRanges()).toEqual([{ start: measure.length, end: measure.length + 13, url }])
    expect(selected(source, measure.length, measure.length + 13)).toBe(`Alpha PR #224 (${url})`)
  } finally { measure.destroy() }
  attachBadgeStrip(s.renderer, sourceBlock(source), [{ url: destination, label: "alpha#224 ◆ ✕" }],
    (value) => { throw new Error(value.detail) })
  s.status([{ text: "✓", color: "success" }])
  const pending = handle.refresh()
  expect(handle.ready()).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(s.copyAll(source)).toBe(`界 Use ${command} then Alpha PR #224 (${url}).`)
  await pending; await s.draw()
  expect(handle.ready()).toBeTrue()
  expect(handle.owns(source)).toBeTrue()
  expect(handle.urls()).toEqual([url])
  expect(source.plainText).toBe(`界 Use ${command} then Alpha #224 ✓.`)
  expect(s.copyAll(source)).toBe(`界 Use ${command} then Alpha PR #224 (${url}).`)
  expect(s.md.content).toBe(original)
}, 15000)

test("similar anchor prefixes do not make arbitrary wrapper boxes into native prose slots", async () => {
  const s = await setup(url)
  const source = s.sources()[0]!
  const parent = source.parent!
  const wrapper = new BoxRenderable(s.renderer, { id: `acq-pr-anchor-${source.num + 1}` })
  parent.add(wrapper, 0)
  wrapper.add(source)
  expect(installCompactProse(source, s.options)).toBeNull()
  await s.draw()
  expect(source.plainText).toBe(url)
  expect(s.md.content).toBe(url)
}, 15000)

test("a refresh queued during same-label streaming keeps copy matched to the native committed destination", async () => {
  const s = await setup(url)
  const source = s.sources()[0]!
  const native = source.onChunks!
  let pause = false
  let release: () => void = () => { throw new Error("Gate not initialized") }
  const gate = new Promise<void>((resolve) => { release = resolve })
  source.onChunks = async (chunks, context) => {
    if (pause) await gate
    return native(chunks, context)
  }
  s.sync(); await s.draw()
  const handle = s.handles.get(source)!
  pause = true
  source.drawUnstyledText = false
  source.content = destination
  source.requestRender()
  await s.renderOnce()
  const pendingRefresh = handle.refresh()
  try {
    expect(handle.ready()).toBeFalse()
    expect(selected(source, 0, 13)).toBe(url)
  } finally { release() }
  await pendingRefresh
  // Native new content has landed, but the queued status refresh needs a frame.
  expect(source.plainText).toBe("Alpha #224 ◆✕")
  expect(handle.ready()).toBeFalse()
  expect(handle.urls()).toEqual([])
  expect(selected(source, 0, 13)).toBe(destination)
  await s.draw()
  expect(handle.ready()).toBeTrue()
  expect(handle.urls()).toEqual([destination])
  expect(selected(source, 0, 13)).toBe(destination)
}, 15000)

test("code used as a native link label and images stay native, without partial destination compaction", async () => {
  const command = `gh pr view ${url}`
  const original = `[\`${command}\`](${destination}) ![Alpha PR #224](${url})`
  const s = await setup(original)
  await s.draw()
  const source = s.sources()[0]!
  const before = source.plainText
  const copy = s.copyAll(source)
  s.renderer.clearSelection()
  s.sync(); await s.draw()
  expect(source.plainText).toBe(before)
  expect(s.copyAll(source)).toBe(copy)
  expect(s.handles.get(source)!.owns(source)).toBeFalse()
}, 15000)

test("native conceal-off mode compacts the complete Markdown link while copying original visible syntax", async () => {
  const original = `Before [Custom label](${destination}) then \`gh pr view ${url}\`.`
  const s = await setup(original)
  s.md.conceal = false
  // Native refreshStyles replaces child sources when conceal mode changes.
  await s.draw()
  s.sync(); await s.draw()
  const source = s.sources()[0]!
  expect(source.plainText).toBe(`Before Alpha #224 ◆✕ then \`gh pr view ${url}\`.`)
  expect(s.copyAll(source)).toBe(original)
  expect(s.md.content).toBe(original)
}, 15000)
