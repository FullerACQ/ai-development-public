import { afterEach, expect, jest, mock, spyOn, test } from "bun:test"
import { BoxRenderable, RGBA, Renderable, RenderableEvents, StyledText, TextRenderable, type CliRenderer, type TextChunk } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { VISIBLE_REFRESH_INTERVAL_MS } from "./cache"
import { createHttpUrlOpener, type OpenHttpUrlError, type OpenHttpUrlResult, type UrlExecutor } from "./click"
import type { GitHubPrClient, GitHubPrResult, GitHubPrStatus, GitHubPrTarget } from "./github"
import { installChatLinks, type ChatLinksApi, type ChatLinksOptions } from "./plugin"
import { nativeLinks, PR_STRIP_PREFIX } from "./renderer"

const epoch = Date.UTC(2026, 9, 8, 12, 34, 56)
const first: GitHubPrTarget = {
  owner: "octo-org-sample", repo: "alpha", number: 123,
  canonicalUrl: "https://github.com/octo-org-sample/alpha/pull/123",
}
const second: GitHubPrTarget = {
  owner: "octo-org-sample", repo: "gammaray", number: 123,
  canonicalUrl: "https://github.com/octo-org-sample/gammaray/pull/123",
}
const third: GitHubPrTarget = {
  owner: "another-org", repo: "alpha", number: 123,
  canonicalUrl: "https://github.com/another-org/alpha/pull/123",
}
const fourth: GitHubPrTarget = {
  ...first, number: 124, canonicalUrl: "https://github.com/octo-org-sample/alpha/pull/124",
}
const theme: ChatLinksApi["theme"]["current"] = {
  primary: RGBA.fromHex("#44bbff"),
  text: RGBA.fromHex("#eeeeee"), textMuted: RGBA.fromHex("#8899aa"),
  success: RGBA.fromHex("#11cc33"), error: RGBA.fromHex("#ee2244"), warning: RGBA.fromHex("#ffbb22"),
  backgroundPanel: RGBA.fromHex("#202632"), border: RGBA.fromHex("#7d8799"),
}
const renderers: CliRenderer[] = []
const controllers: ReturnType<typeof installChatLinks>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  jest.useRealTimers()
  mock.restore()
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

async function setup(dimensions?: Readonly<{ width: number; height: number }>) {
  // FALLBACK: ordinary fixtures use 160x24; capacity and clipping regressions specify their own viewport.
  const viewport = dimensions ?? { width: 160, height: 24 }
  const setup = await createTestRenderer({ ...viewport, useMouse: true })
  renderers.push(setup.renderer)
  const toast = mock<ChatLinksApi["ui"]["toast"]>(() => {})
  // Stub the SDK transport so app.log retains its generic RequestResult type.
  const log = mock(async (_request: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json(true))
  const client = createOpencodeClient({
    baseUrl: "https://opencode.example.org", fetch: Object.assign(log, { preconnect: globalThis.fetch.preconnect }),
  })
  const api: ChatLinksApi = {
    app: { version: "1.18.34" }, renderer: setup.renderer,
    theme: { current: theme }, ui: { toast }, client: { app: client.app },
  }
  const clock = { now: epoch }
  return {
    ...setup, clock, toast, log,
    install(client: GitHubPrClient, activation?: ChatLinksOptions["activation"]) {
      const controller = installChatLinks(api, { client, now: () => clock.now, activation })
      controllers.push(controller)
      return controller
    },
  }
}
type Setup = Awaited<ReturnType<typeof setup>>
type Activation = NonNullable<ChatLinksOptions["activation"]>

function success(target: GitHubPrTarget, lifecycle: GitHubPrStatus["lifecycle"], ci: GitHubPrStatus["ci"]): GitHubPrResult {
  return {
    ok: true,
    value: {
      target, url: target.canonicalUrl, title: "Keep chat text copyable", lifecycle, ci, ciReason: null,
      checks: ci === "failed" ? [
        { name: "typecheck", outcome: "passed", url: null },
        { name: "integration tests", outcome: "failed", url: "https://ci.example.org/integration" },
        { name: "lint", outcome: "failed", url: null },
      ] : [{ name: "typecheck", outcome: ci, url: null }],
    },
  }
}
function source(s: Setup, content: string | StyledText, id: string): TextRenderable {
  const node = new TextRenderable(s.renderer, { id, content, wrapMode: "none", flexShrink: 0 })
  s.renderer.root.add(node)
  return node
}
function strips(parent: Renderable): TextRenderable[] {
  return parent.getChildren().filter((node): node is TextRenderable => node instanceof TextRenderable && node.id.startsWith(PR_STRIP_PREFIX))
}
function stripFor(node: Renderable): TextRenderable {
  if (node.parent === null) throw new Error(`Source ${node.id} is detached`)
  const strip = strips(node.parent).find((strip) => strip.id === `${PR_STRIP_PREFIX}-${node.num}`)
  if (strip === undefined) throw new Error(`No attached status strip for ${node.id}`)
  return strip
}
function tooltip(s: Setup): TextRenderable {
  const box = s.renderer.root.getChildren().find((node) => node.id === "acq-chat-links-tooltip")
  if (box === undefined) throw new Error("Tooltip overlay is missing")
  const text = box.getChildren().find((node): node is TextRenderable => node instanceof TextRenderable)
  if (text === undefined) throw new Error("Tooltip text is missing")
  return text
}
function linkAt(s: Setup, x: number, y: number): string | null {
  const links = nativeLinks()
  if (links === null) throw new Error("OpenTUI 0.4.5 native link API is missing")
  const id = links.attributesGetLinkId(s.renderer.currentRenderBuffer.buffers.attributes[y * s.renderer.width + x])
  return id === 0 ? null : links.linkGetUrl(id, 512)
}
// The injected client resolves without I/O; drain the cache's chained promise
// callbacks before asking the real renderer to draw the updated native buffers.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
}
async function draw(s: Setup): Promise<void> {
  await s.renderOnce()
  await settle()
  await s.renderOnce()
}
function healthy(s: Setup): void {
  expect(s.toast).not.toHaveBeenCalled()
  expect(s.log).not.toHaveBeenCalled()
}

