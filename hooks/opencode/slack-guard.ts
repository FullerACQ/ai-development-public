// OpenCode plugin: every Slack message an agent sends as you is labelled 🤖,
// one line, at most 120 characters besides links, with no greeting and no
// first person. Anything else is refused back to the agent to rewrite.
import type { Plugin } from "@opencode-ai/plugin";
import { isSlackPostingTool, slackMessage } from "../slack-guard.mjs";

export const SlackGuard: Plugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (!isSlackPostingTool(input.tool)) return;
    const message = slackMessage(output.args.message);
    if (message instanceof Error) throw message;
    output.args.message = message;
  },
});
