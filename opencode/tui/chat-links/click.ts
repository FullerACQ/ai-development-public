import { execFile } from "node:child_process";

/** CGEventTypes.h: CombinedSessionState=0, HIDSystemState=1; IOLLEvent.h: NX_COMMANDMASK. */
export const CG_EVENT_SOURCE_STATE_COMBINED_SESSION = 0;
export const CG_EVENT_SOURCE_STATE_HID_SYSTEM = 1;
export const COMMAND_FLAG_MASK = 0x100000n;
export const CORE_GRAPHICS_LIBRARY = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
export const OPEN_URL_TIMEOUT_MS = 20_000;
export const OPEN_URL_MAX_OUTPUT_BYTES = 16 * 1024;

export type CommandModifierReader = Readonly<{
  commandPressed(): boolean;
  dispose(): void;
}>;
export type CommandReaderUnavailable = Readonly<{
  kind: "unsupported-platform" | "coregraphics-unavailable";
  message: string;
}>;
export type CommandReaderResult =
  | Readonly<{ ok: true; value: CommandModifierReader }>
  | Readonly<{ ok: false; error: CommandReaderUnavailable }>;
export type CoreGraphicsLibrary = Readonly<{
  flagsState(state: typeof CG_EVENT_SOURCE_STATE_HID_SYSTEM): unknown;
  close(): void;
}>;
export type CommandReaderOptions = Readonly<{
  platform?: NodeJS.Platform;
  loadLibrary?: () => Promise<CoreGraphicsLibrary>;
}>;

/** Bun versions can box u64 as bigint or a safe number. Parse before masking. */
export function commandFlagPressed(value: unknown): boolean {
  const flags = typeof value === "bigint" ? value
    : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
  if (flags === null || flags < 0n || flags > 0xffffffffffffffffn) {
    throw new TypeError("CoreGraphics returned an invalid unsigned 64-bit modifier state");
  }
  return (flags & COMMAND_FLAG_MASK) !== 0n;
}

async function loadCoreGraphics(): Promise<CoreGraphicsLibrary> {
  // Keep the built-in import dynamic: unsupported hosts can report unavailability
  // without trying to load macOS FFI. Stock compiled OpenCode also resolves bun:ffi.
  const { dlopen, FFIType } = await import("bun:ffi");
  const library = dlopen(CORE_GRAPHICS_LIBRARY, {
    CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u64 },
  });
  return {
    flagsState: (state) => library.symbols.CGEventSourceFlagsState(state),
    close: () => library.close(),
  };
}

/** Initialize once per plugin. Read synchronously at accepted mouse-up, never poll.
 * CGEventSourceFlagsState reports CURRENT physical modifier state, not historical
 * mouse flags: the user must hold Cmd through mouse-up and its PTY delivery.
 * https://developer.apple.com/documentation/coregraphics/cgeventsource/flagsstate(_:)
 */
export async function createCommandModifierReader(
  onDiagnostic: (error: CommandReaderUnavailable) => void,
  options: CommandReaderOptions = {},
): Promise<CommandReaderResult> {
  // FALLBACK: production uses the actual host platform; tests inject the boundary.
  const platform = options.platform ?? process.platform;
  const unavailable = (error: CommandReaderUnavailable): CommandReaderResult => {
    // FALLBACK: without local CoreGraphics, leave terminal-native hyperlinks in
    // charge; report this once at initialization instead of silently returning false.
    onDiagnostic(error);
    return { ok: false, error };
  };
  if (platform !== "darwin") return unavailable({
    kind: "unsupported-platform",
    message: "Explicit Cmd-click requires local macOS modifier state; use your terminal's native link gesture.",
  });
  // FALLBACK: production loads the one system framework; tests inject its ABI.
  const load = options.loadLibrary ?? loadCoreGraphics;
  let library: CoreGraphicsLibrary;
  try {
    library = await load();
  } catch {
    // FALLBACK: FFI/framework loading can be unavailable in a compiled host;
    // report it once and retain the existing native Shift+Cmd-click path.
    return unavailable({
      kind: "coregraphics-unavailable",
      message: "CoreGraphics Cmd detection is unavailable; use native Shift+Cmd-click in your terminal.",
    });
  }
  let disposed = false;
  return { ok: true, value: {
    commandPressed() {
      if (disposed) throw new Error("Command modifier reader is disposed");
      return commandFlagPressed(library.flagsState(CG_EVENT_SOURCE_STATE_HID_SYSTEM));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      library.close();
    },
  } };
}

