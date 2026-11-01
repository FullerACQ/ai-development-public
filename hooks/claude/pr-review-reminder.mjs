import { readFileSync } from "node:fs";
import { isRecord, prReviewReminder } from "../pr-review-reminder.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
if (!isRecord(input) || input.hook_event_name !== "PostToolUse" || typeof input.tool_name !== "string") {
  throw new Error("Expected a PostToolUse event with a tool_name");
}

const reminder = prReviewReminder(input.tool_name, input.tool_input, input.tool_response);
if (reminder) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder,
    },
  }));
}