function actionSource(s: Setup, content: string, id: string) {
  const parent = new BoxRenderable(s.renderer, { id: `${id}-actions`, width: "100%", flexDirection: "column", flexShrink: 0 })
  const mouseUp = mock(() => {})
  parent.onMouseUp = mouseUp
  const message = new TextRenderable(s.renderer, { id, content, wrapMode: "none", flexShrink: 0 })
  parent.add(message)
  s.renderer.root.add(parent)
  return { message, parent, mouseUp }
}
function sgr(button: 0 | 1 | 2 | 32 | 35 | 64, x: number, y: number, edge: "M" | "m"): string {
  return `\x1b[<${button};${x + 1};${y + 1}${edge}`
}
function wire(s: Setup, bytes: string): void {
  // Exercise OpenTUI's real SGR parser and dispatch; never call plugin callbacks directly.
  s.renderer.stdin.emit("data", Buffer.from(bytes))
}

test("Cmd-click opens the original full PR URL once before parent actions; identical plain input preserves selection", async () => {
  const s = await setup()
  const url = `${first.canonicalUrl}/files?diff=split#fragment`
  const { message, mouseUp } = actionSource(s, url, "command-original-url")
  const command = { pressed: true }
  const commandPressed = mock<Activation["commandPressed"]>(() => command.pressed)
  const openHttpUrl = mock<Activation["openHttpUrl"]>(async () => ({ ok: true, value: undefined }))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch }, { commandPressed, openHttpUrl })
  await draw(s)
  expect(linkAt(s, 2, message.screenY)).toBe(url)
  const bytes = sgr(0, 2, message.screenY, "M") + sgr(0, 2, message.screenY, "m")
  wire(s, bytes)
  await settle()
  expect(openHttpUrl.mock.calls.map(([destination]) => destination)).toEqual([url])
  expect(commandPressed).toHaveBeenCalledTimes(2)
  expect(mouseUp).not.toHaveBeenCalled()
  expect(s.renderer.getSelection()).toBeNull()
  command.pressed = false
  wire(s, bytes)
  await settle()
  expect(openHttpUrl).toHaveBeenCalledTimes(1)
  expect(mouseUp).toHaveBeenCalledTimes(1)
  s.renderer.clearSelection()
  const strip = stripFor(message)
  await s.mockMouse.drag(0, message.screenY, s.renderer.width - 1, strip.screenY, 0, { delayMs: 0 })
  const selection = s.renderer.getSelection()
  if (selection === null) throw new Error("Ordinary mouse drag did not select the original PR URL")
  expect(selection.getSelectedText()).toBe(url)
  expect(message.plainText).toBe(url)
  expect(strip.selectable).toBeFalse()
  expect(mouseUp).toHaveBeenCalledTimes(2)
  expect(openHttpUrl).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("Cmd-click opens ordinary HTTP documentation without fetching PR metadata, including fragmented SGR input", async () => {
  const s = await setup()
  const url = "http://docs.example.org/guide?format=plain#setup"
  const { message, mouseUp } = actionSource(s, url, "command-http-docs")
  const openHttpUrl = mock<Activation["openHttpUrl"]>(async () => ({ ok: true, value: undefined }))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch }, { commandPressed: () => true, openHttpUrl })
  await draw(s)
  expect(linkAt(s, 2, message.screenY)).toBe(url)
  const bytes = sgr(0, 2, message.screenY, "M") + sgr(0, 2, message.screenY, "m")
  wire(s, bytes.slice(0, 8))
  expect(openHttpUrl).not.toHaveBeenCalled()
  wire(s, bytes.slice(8, -1))
  expect(openHttpUrl).not.toHaveBeenCalled()
  wire(s, bytes.slice(-1))
  await settle()
  expect(openHttpUrl.mock.calls.map(([destination]) => destination)).toEqual([url])
  expect(fetch).not.toHaveBeenCalled()
  expect(strips(s.renderer.root)).toHaveLength(0)
  expect(mouseUp).not.toHaveBeenCalled()
  expect(s.renderer.getSelection()).toBeNull()
  healthy(s)
})