export type OpenHttpUrlError = Readonly<{
  kind: "invalid-url" | "unsupported-platform" | "aborted" | "timeout" | "missing-opener" | "output-limit" | "open-failed";
  /** Safe for a toast/log: never includes the URL, query, or raw process output. */
  message: string;
}>;
export type OpenHttpUrlResult =
  | Readonly<{ ok: true; value: undefined }>
  | Readonly<{ ok: false; error: OpenHttpUrlError }>;
export type UrlExecOptions = Readonly<{
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  killSignal: "SIGKILL";
  shell: false;
}>;
export type UrlExecutor = (
  file: string, args: readonly string[], options: UrlExecOptions,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;
export type OpenHttpUrlOptions = Readonly<{
  platform?: NodeJS.Platform;
  execute?: UrlExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

const executeUrl: UrlExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error !== null) { reject(error); return; }
    resolve({ stdout, stderr });
  });
});

function validHttpUrl(raw: string): boolean {
  if (!/^https?:\/\//iu.test(raw) || /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw)) return false;
  const parsed = URL.parse(raw);
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
}
function openFailure(kind: OpenHttpUrlError["kind"], message: string): OpenHttpUrlResult {
  return { ok: false, error: { kind, message } };
}
function parseProcessError(error: unknown): Readonly<{ code: string | number | null; killed: boolean }> | null {
  if (typeof error !== "object" || error === null) return null;
  // FALLBACK: signal-terminated execFile errors have no numeric/string exit code.
  const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : null;
  const killed = "killed" in error && error.killed === true;
  return code !== null || killed ? { code, killed } : null;
}

/** Validate a destination but pass its ORIGINAL spelling as one argument. In
 * particular, never replace a /files?diff=...#... link with a canonical PR URL.
 * The result records launching /usr/bin/open, not eventual browser navigation.
 */
export async function openHttpUrl(raw: string, options: OpenHttpUrlOptions = {}): Promise<OpenHttpUrlResult> {
  if (!validHttpUrl(raw)) return openFailure("invalid-url", "Only valid HTTP and HTTPS links can be opened.");
  // FALLBACK: the explicit OS opener is macOS-only; tests inject the platform.
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return openFailure("unsupported-platform", "Explicit Cmd-click opening requires macOS.");
  const signal = options.signal;
  if (signal !== undefined && signal.aborted) return openFailure("aborted", "Link opening was cancelled.");
  // FALLBACK: production uses an argument-vector execFile; tests never open a URL.
  const execute = options.execute ?? executeUrl;
  // FALLBACK: 20s is the specified opener deadline; tests use a shorter deadline.
  const timeoutMs = options.timeoutMs ?? OPEN_URL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Link opener timeout must be positive");
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const output = await execute("/usr/bin/open", [raw], {
      signal: controller.signal, timeout: timeoutMs, maxBuffer: OPEN_URL_MAX_OUTPUT_BYTES,
      encoding: "utf8", killSignal: "SIGKILL", shell: false,
    });
    if (timedOut) return openFailure("timeout", "Link opening timed out.");
    if (controller.signal.aborted) return openFailure("aborted", "Link opening was cancelled.");
    if (Buffer.byteLength(output.stdout) > OPEN_URL_MAX_OUTPUT_BYTES
      || Buffer.byteLength(output.stderr) > OPEN_URL_MAX_OUTPUT_BYTES) {
      return openFailure("output-limit", "URL opener output exceeded the size limit.");
    }
    return { ok: true, value: undefined };
  } catch (error) {
    if (timedOut) return openFailure("timeout", "Link opening timed out.");
    if (controller.signal.aborted) return openFailure("aborted", "Link opening was cancelled.");
    const failure = parseProcessError(error);
    if (failure === null) throw error;
    if (failure.code === "ENOENT") return openFailure("missing-opener", "The macOS URL opener is unavailable.");
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return openFailure("output-limit", "URL opener output exceeded the size limit.");
    if (failure.killed) return openFailure("timeout", "Link opening timed out.");
    // Raw exec errors commonly repeat argv/URLs; fixed messages avoid leaking
    // query credentials or terminal escapes into the parent's structured log.
    return openFailure("open-failed", "The macOS URL opener failed.");
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", abort);
  }
}

export type HttpUrlOpener = Readonly<{
  openHttpUrl(raw: string, signal?: AbortSignal): Promise<OpenHttpUrlResult>;
  dispose(): void;
}>;

/** One lifetime per plugin; disposal cancels every in-flight and future open. */
export function createHttpUrlOpener(options: Omit<OpenHttpUrlOptions, "signal"> = {}): HttpUrlOpener {
  const lifetime = new AbortController();
  return {
    openHttpUrl(raw, signal) {
      const combined = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
      return openHttpUrl(raw, { ...options, signal: combined });
    },
    dispose: () => lifetime.abort(),
  };
}
