import type { Plugin } from "@opencode-ai/plugin";
import { isRecord, prReviewReminder } from "../pr-review-reminder.mjs";

export const PrReviewReminder: Plugin = async () => ({
  "tool.execute.after": async (input, output) => {
    // Bash's after hook can also run for nonzero exits and timeouts.
    if (input.tool === "bash" && isRecord(output.metadata) && typeof output.metadata.exit === "number" && output.metadata.exit !== 0) return;
    const reminder = prReviewReminder(input.tool, input.args, output.output);
    if (reminder) output.output += `\n\n<system-reminder>\n${reminder}\n</system-reminder>`;
  },
});