test("Cmd-click on a PR strip opens its canonical destination rather than the original files URL", async () => {
  const s = await setup()
  const url = `${first.canonicalUrl}/files?diff=split#fragment`
  const { message, mouseUp } = actionSource(s, url, "command-strip")
  const openHttpUrl = mock<Activation["openHttpUrl"]>(async () => ({ ok: true, value: undefined }))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch }, { commandPressed: () => true, openHttpUrl })
  await draw(s)
  const strip = stripFor(message)
  expect(linkAt(s, 10, strip.screenY)).toBe(first.canonicalUrl)
  wire(s, sgr(0, 10, strip.screenY, "M") + sgr(0, 10, strip.screenY, "m"))
  await settle()
  expect(openHttpUrl.mock.calls.map(([destination]) => destination)).toEqual([first.canonicalUrl])
  expect(message.plainText).toBe(url)
  expect(mouseUp).not.toHaveBeenCalled()
  expect(s.renderer.getSelection()).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test.each([
  { name: "Cmd only at release", down: false, up: true, parentUps: 1 },
  { name: "Cmd released before mouse-up", down: true, up: false, parentUps: 0 },
])("activation rejects $name through the native parser", async ({ down, up, parentUps }) => {
  const s = await setup()
  const { message, mouseUp } = actionSource(s, "https://docs.example.org/guide", "command-edges")
  const command = { pressed: down }
  const openHttpUrl = mock<Activation["openHttpUrl"]>(async () => ({ ok: true, value: undefined }))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch }, { commandPressed: () => command.pressed, openHttpUrl })
  await draw(s)
  wire(s, sgr(0, 2, message.screenY, "M"))
  command.pressed = up
  wire(s, sgr(0, 2, message.screenY, "m"))
  await settle()
  expect(openHttpUrl).not.toHaveBeenCalled()
  expect(mouseUp).toHaveBeenCalledTimes(parentUps)
  healthy(s)
})

test.each([
  { name: "wheel without a press", events: sgr(64, 2, 0, "M") },
  { name: "wheel during an owned press", events: sgr(0, 2, 0, "M") + sgr(64, 2, 0, "M") + sgr(0, 2, 0, "m") },
  { name: "one-cell native drag", events: sgr(0, 2, 0, "M") + sgr(32, 3, 0, "M") + sgr(0, 3, 0, "m") },
  { name: "drag returning to its original cell", events: sgr(0, 2, 0, "M") + sgr(32, 12, 0, "M") + sgr(35, 2, 0, "M") + sgr(0, 2, 0, "m") },
  { name: "middle button", events: sgr(1, 2, 0, "M") + sgr(1, 2, 0, "m") },
  { name: "right button", events: sgr(2, 2, 0, "M") + sgr(2, 2, 0, "m") },
  { name: "secondary button interrupting a left press", events: sgr(0, 2, 0, "M") + sgr(2, 2, 0, "M") + sgr(2, 2, 0, "m") + sgr(0, 2, 0, "m") },
])("$name never reaches the injected opener", async ({ events }) => {
  const s = await setup()
  const { message } = actionSource(s, "https://docs.example.org/guide", "command-rejected-gesture")
  const openHttpUrl = mock<Activation["openHttpUrl"]>(async () => ({ ok: true, value: undefined }))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch }, { commandPressed: () => true, openHttpUrl })
  await draw(s)
  expect(message.screenY).toBe(0)
  expect(linkAt(s, 2, 0)).toBe("https://docs.example.org/guide")
  wire(s, events)
  await settle()
  expect(openHttpUrl).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  healthy(s)
})

