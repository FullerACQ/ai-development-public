/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const exec = promisify(execFile)
const refreshInterval = 60_000

type PullRequest = Readonly<{ number: number; title: string; isDraft: boolean }>
type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; prs: readonly PullRequest[] }>
  | Readonly<{ kind: "error"; message: string }>
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>

function clean(text: string) {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()
}

function parsePullRequests(raw: string): readonly PullRequest[] {
  if (!raw.trim()) return []
  return raw.trim().split(/\r?\n/).map((line) => {
    const item: unknown = JSON.parse(line)
    if (
      typeof item !== "object" || item === null ||
      !("number" in item) || !Number.isSafeInteger(item.number) ||
      typeof item.number !== "number" || item.number <= 0 ||
      !("title" in item) || typeof item.title !== "string" ||
      !("isDraft" in item) || typeof item.isDraft !== "boolean"
    ) throw new Error("GitHub returned an invalid pull request")
    return { number: item.number, title: clean(item.title), isDraft: item.isDraft }
  })
}

async function github(args: string[], directory: string, signal: AbortSignal): Promise<Result<string>> {
  try {
    const { stdout } = await exec("gh", args, {
      cwd: directory,
      signal,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    })
    return { ok: true, value: stdout }
  } catch (error) {
    const detail = typeof error === "object" && error !== null &&
      "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()
      ? error.stderr : error instanceof Error ? error.message : String(error)
    return { ok: false, message: clean(detail) }
  }
}

async function fetchPullRequests(directory: string, signal: AbortSignal): Promise<Result<readonly PullRequest[]>> {
  const user = await github(["api", "user", "--jq", ".login"], directory, signal)
  if (!user.ok) return user
  const login = user.value.trim()
  if (!login) return { ok: false, message: "GitHub returned an empty username" }
  const list = await github([
    "api", "--paginate", "repos/{owner}/{repo}/pulls?state=open&per_page=100",
    "--jq", `.[] | select(.user.login == ${JSON.stringify(login)}) | {number, title, isDraft: .draft} | @json`,
  ], directory, signal)
  if (!list.ok) return list
  try {
    return { ok: true, value: parsePullRequests(list.value) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function View(props: { api: TuiPluginApi }) {
  const [state, setState] = createSignal<State>({ kind: "loading" })
  const [headerHovered, setHeaderHovered] = createSignal(false)
  const [hoveredPr, setHoveredPr] = createSignal<number | undefined>()
  const controller = new AbortController()
  let fetching = false
  const theme = () => props.api.theme.current
  const refresh = async () => {
    if (fetching || controller.signal.aborted || !props.api.state.ready) return
    const directory = props.api.state.path.directory
    if (!directory) return
    fetching = true
    const result = await fetchPullRequests(directory, controller.signal)
    fetching = false
    if (controller.signal.aborted) return
    setState(result.ok ? { kind: "ready", prs: result.value } : { kind: "error", message: result.message })
  }
  const open = async (pr: PullRequest) => {
    const result = await github(["pr", "view", String(pr.number), "--web"], props.api.state.path.directory, controller.signal)
    if (!result.ok && !controller.signal.aborted) {
      props.api.ui.toast({ variant: "error", title: "Open PR", message: result.message })
    }
  }
  createEffect(() => {
    if (props.api.state.ready && props.api.state.path.directory) void refresh()
  })
  onMount(() => {
    const timer = setInterval(() => void refresh(), refreshInterval)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => controller.abort())
  const ready = () => {
    const current = state()
    return current.kind === "ready" ? current : undefined
  }
  const error = () => {
    const current = state()
    return current.kind === "error" ? current.message : undefined
  }

  return (
    <box flexDirection="column" gap={1}>
      <box
        backgroundColor={headerHovered() ? theme().backgroundElement : theme().backgroundPanel}
        onMouseOver={() => setHeaderHovered(true)}
        onMouseOut={() => setHeaderHovered(false)}
        onMouseDown={() => void refresh()}
      >
        <text fg={headerHovered() ? theme().primary : theme().text}>
          <b>My open PRs</b><span style={{ fg: headerHovered() ? theme().primary : theme().textMuted }}> ⟳</span>
        </text>
      </box>
      <Show when={state().kind === "loading"}>
        <text fg={theme().textMuted}>Loading…</text>
      </Show>
      <Show when={error()}>
        {(message) => <text fg={theme().error}>{message()}</text>}
      </Show>
      <Show when={ready()}>
        {(value) => (
            <box flexDirection="column" gap={1}>
              <Show when={value().prs.length === 0}><text fg={theme().textMuted}>No open PRs</text></Show>
              <For each={value().prs}>{(pr) => (
                <box
                  flexDirection="column"
                  backgroundColor={hoveredPr() === pr.number ? theme().backgroundElement : theme().backgroundPanel}
                  onMouseOver={() => setHoveredPr(pr.number)}
                  onMouseOut={() => setHoveredPr(undefined)}
                  onMouseUp={() => void open(pr)}
                >
                  <text fg={theme().primary}>#{pr.number}{pr.isDraft ? " · draft" : ""}</text>
                  <text fg={hoveredPr() === pr.number ? theme().text : theme().textMuted}>{pr.title}</text>
                </box>
              )}</For>
            </box>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: { sidebar_content: () => <View api={api} /> },
  })
}

export default { id: "acq.my-open-prs", tui } satisfies TuiPluginModule
