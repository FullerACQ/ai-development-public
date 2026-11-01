// Shared detection for the Claude Code hook and OpenCode plugin. This is a
// reminder, not a shell permission check: it recognizes explicit PR creation
// commands and requires a GitHub PR URL in the successful tool result.
const CREATE_COMMAND = /\bgh(?:\s+(?:--repo|-R|--hostname)\s+\S+)*\s+(?:pr\s+create|stack\s+submit)\b/;
const CREATE_TOOL = /(?:^|[_-])create[_-]?pull[_-]?request$/i;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\b/g;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} tool
 * @param {unknown} args
 * @param {unknown} response
 * @returns {string | undefined}
 */
export function prReviewReminder(tool, args, response) {
  if (tool === "bash" || tool === "Bash") {
    if (!isRecord(args) || typeof args.command !== "string") return;
    if (!CREATE_COMMAND.test(args.command)) return;
  } else if (!CREATE_TOOL.test(tool)) {
    return;
  }

  if (isRecord(response) && (response.isError === true || response.interrupted === true)) return;
  const text = typeof response === "string" ? response : JSON.stringify(response);
  if (typeof text !== "string") return;
  const urls = [...new Set(text.match(PR_URL))];
  if (urls.length === 0) return;

  return [
    "Required PR follow-up: review the full diff of the PR(s) just opened:",
    ...urls,
    "Look for justified simplifications that keep behavior intact and changes focused on the PR. Prefer a sound, minimal, idiomatic solution.",
    "Run the relevant checks for any changes. Commit and push only within the user's authorized task scope.",
    "Report the outcome and any genuine blockers concisely.",
  ].join("\n");
}
