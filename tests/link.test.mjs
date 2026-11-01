import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("installer links real sources idempotently and preserves existing files", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-link-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = () => execFileSync("bash", [join(root, "bin/link")], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    stdio: "pipe",
  });
  run();
  assert.equal(readlinkSync(join(home, ".agents/skills")), join(root, "skills"));
  assert.equal(readlinkSync(join(home, ".claude/CLAUDE.md")), join(root, "AGENTS.md"));
  assert.equal(run().trim(), "done");
  for (const skill of readdirSync(join(root, "skills"))) {
    assert.ok(lstatSync(join(home, ".claude/skills", skill)).isSymbolicLink());
    assert.equal(readlinkSync(join(home, ".claude/skills", skill)), join(root, "skills", skill));
  }
  const existing = join(home, ".claude/CLAUDE.md");
  rmSync(existing);
  writeFileSync(existing, "user-owned instructions\n");
  const directory = join(home, ".cursor/skills/caveman");
  rmSync(directory);
  mkdirSync(directory);
  assert.throws(run, (error) => error.status === 1 && error.stderr.includes("not replacing"));
  assert.equal(readFileSync(existing, "utf8"), "user-owned instructions\n");
  assert.ok(lstatSync(directory).isDirectory());
});