const openerFailures: readonly Readonly<{
  code: "ENOENT" | "EACCES" | "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  kind: OpenHttpUrlError["kind"]
  message: string
}>[] = [
  { code: "ENOENT", kind: "missing-opener", message: "The macOS URL opener is unavailable." },
  { code: "EACCES", kind: "open-failed", message: "The macOS URL opener failed." },
  { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", kind: "output-limit", message: "URL opener output exceeded the size limit." },
]
test.each([...openerFailures])("$kind produces a safe Open link toast and a URL-free SDK log", async ({ code, kind, message: expectedMessage }) => {
  const s = await setup()
  const url = `${first.canonicalUrl}/files?diff=split&token=SHOULD_NOT_LOG#fragment`
  const { message, mouseUp } = actionSource(s, url, "command-opener-failure")
  const execute = mock<UrlExecutor>(async () => {
    throw { code, message: `cannot open ${url}\x1b[31m`, stderr: "token=SHOULD_NOT_LOG\x07" }
  })
  // Exercise the real error-result/sanitization boundary without spawning an OS opener.
  const opener = createHttpUrlOpener({ platform: "darwin", execute })
  const openHttpUrl = mock<Activation["openHttpUrl"]>((raw, signal) => opener.openHttpUrl(raw, signal))
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  try {
    s.install({ fetch }, { commandPressed: () => true, openHttpUrl })
    await draw(s)
    wire(s, sgr(0, 2, message.screenY, "M") + sgr(0, 2, message.screenY, "m"))
    await settle()
    expect(openHttpUrl.mock.calls.map(([destination]) => destination)).toEqual([url])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe("/usr/bin/open")
    expect(execute.mock.calls[0][1]).toEqual([url])
    expect(s.toast.mock.calls.map(([value]) => value)).toEqual([
      { variant: "error", title: "Open link", message: expectedMessage },
    ])
    expect(s.log).toHaveBeenCalledTimes(1)
    const request = s.log.mock.calls[0][0]
    if (!(request instanceof Request)) throw new Error("SDK logging did not submit a Request")
    const payload: unknown = await request.json()
    expect(payload).toEqual({ service: "acq.chat-links", level: "warn", message: "Link opening failed", extra: { kind } })
    expect(JSON.stringify(payload)).not.toMatch(/SHOULD_NOT_LOG|token=|diff=|https?:|[\u0000-\u001f\u007f-\u009f]/u)
    expect(expectedMessage).not.toMatch(/SHOULD_NOT_LOG|token=|https?:|[\u0000-\u001f\u007f-\u009f]/u)
    expect(mouseUp).not.toHaveBeenCalled()
  } finally {
    opener.dispose()
  }
})

test.each(["failed result", "rejection"] as const)(
  "disposing a pending URL open suppresses its late %s and restores native dispatch/hooks", async (completion) => {
    const s = await setup()
    const { message, mouseUp } = actionSource(s, "https://docs.example.org/guide?token=SHOULD_NOT_LOG", "command-dispose")
    const pending = Promise.withResolvers<OpenHttpUrlResult>()
    const openHttpUrl = mock<Activation["openHttpUrl"]>(() => pending.promise)
    const commandPressed = mock<Activation["commandPressed"]>(() => true)
    const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
    const key = "processSingleMouseEvent"
    const dispatch: unknown = Reflect.get(s.renderer, key)
    const descriptor = Object.getOwnPropertyDescriptor(s.renderer, key)
    const before = {
      frame: s.renderer.listenerCount("frame"), blur: s.renderer.listenerCount("blur"),
      destroy: s.renderer.listenerCount("destroy"), input: s.renderer.stdin.listenerCount("data"),
    }
    const controller = s.install({ fetch }, { commandPressed, openHttpUrl })
    await draw(s)
    expect(Reflect.get(s.renderer, key)).not.toBe(dispatch)
    const bytes = sgr(0, 2, message.screenY, "M") + sgr(0, 2, message.screenY, "m")
    wire(s, bytes)
    expect(openHttpUrl).toHaveBeenCalledTimes(1)
    expect(mouseUp).not.toHaveBeenCalled()
    controller.dispose()
    controller.dispose()
    expect(Reflect.get(s.renderer, key)).toBe(dispatch)
    expect(Object.getOwnPropertyDescriptor(s.renderer, key)).toEqual(descriptor)
    expect(s.renderer.listenerCount("frame")).toBe(before.frame)
    expect(s.renderer.listenerCount("blur")).toBe(before.blur)
    expect(s.renderer.listenerCount("destroy")).toBe(before.destroy)
    expect(s.renderer.stdin.listenerCount("data")).toBe(before.input)
    if (completion === "failed result") pending.resolve({ ok: false, error: { kind: "aborted", message: "Link opening was cancelled." } })
    else pending.reject(new TypeError("Injected URL opener crashed"))
    await settle()
    healthy(s)
    const modifierReads = commandPressed.mock.calls.length
    await draw(s)
    wire(s, bytes)
    await settle()
    expect(openHttpUrl).toHaveBeenCalledTimes(1)
    expect(commandPressed).toHaveBeenCalledTimes(modifierReads)
    expect(mouseUp).toHaveBeenCalledTimes(1)
    expect(message.plainText).toBe("https://docs.example.org/guide?token=SHOULD_NOT_LOG")
    healthy(s)
  },
)

test("first visible URL fetches once, including frames while its request is pending", async () => {
  const s = await setup()
  const pending = Promise.withResolvers<GitHubPrResult>()
  const fetch = mock<GitHubPrClient["fetch"]>(() => pending.promise)
  const message = source(s, first.canonicalUrl, "first-sight")
  s.install({ fetch })
  for (let frame = 0; frame < 4; frame++) await s.renderOnce()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toEqual(first)
  expect(stripFor(message).plainText).toBe("alpha#123 ?")
  pending.resolve(success(first, "draft", "failed"))
  await settle()
  await draw(s)
  for (let frame = 0; frame < 4; frame++) await s.renderOnce()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(stripFor(message).plainText).toBe("alpha#123 ◇ ✕")
  healthy(s)
})

test("hidden sources and ordinary URLs do not fetch metadata until a PR becomes visible", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "initially-hidden")
  message.visible = false
  source(s, "https://example.org https://github.com/octo-org-sample/alpha/issues/123", "ordinary-links")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  expect(fetch).not.toHaveBeenCalled()
  expect(strips(s.renderer.root)).toHaveLength(0)
  message.visible = true
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(stripFor(message).plainText).toBe("alpha#123 ◇ ✕")
  healthy(s)
})

