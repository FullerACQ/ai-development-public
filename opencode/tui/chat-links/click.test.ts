import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CG_EVENT_SOURCE_STATE_COMBINED_SESSION, CG_EVENT_SOURCE_STATE_HID_SYSTEM, COMMAND_FLAG_MASK,
  CORE_GRAPHICS_LIBRARY, OPEN_URL_MAX_OUTPUT_BYTES, OPEN_URL_TIMEOUT_MS,
  commandFlagPressed, createCommandModifierReader, createHttpUrlOpener, openHttpUrl,
  type CommandReaderUnavailable, type OpenHttpUrlResult, type UrlExecutor,
} from "./click";

describe("CoreGraphics Command reader", () => {
  test("published state IDs and Command mask; number and bigint results", () => {
    expect(CG_EVENT_SOURCE_STATE_COMBINED_SESSION).toBe(0);
    expect(CG_EVENT_SOURCE_STATE_HID_SYSTEM).toBe(1);
    expect(COMMAND_FLAG_MASK).toBe(0x100000n);
    for (const flags of [0, 0n, 0x20000, 0x40000n, 0x80000, 0x100000000n]) expect(commandFlagPressed(flags)).toBe(false);
    for (const flags of [0x100000, 0x100000n, 0x1e0000, 0x100100000n, 0xffffffffffffffffn]) expect(commandFlagPressed(flags)).toBe(true);
    for (const flags of [undefined, "1048576", null, true, NaN, Infinity, 1.1, -1, -1n, 2 ** 53, 0x10000000000000000n]) {
      expect(() => commandFlagPressed(flags)).toThrow("invalid unsigned 64-bit");
    }
  });

  test("load once, read on demand with HID state 1, close once", async () => {
    let loads = 0, reads = 0, closes = 0;
    let flags: number | bigint = 0;
    const diagnostics: CommandReaderUnavailable[] = [];
    const result = await createCommandModifierReader(error => diagnostics.push(error), {
      platform: "darwin",
      loadLibrary: async () => {
        loads++;
        return { flagsState(state) { expect(state).toBe(1); reads++; return flags; }, close() { closes++; } };
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(loads).toBe(1);
    expect(reads).toBe(0);
    expect(result.value.commandPressed()).toBe(false);
    flags = 0x100000n;
    expect(result.value.commandPressed()).toBe(true);
    flags = 0;
    expect(result.value.commandPressed()).toBe(false);
    expect(reads).toBe(3);
    result.value.dispose(); result.value.dispose();
    expect(closes).toBe(1);
    expect(() => result.value.commandPressed()).toThrow("disposed");
    expect(diagnostics).toEqual([]);
  });

  test("unsupported platform is typed unavailable, diagnosed once, and never loads FFI", async () => {
    let loads = 0;
    const diagnostics: CommandReaderUnavailable[] = [];
    const result = await createCommandModifierReader(error => diagnostics.push(error), {
      platform: "linux", loadLibrary: async () => { loads++; throw new Error("Must not load"); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported-platform");
      expect(result.error.message).toContain("native link gesture");
      expect(diagnostics).toEqual([result.error]);
    }
    expect(loads).toBe(0);
  });

  test("a framework load failure reports the existing native gesture once", async () => {
    const diagnostics: CommandReaderUnavailable[] = [];
    const result = await createCommandModifierReader(error => diagnostics.push(error), {
      platform: "darwin", loadLibrary: async () => { throw new Error("unsafe raw native failure\u001b[31m"); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("coregraphics-unavailable");
      expect(result.error.message).toContain("Shift+Cmd-click");
      expect(result.error.message).not.toContain("unsafe");
      expect(diagnostics).toEqual([result.error]);
    }
  });

  test.skipIf(process.platform !== "darwin")("actual system CoreGraphics loads and reads current flags without generating an event", async () => {
    expect(CORE_GRAPHICS_LIBRARY).toBe("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
    const result = await createCommandModifierReader(error => { throw new Error(error.message); });
    if (!result.ok) throw new Error(result.error.message);
    try { expect(typeof result.value.commandPressed()).toBe("boolean"); }
    finally { result.value.dispose(); }
  });

  test.skipIf(process.platform !== "darwin")("compiled stock OpenCode imports this transitive plugin module and bun:ffi", async () => {
    const scratch = join(tmpdir(), "opencode");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "chat-links-command-ffi-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const marker = "CLICK_FFI_HOST_RESULT=";
    let output = "", pending = "";
    try {
      const config = join(root, "config");
      await mkdir(config);
      await writeFile(join(config, "opencode.json"), JSON.stringify({ enabled_providers: [], plugin: [] }));
      await writeFile(join(config, "tui.json"), JSON.stringify({ plugin: [join(root, "probe.ts")] }));
      const moduleUrl = new URL("./click.ts", import.meta.url).href;
      await writeFile(join(root, "probe.ts"), `
        import { createCommandModifierReader } from ${JSON.stringify(moduleUrl)};
        export default { id: "research.command-ffi", tui: async (api) => {
          const diagnostics = [];
          const result = await createCommandModifierReader(error => diagnostics.push(error));
          const record = { ok: result.ok, version: api.app.version, bun: process.versions.bun, diagnostics };
          if (result.ok) { try { record.flagsType = typeof result.value.commandPressed(); } finally { result.value.dispose(); } }
          process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(record) + "\\n");
          process.exit(result.ok ? 0 : 1);
        } };
      `);
      const home = homedir();
      const profile = `(version 1)(allow default)
        (deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/opt/homebrew/bin/gh"))
        (deny file-write* (subpath "${home}/.config") (subpath "${home}/Library"))
        (deny file-read* (subpath "${home}/.aws") (subpath "${home}/.ssh") (subpath "${home}/.config/gh")
          (subpath "${home}/.config/opencode") (subpath "${home}/.local/share/opencode") (subpath "${home}/.cache/opencode"))`;
      child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/opt/homebrew/bin/opencode", root], {
        cwd: root,
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root, TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", COLORTERM: "truecolor",
          XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
          OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "probe.sqlite"), OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
        },
        terminal: { cols: 120, rows: 35, data(terminal, data) {
          const text = new TextDecoder().decode(data);
          output = (output + text).slice(-64 * 1024);
          pending += text;
          const queries = /\x1b\[(?:\?(\d+)\$p|>(?:0)?q|c|0c|\?u|6n|14t|16t)|\x1b\](10|11|4;\d+);\?(?:\x07|\x1b\\)|\x1b_G[^\x1b]*\x1b\\/g;
          let end = 0;
          for (const match of pending.matchAll(queries)) {
            const token = match[0];
            const reply = match[1] ? `\x1b[?${match[1]};2$y`
              : token === "\x1b[>q" || token === "\x1b[>0q" ? "\x1bP>|ghostty 1.1.3\x1b\\"
              : token === "\x1b[c" || token === "\x1b[0c" ? "\x1b[?62;22c"
              : token === "\x1b[?u" ? "\x1b[?0u"
              : token === "\x1b[6n" ? "\x1b[1;2R"
              : token === "\x1b[14t" ? "\x1b[4;560;960t"
              : token === "\x1b[16t" ? "\x1b[6;16;8t"
              : match[2] ? `\x1b]${match[2]};rgb:1010/1010/1010\x1b\\` : "\x1b_Gi=31337;OK\x1b\\";
            terminal.write(reply);
            end = match.index + token.length;
          }
          pending = pending.slice(end);
          if (pending.length > 2048) pending = pending.slice(-256);
        } },
      });
      const running = child;
      killTimer = setTimeout(() => running.kill("SIGKILL"), 12_000);
      expect(await child.exited).toBe(0);
      const resultText = output.split(marker).at(-1);
      if (resultText === undefined || !output.includes(marker)) throw new Error("Compiled host did not report FFI result: " + output.slice(-2000));
      const result: unknown = JSON.parse(resultText.split("\n")[0]!);
      expect(result).toMatchObject({ ok: true, version: "1.19.0", flagsType: "boolean", diagnostics: [] });
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (child !== undefined) { child.kill("SIGKILL"); await child.exited; child.terminal?.close(); }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

const TEST_URL = "https://EXAMPLE.com/a%2fb?x=A+B#anchor";

function errorKind(result: OpenHttpUrlResult): string {
  if (result.ok) throw new Error("Expected opener failure");
  return result.error.kind;
}
const subprocess: UrlExecutor = (_file, _args, options) => new Promise((resolve, reject) => {
  execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, (error, stdout, stderr) => {
    if (error !== null) { reject(error); return; }
    resolve({ stdout, stderr });
  });
});

describe("HTTP(S) opener — injected execution, never opens a browser", () => {
  test("passes the original full URL as one argument to the absolute opener, without a shell", async () => {
    const calls: Parameters<UrlExecutor>[] = [];
    const original = "HTTPS://GITHUB.com:443/Owner/Repo/pull/7/files?diff=split&token=A%2FB+X#anchor";
    const result = await openHttpUrl(original, { platform: "darwin", execute: async (...args) => {
      calls.push(args); return { stdout: "", stderr: "" };
    } });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call[0]).toBe("/usr/bin/open");
    expect(call[1]).toEqual([original]);
    expect(call[2]).toMatchObject({ timeout: OPEN_URL_TIMEOUT_MS, maxBuffer: OPEN_URL_MAX_OUTPUT_BYTES, shell: false, killSignal: "SIGKILL" });
  });

  test("malformed, non-HTTP, whitespace and terminal-control destinations never execute", async () => {
    let calls = 0;
    const execute: UrlExecutor = async () => { calls++; return { stdout: "", stderr: "" }; };
    for (const url of ["file:///tmp/test", "javascript:alert(1)", "mailto:a@example.com", "https:", "//example.com", "--help",
      " https://example.com", "https://example.com\n", "https://example.com/a b", "https://example.com/\u001b[31m", "https://example.com/\u202e", "http://[invalid]"]) {
      expect(errorKind(await openHttpUrl(url, { platform: "darwin", execute }))).toBe("invalid-url");
    }
    expect(calls).toBe(0);
  });

  test("ordinary shell metacharacters remain data in one HTTP URL argument", async () => {
    const url = "https://example.com/?q=$(touch%20/tmp/never);echo&x=`data`";
    const result = await openHttpUrl(url, { platform: "darwin", execute: async (file, args) => {
      expect(file).toBe("/usr/bin/open"); expect(args).toEqual([url]); return { stdout: "", stderr: "" };
    } });
    expect(result.ok).toBe(true);
  });

  test("non-macOS and pre-cancelled requests never execute", async () => {
    let calls = 0;
    const execute: UrlExecutor = async () => { calls++; return { stdout: "", stderr: "" }; };
    expect(errorKind(await openHttpUrl(TEST_URL, { platform: "linux", execute }))).toBe("unsupported-platform");
    expect(errorKind(await openHttpUrl(TEST_URL, { platform: "darwin", execute, signal: AbortSignal.abort() }))).toBe("aborted");
    expect(calls).toBe(0);
  });

  test("disposal aborts all active requests and prevents future spawning", async () => {
    const signals: AbortSignal[] = [];
    const opener = createHttpUrlOpener({ platform: "darwin", execute: (_file, _args, options) => {
      signals.push(options.signal);
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const first = opener.openHttpUrl(TEST_URL), second = opener.openHttpUrl(TEST_URL);
    opener.dispose(); opener.dispose();
    expect(errorKind(await first)).toBe("aborted"); expect(errorKind(await second)).toBe("aborted");
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(errorKind(await opener.openHttpUrl(TEST_URL))).toBe("aborted");
    expect(signals).toHaveLength(2);
  });

  test("caller cancellation reaches the actual injected subprocess", async () => {
    const controller = new AbortController();
    const pending = openHttpUrl(TEST_URL, { platform: "darwin", execute: subprocess, signal: controller.signal });
    controller.abort();
    expect(errorKind(await pending)).toBe("aborted");
  });

  test("deadline terminates an injected subprocess, without invoking open", async () => {
    expect(errorKind(await openHttpUrl(TEST_URL, { platform: "darwin", execute: subprocess, timeoutMs: 30 }))).toBe("timeout");
  });

  test("stdout and stderr are bounded by bytes, including multi-byte characters", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const result = await openHttpUrl(TEST_URL, { platform: "darwin", execute: async () => ({
        stdout: stream === "stdout" ? "🦑".repeat(OPEN_URL_MAX_OUTPUT_BYTES / 4 + 1) : "",
        stderr: stream === "stderr" ? "x".repeat(OPEN_URL_MAX_OUTPUT_BYTES + 1) : "",
      }) });
      expect(errorKind(result)).toBe("output-limit");
    }
  });

  test("expected process failures are safe results without URL, query, or ANSI leakage", async () => {
    for (const [code, kind] of [["ENOENT", "missing-opener"], ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "output-limit"], ["EACCES", "open-failed"], [1, "open-failed"]] as const) {
      const result = await openHttpUrl(TEST_URL, { platform: "darwin", execute: async () => {
        throw { code, message: `failed ${TEST_URL}\u001b[31m`, stderr: "token=SECRET\u0007" };
      } });
      expect(errorKind(result)).toBe(kind);
      if (!result.ok) expect(result.error.message).not.toMatch(/SECRET|token=|https?:|[\u0000-\u001f\u007f-\u009f]/u);
    }
    expect(errorKind(await openHttpUrl(TEST_URL, { platform: "darwin", execute: async () => {
      throw { code: null, killed: true, signal: "SIGKILL" };
    } }))).toBe("timeout");
  });

  test("programmer errors propagate; an invalid deadline fails loudly", async () => {
    const failure = new TypeError("broken executor");
    await expect(openHttpUrl(TEST_URL, { platform: "darwin", execute: async () => { throw failure; } })).rejects.toBe(failure);
    await expect(openHttpUrl(TEST_URL, { platform: "darwin", timeoutMs: 0 })).rejects.toThrow("positive");
  });
});
