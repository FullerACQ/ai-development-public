// Rules for messages an agent posts to Slack as the user. The Slack MCP posts
// from the user's own account, so a message must read as an agent's terse
// relay, never as the user writing: labelled, short, no greeting, no first
// person. Shared by the OpenCode plugin (hooks/opencode/slack-guard.ts).

/** Tools that post as the user. Canvases are documents, not messages, so they're out. */
const POSTING_TOOL = /(?:^|_)slack_(?:send_message|schedule_message|send_message_draft)$/;
const URL = /<?https?:\/\/\S+>?/g;
const MAX_CHARS = 120; // without URLs
export const LABEL = "🤖";

const RULES = [
  [/^\s*(?:hey|hi|hello|yo|thanks|thank you)\b/i, "no greeting or thanks"],
  [/\b(?:I|I'm|I've|I'll|I'd|me|my|mine|myself)\b/, "no first person: it posts as the user"],
  [/\n/, "one line only"],
];

/** @param {string} tool */
export function isSlackPostingTool(tool) {
  return POSTING_TOOL.test(tool);
}

/**
 * The labelled message to send, or an Error saying why it was refused.
 * @param {unknown} message
 * @returns {string | Error}
 */
export function slackMessage(message) {
  if (typeof message !== "string" || !message.trim()) return new Error("Slack message is empty");
  const body = message.trim().replace(new RegExp(`^${LABEL}\\s*`, "u"), "");
  const words = body.replace(URL, "").trim();
  const problems = RULES.filter(([pattern]) => pattern.test(words)).map(([, why]) => why);
  if (words.length > MAX_CHARS) problems.push(`at most ${MAX_CHARS} characters besides links (got ${words.length})`);
  if (problems.length) {
    return new Error(
      `Slack message refused (${problems.join("; ")}). Send only the link or fact, e.g. "PR: <url>" or "<url>". ${LABEL} is added automatically.`,
    );
  }
  return `${LABEL} ${body}`;
}