test("draft and failed symbols are colored, attached, linked and excluded from multiline copy", async () => {
  const s = await setup()
  const originalUrl = `${first.canonicalUrl}/files#diff-123`
  const command = `gh pr view ${originalUrl}\nbun run typecheck\nbun test ./chat-links`
  const message = source(s, command, "multiline-command")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  expect(strip.screenY).toBe(message.screenY + message.height)
  expect(strip.selectable).toBeFalse()
  expect(strip.plainText).toBe("alpha#123 ◇ ✕")
  expect(s.captureCharFrame()).toContain("alpha#123 ◇ ✕")
  const spans = s.captureSpans().lines[strip.screenY].spans
  const draft = spans.find((span) => span.text.includes("◇"))
  const failed = spans.find((span) => span.text.includes("✕"))
  if (draft === undefined || failed === undefined) throw new Error("Rendered lifecycle/CI symbols are missing")
  expect(draft.fg).toEqual(theme.textMuted)
  expect(failed.fg).toEqual(theme.error)
  expect(linkAt(s, 11, message.screenY)).toBe(originalUrl)
  for (let x = 0; x < strip.plainText.length; x++) expect(linkAt(s, x, strip.screenY)).toBe(first.canonicalUrl)
  await s.mockMouse.drag(0, message.screenY, s.renderer.width - 1, strip.screenY, 0, { delayMs: 0 })
  const selection = s.renderer.getSelection()
  if (selection === null) throw new Error("Mouse drag did not select the command")
  expect(selection.getSelectedText()).toBe(command)
  expect(message.plainText).toBe(command)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("original PR link and strip both hover with failing names, counts and last-fetch time", async () => {
  const s = await setup()
  const originalUrl = `${first.canonicalUrl}/checks?check=42`
  const message = source(s, originalUrl, "hover-details")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  const expectedDetails = [
    "octo-org-sample/alpha #123", "Draft · CI failing", "1 passed · 2 failed · 0 pending · 0 skipped/neutral",
    "✕ integration tests", "✕ lint", `Last fetched: ${new Date(epoch).toLocaleString()}`,
  ]
  await s.mockMouse.moveTo(3, message.screenY)
  await draw(s)
  for (const detail of expectedDetails) expect(s.captureCharFrame()).toContain(detail)
  expect(tooltip(s).selectable).toBeFalse()
  await s.mockMouse.moveTo(s.renderer.width - 1, s.renderer.height - 1)
  await draw(s)
  expect(s.captureCharFrame()).not.toContain("✕ integration tests")
  expect(linkAt(s, 2, strip.screenY)).toBe(first.canonicalUrl)
  await s.mockMouse.moveTo(2, strip.screenY)
  await draw(s)
  for (const detail of expectedDetails) expect(s.captureCharFrame()).toContain(detail)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("hover refreshes on occurrence entry, not repeated movement after the throttle expires", async () => {
  const s = await setup()
  const message = source(s, `${first.canonicalUrl}   ${first.canonicalUrl}`, "repeated-hover")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(1)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(1, message.screenY)
  await settle()
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(7, message.screenY)
  await draw(s)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(15, message.screenY)
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  await s.mockMouse.moveTo(first.canonicalUrl.length + 4, message.screenY)
  await settle()
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(3)
  const strip = stripFor(message)
  expect(strip.plainText).toBe("alpha#123 ◇ ✕")
  await s.mockMouse.moveTo(s.renderer.width - 1, s.renderer.height - 1)
  await draw(s)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(1, strip.screenY)
  await settle()
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(4)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(10, strip.screenY)
  await draw(s)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(12, strip.screenY)
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(4)
  healthy(s)
})

test("an unavailable hover refresh clears stale success and shows its reason and previous fetch time", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "unavailable-refresh")
  const fetch = mock<GitHubPrClient["fetch"]>()
  fetch.mockResolvedValueOnce(success(first, "open", "passed"))
  fetch.mockResolvedValue({ ok: false, error: { kind: "authentication", message: "GitHub authentication expired" } })
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  expect(strip.plainText).toBe("alpha#123 ✓")
  const passing = s.captureSpans().lines[strip.screenY].spans.find((span) => span.text.includes("✓"))
  if (passing === undefined) throw new Error("Rendered passing symbol is missing")
  expect(passing.fg).toEqual(theme.success)
  s.clock.now += 3_000
  await s.mockMouse.moveTo(1, message.screenY)
  await settle()
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(strip.plainText).toBe("alpha#123 ?")
  expect(tooltip(s).plainText).toContain("Lifecycle unavailable · CI unavailable")
  expect(tooltip(s).plainText).toContain("GitHub authentication expired")
  expect(tooltip(s).plainText).toContain(`Last fetched: ${new Date(epoch).toLocaleString()}`)
  expect(s.captureCharFrame()).not.toContain("✓")
  expect(tooltip(s).plainText).not.toContain("CI passing")
  healthy(s)
})

test("multiple PRs and cross-repository occurrences share only their canonical cache entry", async () => {
  const s = await setup()
  const variant = "https://github.com/Octo-Org-Sample/Alpha/pull/00123/files#diff"
  const firstMessage = source(s, `${variant}\n${second.canonicalUrl}\n${third.canonicalUrl}\n${fourth.canonicalUrl}\n${first.canonicalUrl}`, "cross-repo")
  const repeatedMessage = source(s, new StyledText([
    { __isChunk: true, text: "same PR", link: { url: first.canonicalUrl } },
    { __isChunk: true, text: " and " },
    { __isChunk: true, text: "same number, other repo", link: { url: second.canonicalUrl } },
  ]), "native-labels")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  for (let frame = 0; frame < 5; frame++) await s.renderOnce()
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl).sort()).toEqual([
    first.canonicalUrl, second.canonicalUrl, third.canonicalUrl, fourth.canonicalUrl,
  ].sort())
  expect(stripFor(firstMessage).plainText).toBe("alpha#123 ◇ ✕   gammaray#123 ◇ ✕   alpha#123 ◇ ✕   alpha#124 ◇ ✕")
  expect(stripFor(repeatedMessage).plainText).toBe("alpha#123 ◇ ✕   gammaray#123 ◇ ✕")
  expect(linkAt(s, 0, firstMessage.screenY)).toBe(variant)
  expect(linkAt(s, 0, repeatedMessage.screenY)).toBe(first.canonicalUrl)
  expect(strips(s.renderer.root)).toHaveLength(2)
  healthy(s)
})

