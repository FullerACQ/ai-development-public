/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const label = " last prompt › "

function lastUserPrompt(api: TuiPluginApi, sessionID: string): string | undefined {
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const text = api.state.part(message.id)
      .flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
  }
  return undefined
}

function truncate(text: string, width: number) {
  if (width <= 1) return ""
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

function Banner(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const prompt = createMemo(() => {
    const route = props.api.route.current
    if (route.name !== "session" || !route.params) return undefined
    const sessionID = route.params.sessionID
    return typeof sessionID === "string" ? lastUserPrompt(props.api, sessionID) : undefined
  })

  return (
    <Show when={prompt()}>
      {(text) => (
        <box position="absolute" top={0} left={0} width={dimensions().width} height={1} zIndex={100}
          flexDirection="row" backgroundColor={theme().backgroundElement}>
          <text fg={theme().primary} wrapMode="none"><b>{label}</b></text>
          <text fg={theme().text} wrapMode="none">{truncate(text(), dimensions().width - label.length - 1)}</text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({ slots: { app: () => <Banner api={api} /> } })
}

export default { id: "acq.last-prompt", tui } satisfies TuiPluginModule
