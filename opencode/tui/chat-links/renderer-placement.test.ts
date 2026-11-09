/** Bundle with --packages=external into the pinned OpenTUI 0.4.5 scratch harness. */
import { afterEach, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { BoxRenderable, CodeRenderable, MarkdownRenderable, RGBA, ScrollBoxRenderable, SyntaxStyle,
  TextRenderable, TreeSitterClient, type CliRenderer, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { installChatLinks } from "./plugin"
import { attachBadgeStrip, nativeLinks, PR_STRIP_PREFIX, sourceBlock, textSources } from "./renderer"

const url = "https://github.com/octo-org-sample/alpha/pull/224"
const demo = `## Chat links demo

### Markdown links — [Alpha PR #224](${url})

- [OpenCode documentation](https://opencode.ai/docs/)
- [Alpha PR #224](${url})

Hover the PR link to inspect its current status and CI checks. This paragraph follows the list.

### Code block

\`\`\`text
${url}
\`\`\`

Does the PR status strip appear, and does the hover tooltip work?`
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

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)]
}
async function setup(content = demo) {
  const s = await createTestRenderer({ width: 80, height: 24, useMouse: true })
  renderers.push(s.renderer)
  const client = new TreeSitterClient({ dataPath: join(dirname(import.meta.path), "parser-cache") })
  clients.push(client)
  await client.initialize()
  const style = SyntaxStyle.fromStyles({ "markup.link": { fg: RGBA.fromHex("#00ffff") },
    "markup.link.label": { fg: RGBA.fromHex("#00ffff") }, "markup.link.url": { fg: RGBA.fromHex("#00ffff") } })
  styles.push(style)
  const scroll = new ScrollBoxRenderable(s.renderer, { id: "real-chat-viewport", height: 16, width: 80 })
  const spacer = new BoxRenderable(s.renderer, { id: "user-message-space", height: 5, flexShrink: 0 })
  const parent = new BoxRenderable(s.renderer, { id: "real-text-part", paddingLeft: 5, flexShrink: 0 })
  const md = new MarkdownRenderable(s.renderer, { id: "demo-md", syntaxStyle: style, treeSitterClient: client,
    streaming: true, internalBlockMode: "top-level", conceal: true, content })
  parent.add(md)
  scroll.add(spacer)
  scroll.add(parent)
  s.renderer.root.add(scroll)
  const draw = async () => {
    for (const source of textSources(md)) if (source instanceof CodeRenderable) await source.highlightingDone
    for (let frame = 0; frame < 6; frame++) {
      await s.renderOnce()
      for (const source of textSources(md)) if (source instanceof CodeRenderable) await source.highlightingDone
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    }
  }
  const sdk = createOpencodeClient({ baseUrl: "https://test.invalid", fetch: Object.assign(async () => Response.json(true),
    { preconnect: globalThis.fetch.preconnect }) })
  const color = RGBA.fromHex("#eeeeee")
  const install = () => {
    const controller = installChatLinks({ app: { version: "1.18.34" }, renderer: s.renderer,
      theme: { current: { primary: color, text: color, textMuted: color, success: color, error: color, warning: color,
        backgroundPanel: RGBA.fromHex("#202632"), border: color } },
      ui: { toast: (value) => { throw new Error(JSON.stringify(value)) } }, client: { app: sdk.app },
    }, { client: { fetch: async target => ({ ok: true, value: { target, url: target.canonicalUrl,
      title: "Synthetic fixture", lifecycle: "merged", ci: "failed", ciReason: null,
      checks: [{ name: "test", outcome: "failed", url: null }] } }) } })
    disposers.push(controller.dispose)
  }
  const strips = () => descendants(md).filter((node): node is TextRenderable => node instanceof TextRenderable && node.id.startsWith(PR_STRIP_PREFIX))
  return { ...s, md, parent, scroll, draw, install, strips }
}

test("real demo list PR is an inline chip in the partial viewport; the code URL alone retains a strip", async () => {
  const s = await setup()
  s.install()
  await s.draw()
  s.scroll.scrollTop = 0
  await s.draw()
  const pr = textSources(s.md).find(source => source.plainText === "Alpha #224 ◆✕")!
  expect(pr).toBeDefined()
  expect(s.strips().some(node => node.id === `${PR_STRIP_PREFIX}-${pr.num}`)).toBeFalse()
  expect(pr.screenY + pr.height).toBeLessThanOrEqual(16)
  expect(s.captureCharFrame()).toContain("Alpha #224 ◆✕")
  expect(pr instanceof CodeRenderable && pr.content).toBe(`[Alpha PR #224](${url})`)
  const links = nativeLinks()!
  const x = Array.from({ length: pr.width }, (_, offset) => pr.screenX + offset).find(x => {
    const id = links.attributesGetLinkId(s.renderer.currentRenderBuffer.buffers.attributes[pr.screenY * s.renderer.width + x])
    return id !== 0 && links.linkGetUrl(id, 512) === url
  })!
  expect(x).toBeDefined()
  await s.mockMouse.moveTo(x, pr.screenY)
  await s.draw()
  expect(s.captureCharFrame()).toContain("octo-org-sample/alpha #224")
  expect(s.captureCharFrame()).toContain("Alpha #224 ◆✕")
  expect(s.md.content).toBe(demo)
  await s.mockMouse.moveTo(79, 23)
  s.scroll.scrollTop = s.scroll.scrollHeight
  await s.draw()
  const code = textSources(s.md).find(source => source instanceof CodeRenderable && source.content.trim() === url)!
  expect(code.plainText).toBe(url)
  expect(s.strips()).toHaveLength(1)
  const strip = s.strips()[0]!
  expect(strip.id).toBe(`${PR_STRIP_PREFIX}-${code.num}`)
  expect(strip.screenY).toBe(code.screenY + code.height)
  s.renderer.startSelection(code, code.screenX, code.screenY)
  s.renderer.updateSelection(code, code.screenX + code.width, code.screenY + code.height - 1, { finishDragging: true })
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(url)
}, 15000)