test("unchanged frames preserve strip identity/content and request no extra redraws", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "stable-frame")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  const content = strip.content
  const children = s.renderer.root.getChildren()
  const frame = s.captureCharFrame()
  const redraw = spyOn(s.renderer, "requestRender")
  for (let iteration = 0; iteration < 20; iteration++) await s.renderOnce()
  expect(redraw).not.toHaveBeenCalled()
  expect(stripFor(message)).toBe(strip)
  expect(strip.content).toBe(content)
  expect(s.renderer.root.getChildren()).toEqual(children)
  expect(s.captureCharFrame()).toBe(frame)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("unchanged hovered frames keep the tooltip stable without requesting more redraws", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "stable-hovered-frame")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  await s.mockMouse.moveTo(1, message.screenY)
  await draw(s)
  const text = tooltip(s)
  const content = text.content
  const frame = s.captureCharFrame()
  const redraw = spyOn(s.renderer, "requestRender")
  for (let iteration = 0; iteration < 20; iteration++) await s.renderOnce()
  expect(redraw).not.toHaveBeenCalled()
  expect(text.content).toBe(content)
  expect(s.captureCharFrame()).toBe(frame)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("streaming replacement removes old targets and links from the attached strip", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "stream-replace")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  message.content = second.canonicalUrl
  await draw(s)
  expect(stripFor(message)).toBe(strip)
  expect(strip.plainText).toBe("gammaray#123 ◇ ✕")
  expect(linkAt(s, 0, strip.screenY)).toBe(second.canonicalUrl)
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  expect(fetch.mock.calls.map(([target]) => target)).toEqual([first, second])
  healthy(s)
})

test("changing a native link destination with an unchanged label replaces the strip target and preserves copy", async () => {
  const s = await setup()
  const label = "Open pull request"
  const message = source(s, new StyledText([
    { __isChunk: true, text: label, link: { url: first.canonicalUrl } },
  ]), "same-label-new-destination")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  expect(strip.plainText).toBe("alpha#123 ◇ ✕")
  expect(linkAt(s, 0, message.screenY)).toBe(first.canonicalUrl)
  message.content = new StyledText([
    { __isChunk: true, text: label, link: { url: fourth.canonicalUrl } },
  ])
  await draw(s)
  expect(stripFor(message)).toBe(strip)
  expect(strip.plainText).toBe("alpha#124 ◇ ✕")
  expect(message.plainText).toBe(label)
  expect(linkAt(s, 0, message.screenY)).toBe(fourth.canonicalUrl)
  for (let x = 0; x < strip.plainText.length; x++) expect(linkAt(s, x, strip.screenY)).toBe(fourth.canonicalUrl)
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  await s.mockMouse.drag(0, message.screenY, s.renderer.width - 1, strip.screenY, 0, { delayMs: 0 })
  const selection = s.renderer.getSelection()
  if (selection === null) throw new Error("Mouse drag did not select the native link label")
  expect(selection.getSelectedText()).toBe(label)
  s.renderer.clearSelection()
  await draw(s)
  expect(fetch.mock.calls.map(([target]) => target)).toEqual([first, fourth])
  healthy(s)
})

