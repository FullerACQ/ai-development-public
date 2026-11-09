# Chat links for OpenCode

`chat-links.ts` is a local TUI plugin for **OpenCode 1.18.34 and 1.19.0 / OpenTUI 0.4.5**.

## Use

Restart OpenCode after installation. Hold **⌘** through the click and release to
open a link in your default browser. On this Mac the plugin reads the physical
Command modifier through CoreGraphics and handles the click before OpenCode's
mouse handlers. HTTP and HTTPS URLs work in user and
assistant messages, reasoning, code blocks, and expanded tool output. Existing
Markdown link labels retain their destinations.

GitHub.com PR links in assistant Markdown prose become a single clickable item
with inline status symbols. Labeled links, reference-style Markdown links, and
bare PR URLs are compacted:

```text
Alpha #224 ◆✕
```

| Symbol | Color | Meaning |
| --- | --- | --- |
| `✓` | Theme success / green | Reported CI checks passed |
| `✕` | Theme error / red | At least one check failed |
| `◷` | Theme warning / amber | Checks are pending |
| `?` | Muted | CI unavailable, no checks, or only skipped/neutral checks |
| `◇` | Muted | Draft |
| `◆` | Purple | Merged |
| `⊘` | Theme error / red | Closed without merging |

Lifecycle and CI are independent: a merged PR can still show failing CI. Green
does not mean the PR has approval or meets branch-protection requirements.

The original URL remains in the saved message and as the click/hover destination,
including its query and fragment. There is no duplicate URL or separate status
row for a compacted prose link. User-input text, commands, and fenced code keep
their visible URLs and use the compact status strip below the source instead.
Markdown-language code fences are also protected from compaction.

Hover the compact PR item, original code URL, or its strip for lifecycle, CI counts, failed check
names, and the last successful fetch time. Metadata uses the existing **`gh` CLI
authentication**, including access to private repositories. Failed lookups show
`?` and their reason rather than retaining a stale green indicator.

Refresh happens on first visible appearance, pointer entry, and every five
minutes while the link or its strip is visible. Duplicate PR URLs share a cache
and in-flight request. Pointer re-entry is throttled for two seconds; mouse
movement within the same link does not keep fetching. Requests have a 20-second
deadline and a three-request concurrency limit.

Ordinary clicks and text-selection gestures keep their existing behavior.
Command-click invokes macOS `/usr/bin/open` with the original URL, including its
query and fragment. The modifier must remain held through mouse-up delivery.
This explicit opener avoids cmux's native Shift+Command mouse-capture bypass.
If macOS modifier detection is unavailable, a startup toast reports it and
terminal-native hyperlinks remain available; in cmux use **Shift+⌘-click**.

## Installation

Run `bun install` in this directory to install the exact dependencies for local
development and standalone checks. Production widgets use the running
OpenCode's canonical OpenTUI runtime, avoiding duplicate renderer instances.

The repository's `../tui.json` registers `./tui/chat-links.ts` when
`OPENCODE_CONFIG_DIR` points to this repository's `opencode/` directory.

For use without that environment variable, add the absolute plugin file URL to
the `plugin` array in `~/.config/opencode/tui.json`. Preserve other plugins and
settings. The entry has this form:

```json
"file:///path/to/ai-development-public/opencode/tui/chat-links.ts"
```

OpenCode deduplicates the same resolved file URL across both configs.

Quit and restart OpenCode. The built-in **Plugins** dialog should list
`acq.chat-links` as active.

## Checks

From this directory:

```sh
bun run typecheck
bun test ./chat-links
```

Tests exercise real native OpenTUI rendering, Tree-sitter Markdown/code, OSC 8
output, colors, wrapped links, mouse hover, overlays, compact prose/copy mapping,
protected commands and fences, original selection text,
GitHub parsing, refresh deadlines, concurrency, streaming updates, and cleanup.
Fixture-only PTY checks also verified the installed OpenCode binary, both config
modes, hover tooltips, PR strips, native hyperlinks, and unchanged Ctrl+C/OSC 52
copy without making model requests.

## Compatibility

The adapter uses version-specific renderer internals because this OpenCode
release has no chat-link decoration slot. An unsupported version or runtime
produces a compatibility toast and structured `acq.chat-links` log rather than
patching OpenCode. Retest the adapter before supporting a new version.

The native hyperlink pool limits URL destinations to **512 UTF-8 bytes**. Longer
URLs stay readable and generate a diagnostic. Truncated text and nonzero
first-line-offset layouts preserve existing native links; additional literal
URL mapping in those layouts is diagnosed rather than guessed. Hover observes
SGR cell mouse input, the protocol enabled by the tested stock TUI.

Code/user-input PR strips are separate, nonselectable renderables. Compacted
prose uses a native-column selection map: selecting a chip copies its original
occurrence with the exact URL rather than status symbols. OpenCode's whole-message
copy and saved messages retain the source text. A terminal's own native selection
can copy the visible label/decorations; use OpenCode selection for original text.

To disable, deactivate `acq.chat-links` in the Plugins dialog. Removing its entry
from both TUI config files prevents loading it after a restart.