test("native Markdown streaming keeps block ordering and accounts for every adjacent sibling", async () => {
  const s = await setup()
  s.install()
  await s.draw()
  s.scroll.scrollTop = s.scroll.scrollHeight
  await s.draw()
  expect(s.strips()).toHaveLength(1)
  expect(textSources(s.md).filter(source => source.plainText.includes("Alpha #224 ◆✕"))).toHaveLength(2)
  const initialSources = textSources(s.md).map(source => source.plainText)
  const initialContent = textSources(s.md).filter((source): source is CodeRenderable => source instanceof CodeRenderable)
    .map(source => source.content)
  for (let index = 1; index <= 6; index++) {
    s.md.content = demo + "\n\n" + Array.from({ length: index }, (_, i) => `Streaming paragraph ${i + 1}.`).join("\n\n")
    await s.draw()
    const sources = textSources(s.md)
    expect(sources.slice(0, initialSources.length).map(source => source.plainText)).toEqual(initialSources)
    expect(sources.at(-1)!.plainText).toBe(`Streaming paragraph ${index}.`)
    expect(s.strips()).toHaveLength(1)
    expect(sources.filter(source => source.plainText.includes("Alpha #224 ◆✕"))).toHaveLength(2)
    expect(sources.filter((source): source is CodeRenderable => source instanceof CodeRenderable)
      .slice(0, initialContent.length).map(source => source.content)).toEqual(initialContent)
    for (const strip of s.strips()) {
      const siblings = strip.parent!.getChildren()
      const anchor = siblings[siblings.indexOf(strip) - 1]
      expect(anchor).toBeInstanceOf(CodeRenderable)
      expect(strip.id).toBe(`${PR_STRIP_PREFIX}-${anchor.num}`)
      expect(strip.selectable).toBeFalse()
      expect(strip.height).toBe(1)
    }
  }
  // Exercise nested list-child replacement, token-type replacement and removal.
  for (const [content, count, chips] of [[demo.replace("Alpha PR #224", "Updated Alpha PR #224"), 1, 2],
    [`Paragraph ${url}\n\nsecond paragraph`, 0, 1], [`\`\`\`text\n${url}\n\`\`\``, 1, 0], ["No links remain.", 0, 0]] as const) {
    s.md.content = content
    await s.draw()
    expect(s.md.content).toBe(content)
    expect(s.strips()).toHaveLength(count)
    expect(textSources(s.md).filter(source => source.plainText.includes("Alpha #224 ◆✕"))).toHaveLength(chips)
  }
}, 15000)

test("standalone nearby code strip preserves original sources and native selection callbacks", async () => {
  const s = await setup(`Original ${url}\n\nsecond paragraph\n\n\`\`\`text\n${url}\n\`\`\`\n\nlast paragraph`)
  await s.draw()
  const sources = textSources(s.md)
  const first = sources[0]
  const code = sources.find(node => node instanceof CodeRenderable && node.content.trim() === url)!
  expect(code).toBeDefined()
  const last = sources.at(-1)!
  s.renderer.startSelection(first, first.screenX, first.screenY)
  s.renderer.updateSelection(last, last.screenX + last.width - 1, last.screenY, { finishDragging: true })
  const original = s.renderer.getSelection()!.getSelectedText()
  const strip = attachBadgeStrip(s.renderer, sourceBlock(code), [{ url, label: "alpha#224 ◆ ✕" }],
    diagnostic => { throw new Error(diagnostic.detail) })!
  await s.draw()
  expect(strip.screenY).toBe(code.screenY + code.height)
  expect(strip.parent).toBe(code.parent)
  expect(textSources(s.md)).toEqual(sources)
  expect(s.renderer.getSelection()!.getSelectedText()).toBe(original)
  expect(original).not.toContain("alpha#224")
  const parent = strip.parent!
  code.destroy()
  expect(strip.isDestroyed).toBeTrue()
  expect(parent.isDestroyed).toBeTrue()
}, 15000)
