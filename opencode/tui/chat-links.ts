import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { installChatLinks } from "./chat-links/plugin"
import { createCommandModifierReader, createHttpUrlOpener } from "./chat-links/click"

export default {
  id: "acq.chat-links",
  tui: async (api) => {
    const command = await createCommandModifierReader((error) => {
      api.ui.toast({ variant: "warning", title: "Chat links", message: error.message, duration: 10_000 })
    })
    const opener = createHttpUrlOpener()
    try {
      const plugin = installChatLinks(api, command.ok ? {
        activation: { commandPressed: command.value.commandPressed, openHttpUrl: opener.openHttpUrl },
      } : {})
      api.lifecycle.onDispose(() => {
        plugin.dispose()
        opener.dispose()
        if (command.ok) command.value.dispose()
      })
    } catch (error) {
      opener.dispose()
      if (command.ok) command.value.dispose()
      throw error
    }
  },
} satisfies TuiPluginModule
