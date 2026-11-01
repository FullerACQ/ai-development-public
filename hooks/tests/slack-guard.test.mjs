import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlackPostingTool, LABEL, slackMessage } from "../slack-guard.mjs";
import { SlackGuard } from "../opencode/slack-guard.ts";

const url = "https://github.com/example/app/pull/123";

test("guards the posting tools only", () => {
  for (const tool of ["slack_slack_send_message", "slack_slack_schedule_message", "slack_slack_send_message_draft", "mcp__slack__slack_send_message"]) {
    assert.ok(isSlackPostingTool(tool), tool);
  }
  for (const tool of ["slack_slack_create_canvas", "slack_slack_read_channel", "slack_slack_add_reaction", "bash"]) {
    assert.ok(!isSlackPostingTool(tool), tool);
  }
});

test("labels a terse message, once", () => {
  assert.equal(slackMessage(url), `${LABEL} ${url}`);
  assert.equal(slackMessage(`PR: ${url}`), `${LABEL} PR: ${url}`);
  assert.equal(slackMessage(`${LABEL} PR: ${url}`), `${LABEL} PR: ${url}`);
});

test("refuses a greeting with multiline commentary and excessive length", () => {
  const sent = `Hey teammate, PR: ${url}\n\n${"Detailed commentary. ".repeat(8)}`;
  const result = slackMessage(sent);
  assert.ok(result instanceof Error);
  assert.match(result.message, /greeting/);
  assert.match(result.message, /one line/);
  assert.match(result.message, /at most 120/);
});

test("refuses first person, and long text even without links", () => {
  assert.match(slackMessage(`I opened this: ${url}`).message, /first person/);
  assert.match(slackMessage(`Here's my PR ${url}`).message, /first person/);
  assert.match(slackMessage("x".repeat(121)).message, /at most 120/);
  assert.ok(slackMessage("").message);
});

test("the OpenCode plugin rewrites args or throws", async () => {
  const hooks = await SlackGuard({});
  const ok = { args: { channel_id: "U1", message: url } };
  await hooks["tool.execute.before"]({ tool: "slack_slack_send_message" }, ok);
  assert.equal(ok.args.message, `${LABEL} ${url}`);
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "slack_slack_send_message" }, { args: { message: "Hey, I did it" } }),
    /refused/,
  );
  const canvas = { args: { content: "Hey, a long canvas I wrote" } };
  await hooks["tool.execute.before"]({ tool: "slack_slack_create_canvas" }, canvas);
  assert.equal(canvas.args.content, "Hey, a long canvas I wrote");
});
