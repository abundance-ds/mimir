# Agent Setup

Mim Panel exposes editor control in two ways:

1. `mimx`, a CLI for terminal agents.
2. The local MCP endpoint already served by the app at `http://127.0.0.1:17532/mcp`.

The Mim Panel app must be running for either path to work.

## CLI

From this repo:

```bash
node bin/mimx.mjs active
node bin/mimx.mjs tabs
node bin/mimx.mjs content
node bin/mimx.mjs open /absolute/path/to/file.md
node bin/mimx.mjs reveal /absolute/path/to/file.md:42
node bin/mimx.mjs selection
node bin/mimx.mjs comments
node bin/mimx.mjs comments-prompt
node bin/mimx.mjs replace-selection --stdin
node bin/mimx.mjs set-content --stdin
node bin/mimx.mjs save
```

Install the local CLI command once:

```bash
cd /Users/waqr/Desktop/mim-panel
bun link
```

After linking, the command should be available as:

```bash
mimx active
```

## Claude Code MCP

Register the running Mim Panel app as an HTTP MCP server:

```bash
claude mcp add --transport http mim-panel http://127.0.0.1:17532/mcp
```

Expected editor tools:

```txt
editor_open
editor_active
editor_tabs
editor_content
editor_selection
editor_comments
editor_replace_selection
editor_set_content
editor_reveal
editor_save
```

## Codex

Register the running Mim Panel app as an HTTP MCP server:

```bash
codex mcp add mim-panel --url http://127.0.0.1:17532/mcp
```

The CLI is still useful as the lowest-friction fallback. Tell Codex to use it from the terminal:

```md
Use `mimx` to control the adjacent Mim Panel editor. If `mimx` is not on PATH, use `node /Users/waqr/Desktop/mim-panel/bin/mimx.mjs`.
Examples:
- `mimx active`
- `mimx open <path>`
- `mimx comments-prompt`
- `mimx replace-selection --stdin`
- `mimx save`
```

Put that in the relevant `AGENTS.md` or session instructions for now.

## Minimal Agent Instructions

Paste this into a coding-agent project if you want the agent to use the adjacent editor:

```md
Mim Panel is running beside this terminal.

Use MCP server `mim-panel` for editor operations when available.
If MCP is unavailable, use the `mimx` CLI:
- `mimx active` shows the active editor file.
- `mimx tabs` lists open editor tabs.
- `mimx open <path>` opens a file in the editor.
- `mimx content` reads the active editor content.
- `mimx selection` reads the current selection.
- `mimx comments` lists inline pseudo-XML comments in the active editor file.
- `mimx comments-prompt` prints a ready prompt for addressing inline comments.
- `mimx replace-selection --stdin` replaces the current selection.
- `mimx set-content --stdin` replaces the active document.
- `mimx reveal <path:line>` scrolls the editor to a location.
- `mimx save` saves the active editor file.
```

## Hook Pattern

For agent hooks, keep the hook thin: when the agent writes or updates a plan file, call:

```bash
mimx reveal /absolute/path/to/plan.md
```

That opens or focuses the file in Mim Panel without coupling the agent to the app internals. The exact hook event and file-path variable depend on the agent, but the hook body should stay this small.