test("257 simultaneously visible PRs remain cached across repeated native redraws", async () => {
  const s = await setup({ width: 160, height: 40 })
  const targets = Array.from({ length: 257 }, (_, index): GitHubPrTarget => ({
    owner: first.owner, repo: first.repo, number: index + 1,
    canonicalUrl: `https://github.com/${first.owner}/${first.repo}/pull/${index + 1}`,
  }))
  const chunks = targets.flatMap((target, index): TextChunk[] => [
    { __isChunk: true, text: String(target.number).padStart(3, "0"), link: { url: target.canonicalUrl } },
    { __isChunk: true, text: index === targets.length - 1 ? "" : (index + 1) % 32 === 0 ? "\n" : " " },
  ])
  const message = source(s, new StyledText(chunks), "over-cache-capacity")
  const original = message.plainText
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "open", "passed"))
  s.install({ fetch })
  await s.renderOnce()
  // The cache starts three requests at a time. Drain the finite 257-request
  // queue without redraws so subsequent frames actually exercise retained data.
  for (let batch = 0; batch < targets.length && fetch.mock.calls.length < targets.length; batch++) await settle()
  await settle()
  expect(fetch.mock.calls.map(([target]) => target.canonicalUrl)).toEqual(targets.map((target) => target.canonicalUrl))
  await draw(s)
  expect(message.height).toBe(9)
  for (const [index, target] of targets.entries()) {
    expect(linkAt(s, message.screenX + (index % 32) * 4, message.screenY + Math.floor(index / 32))).toBe(target.canonicalUrl)
  }
  const strip = stripFor(message)
  expect(strip.screenY + strip.height).toBeLessThanOrEqual(s.renderer.height)
  expect(strip.plainText.split("✓").length - 1).toBe(targets.length)
  expect(strip.plainText).not.toContain("?")
  const content = strip.content
  for (let frame = 0; frame < 20; frame++) {
    await s.renderOnce()
    await settle()
    expect(fetch).toHaveBeenCalledTimes(targets.length)
  }
  expect(strip.content).toBe(content)
  expect(message.plainText).toBe(original)
  healthy(s)
})

test("narrow clipped tooltips keep fetch time visible ahead of valid long failure names", async () => {
  const s = await setup({ width: 48, height: 14 })
  const message = source(s, new StyledText([
    { __isChunk: true, text: "Open PR", link: { url: first.canonicalUrl } },
  ]), "narrow-tooltip")
  const names = ["unit tests / ".repeat(14) + "Linux", "integration / ".repeat(13) + "Windows"]
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => ({
    ok: true,
    value: {
      target, url: target.canonicalUrl, title: "Keep chat text copyable", lifecycle: "draft", ci: "failed", ciReason: null,
      checks: names.map((name) => ({ name, outcome: "failed", url: null })),
    },
  }))
  s.install({ fetch })
  await draw(s)
  await s.mockMouse.moveTo(1, message.screenY)
  await draw(s)
  const fetched = `Last fetched: ${new Date(epoch).toLocaleString()}`
  expect(tooltip(s).plainText.split("\n").slice(0, 3)).toEqual([
    "octo-org-sample/alpha #123", "Draft · CI failing", fetched,
  ])
  expect(s.captureCharFrame()).toContain(fetched)
  expect(s.captureCharFrame()).toContain("✕ unit tests")
  expect(tooltip(s).plainText).toContain("rows not shown")
  expect(tooltip(s).plainText).not.toContain(names[1])
  expect(s.captureCharFrame()).not.toContain("CI passing")
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("streaming away the last PR URL removes the stale strip entirely", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "stream-remove")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  message.content = "Streaming answer now contains no pull-request links."
  await draw(s)
  expect(strips(s.renderer.root)).toHaveLength(0)
  expect(strip.isDestroyed).toBeTrue()
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("destroying the source releases its listener and status node immediately", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "destroy-source")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  const listeners = message.listenerCount(RenderableEvents.DESTROYED)
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  expect(message.listenerCount(RenderableEvents.DESTROYED)).toBe(listeners + 1)
  message.destroy()
  expect(strip.isDestroyed).toBeTrue()
  expect(strips(s.renderer.root)).toHaveLength(0)
  await draw(s)
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  healthy(s)
})

test("dispose unregisters hooks/listeners, removes owned nodes and aborts in-flight fetches", async () => {
  const s = await setup()
  const message = source(s, first.canonicalUrl, "dispose-pending")
  const pending = Promise.withResolvers<GitHubPrResult>()
  const fetch = mock<GitHubPrClient["fetch"]>(() => pending.promise)
  const before = {
    frame: s.renderer.listenerCount("frame"), blur: s.renderer.listenerCount("blur"),
    destroy: s.renderer.listenerCount("destroy"), input: s.renderer.stdin.listenerCount("data"),
    source: message.listenerCount(RenderableEvents.DESTROYED),
  }
  const controller = s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  const overlayText = tooltip(s)
  const signal = fetch.mock.calls[0][1]
  if (signal === undefined) throw new Error("Cache did not supply an abort signal")
  expect(signal.aborted).toBeFalse()
  expect(linkAt(s, 0, message.screenY)).toBe(first.canonicalUrl)
  controller.dispose()
  controller.dispose()
  expect(signal.aborted).toBeTrue()
  expect(strip.isDestroyed).toBeTrue()
  expect(overlayText.isDestroyed).toBeTrue()
  expect(s.renderer.listenerCount("frame")).toBe(before.frame)
  expect(s.renderer.listenerCount("blur")).toBe(before.blur)
  expect(s.renderer.listenerCount("destroy")).toBe(before.destroy)
  expect(s.renderer.stdin.listenerCount("data")).toBe(before.input)
  expect(message.listenerCount(RenderableEvents.DESTROYED)).toBe(before.source)
  pending.resolve(success(first, "draft", "failed"))
  await settle()
  await draw(s)
  await s.mockMouse.moveTo(1, message.screenY)
  await draw(s)
  expect(linkAt(s, 0, message.screenY)).toBeNull()
  expect(s.renderer.root.getChildren()).toEqual([message])
  expect(message.plainText).toBe(first.canonicalUrl)
  expect(fetch).toHaveBeenCalledTimes(1)
  healthy(s)
})

