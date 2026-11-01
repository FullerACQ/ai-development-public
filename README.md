# ai-development

A shared home for coding-agent skills, prompt templates, hooks, and a terminal
picker for Claude Code, Cursor CLI, Codex, OpenCode, pi, and Antigravity.

## Install

```bash
git clone https://github.com/FullerACQ/ai-development-public.git
cd ai-development-public
bash bin/link
```

The linker creates user-level symlinks. It refuses to replace real files or
directories; move or back up an existing configuration before linking it.
Review `AGENTS.md` before making it your global agent instructions.

To enable the terminal picker, add this to `~/.zshrc`, using your clone's path:

```zsh
source "$HOME/path/to/ai-development-public/shell/develop.zsh"
```

Run `develop` to select an installed CLI with the arrow keys or `j`/`k`, then
press Enter. Arguments pass through, for example `develop --resume`.
OpenCode's configuration directory is selected when this file is sourced.

## Layout

```text
AGENTS.md          generic global agent instructions
skills/            reviewed public upstream skills
skill-lock.json    upstream installation provenance
commands/          prompt templates
agents/claude/     Claude Code subagent definitions
hooks/             optional hook scripts and OpenCode plugins
opencode/          minimal OpenCode configuration
bin/link           idempotent symlink installer
shell/develop.zsh  installed-agent picker
licenses/          upstream license texts
```

| Tool | Skills | Instructions | Commands |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/<name>` | `~/.claude/CLAUDE.md` | `~/.claude/commands/` |
| Cursor CLI | `~/.cursor/skills/<name>` | — | — |
| Codex | `~/.codex/skills/<name>` | `~/.codex/AGENTS.md` | `~/.codex/commands/` |
| OpenCode | `~/.agents/skills` | config `instructions` | `opencode/commands` |
| pi | `~/.agents/skills` | `~/.pi/agent/AGENTS.md` | `~/.pi/agent/prompts/` |

`~/.agents/skills` links the entire skills directory. Claude's skills directory
stays a real directory with per-skill links, allowing other installations to
coexist.

## Hooks

Hook wiring differs between agent tools. Claude hook scripts are installed by
`bin/link`, but must be registered in your own `~/.claude/settings.json`.
OpenCode loads the plugins in `opencode/plugins` automatically when
`OPENCODE_CONFIG_DIR` points at this repository's `opencode` directory.

The included OpenCode plugins provide cmux status, a PR simplification reminder,
and a Slack message guard. The Slack guard labels outgoing messages with 🤖 and
rejects greetings, first-person messages, and lengthy commentary. The sample
config requests approval for message sends. Configure MCP connections and
credentials in your own local configuration.

Run the hook checks with:

```bash
node --test hooks/tests/*.test.mjs tests/*.test.mjs
bash -n bin/link hooks/claude/*.sh
zsh -n shell/develop.zsh
```

## Publication scope and attribution

This is a curated snapshot with fresh history. It includes generic tooling and
skills with identified public upstream sources. Internal configuration,
organization-specific skills, local credentials, private dependencies, and
material with unresolved publication rights are excluded.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for skill sources and license
terms. Upstream licenses continue to apply; this repository does not relicense
third-party material.
