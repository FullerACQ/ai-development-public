import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prReviewReminder } from "../pr-review-reminder.mjs";
import { PrReviewReminder } from "../opencode/pr-review-reminder.ts";

const url = "https://github.com/example/app/pull/123";
const secondUrl = "https://github.com/example/library/pull/456";

test("PR creation injects an actionable reminder, including global gh flags and chained commands", () => {
  for (const command of [
    "gh pr create --title 'Fix the bug' --body-file /tmp/body.md",
    "git push -u origin fix && gh pr create --draft",
    "gh -R example/app pr create",
    "gh --hostname github.com --repo example/app pr create",
    "/opt/homebrew/bin/gh pr create",
  ]) {
    assert.ok(prReviewReminder("Bash", { command }, { stdout: url, stderr: "" }).includes(url));
  }
});

test("stack submission includes each PR URL once", () => {
  const reminder = prReviewReminder("bash", { command: "gh stack submit" }, `${url}\n${secondUrl}\n${url}`);
  assert.equal(reminder.match(/https:\/\/github\.com\//g).length, 2);
  assert.ok(reminder.includes(secondUrl));
});

test("MCP creation supports structured and text results", () => {
  for (const tool of ["mcp__github__create_pull_request", "github_createPullRequest", "github_create-pull-request"]) {
    assert.ok(prReviewReminder(tool, {}, { content: [{ type: "text", text: JSON.stringify({ html_url: url }) }] }).includes(url));
  }
});

test("reads, edits, merges, failed responses, and missing PR URLs stay silent", () => {
  for (const command of ["gh pr view 123", "gh pr edit 123", "gh pr merge 123", "gh stack view", "gh issue create"]) {
    assert.equal(prReviewReminder("Bash", { command }, url), undefined);
  }
  assert.equal(prReviewReminder("mcp__github__get_pull_request", {}, { html_url: url }), undefined);
  assert.equal(prReviewReminder("Bash", { command: "gh pr create" }, "failed to create pull request"), undefined);
  assert.equal(prReviewReminder("Bash", { command: "gh pr create" }, { stdout: url, interrupted: true }), undefined);
  assert.equal(prReviewReminder("mcp__github__create_pull_request", {}, { isError: true, content: [{ text: url }] }), undefined);
  assert.equal(prReviewReminder("Bash", {}, url), undefined);
});

test("Claude adapter emits only additionalContext JSON for matching successful calls", () => {
  const hook = fileURLToPath(new URL("../claude/pr-review-reminder.mjs", import.meta.url));
  for (const command of ["gh pr create", "gh pr view 123"]) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: url, stderr: "", interrupted: false },
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    if (command === "gh pr create") {
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.ok(output.hookSpecificOutput.additionalContext.includes(url));
      assert.equal(output.decision, undefined);
    } else {
      assert.equal(result.stdout, "");
    }
  }
});

test("OpenCode adapter appends the reminder to successful output and preserves other results", async () => {
  const hooks = await PrReviewReminder();
  for (const [command, exit, expected] of [
    ["gh pr create", 0, true],
    ["gh pr create", 1, false],
    ["gh pr view 123", 0, false],
  ]) {
    const output = { title: "gh", output: url, metadata: { exit } };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "test", callID: "test", args: { command } }, output);
    if (expected) {
      assert.ok(output.output.startsWith(url));
      assert.ok(output.output.includes(`<system-reminder>\nRequired PR follow-up:`));
      assert.ok(output.output.includes("review the full diff"));
    } else {
      assert.equal(output.output, url);
    }
  }
});