test("renderer destruction disposes the plugin and aborts outstanding work", async () => {
  const s = await setup()
  const pending = Promise.withResolvers<GitHubPrResult>()
  const fetch = mock<GitHubPrClient["fetch"]>(() => pending.promise)
  const message = source(s, first.canonicalUrl, "destroy-renderer")
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  const signal = fetch.mock.calls[0][1]
  if (signal === undefined) throw new Error("Cache did not supply an abort signal")
  s.renderer.destroy()
  expect(signal.aborted).toBeTrue()
  expect(strip.isDestroyed).toBeTrue()
  pending.resolve(success(first, "draft", "failed"))
  await settle()
  healthy(s)
})

test("visible metadata refreshes exactly when its five-minute deadline arrives and stops on dispose", async () => {
  const s = await setup()
  jest.useFakeTimers()
  source(s, first.canonicalUrl, "scheduled-refresh")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  const controller = s.install({ fetch })
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(1)
  s.clock.now += VISIBLE_REFRESH_INTERVAL_MS - 1
  jest.advanceTimersByTime(VISIBLE_REFRESH_INTERVAL_MS - 1)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(1)
  s.clock.now++
  jest.advanceTimersByTime(1)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(2)
  controller.dispose()
  s.clock.now += VISIBLE_REFRESH_INTERVAL_MS
  jest.advanceTimersByTime(VISIBLE_REFRESH_INTERVAL_MS)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(2)
  healthy(s)
})

test("an opaque overlay covering both source and strip suspends polling until expired links are revealed", async () => {
  const s = await setup()
  jest.useFakeTimers()
  const message = source(s, first.canonicalUrl, "occluded-source-and-strip")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  const strip = stripFor(message)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(linkAt(s, 0, message.screenY)).toBe(first.canonicalUrl)
  expect(linkAt(s, 0, strip.screenY)).toBe(first.canonicalUrl)
  const overlay = new BoxRenderable(s.renderer, {
    id: "opaque-dialog", position: "absolute", left: 0, top: 0,
    width: s.renderer.width, height: s.renderer.height, zIndex: 20_000, backgroundColor: "#111111",
  })
  s.renderer.root.add(overlay)
  await draw(s)
  expect(message.visible).toBeTrue()
  expect(strip.visible).toBeTrue()
  expect(linkAt(s, 0, message.screenY)).toBeNull()
  expect(linkAt(s, 0, strip.screenY)).toBeNull()
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  s.clock.now += VISIBLE_REFRESH_INTERVAL_MS
  jest.advanceTimersByTime(VISIBLE_REFRESH_INTERVAL_MS)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(1)
  overlay.destroy()
  await draw(s)
  expect(linkAt(s, 0, message.screenY)).toBe(first.canonicalUrl)
  expect(linkAt(s, 0, strip.screenY)).toBe(first.canonicalUrl)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (let frame = 0; frame < 5; frame++) await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  healthy(s)
})

test("hiding the source itself stops polling even when its former strip would still fit on screen", async () => {
  const s = await setup()
  jest.useFakeTimers()
  const message = source(s, first.canonicalUrl, "hidden-source")
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(1)
  message.visible = false
  await draw(s)
  s.clock.now += VISIBLE_REFRESH_INTERVAL_MS
  jest.advanceTimersByTime(VISIBLE_REFRESH_INTERVAL_MS)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(s.captureCharFrame()).not.toContain("alpha#123")
  healthy(s)
})

test("hidden message ancestors suspend polling; showing stale sources refreshes once", async () => {
  const s = await setup()
  jest.useFakeTimers()
  const group = new BoxRenderable(s.renderer, { id: "conversation-message", flexDirection: "column", flexShrink: 0 })
  const message = new TextRenderable(s.renderer, { id: "nested-source", content: first.canonicalUrl })
  group.add(message)
  s.renderer.root.add(group)
  const fetch = mock<GitHubPrClient["fetch"]>(async (target) => success(target, "draft", "failed"))
  s.install({ fetch })
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(1)
  group.visible = false
  await draw(s)
  s.clock.now += VISIBLE_REFRESH_INTERVAL_MS
  jest.advanceTimersByTime(VISIBLE_REFRESH_INTERVAL_MS)
  await settle()
  expect(fetch).toHaveBeenCalledTimes(1)
  group.visible = true
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  await draw(s)
  expect(fetch).toHaveBeenCalledTimes(2)
  healthy(s)
})
