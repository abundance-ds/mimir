# Product synthesis

Mim 0.1.0 combines a fast local editor with a polished environment for CLI
agents. It is for one person and a few teammates, so the surface stays calm
while the capability layer remains broad and hackable.

## Core idea

CLI agents are the primary intelligence. Mim gives them a terminal, a stable
editor they can control through MCP, a recent-first file inbox, locally defined
apps, and scheduled routines. Native model calls are concentrated in the
editor's inline agent and ghost completion.

## Product laws

1. **Activities are the execution UI.** Terminals, agents, apps, and routine
   runs use one lifecycle and one sidebar tray.
2. **MCP is the capability layer.** Agents, apps, routines, and `mimx` share one
   discoverable registry.
3. **The Editor is the review surface.** Activity navigation never replaces the
   document being reviewed.
4. **Files is a review inbox.** Last-edited-first is the default, with path
   filtering, bounded content search, and global quick-open.
5. **Power extends through the kernel.** New capabilities usually arrive as a
   tool, app, routine, launcher preset, or Activity rather than permanent UI.
6. **Trusted and hackable beats administered.** Configuration is local and
   explicit; the product assumes a small trusted team.

## Shape

The workbench is a three-pane Sidebar / Activity / Editor layout. Every pane
resizes, every pane can become a mounted rail, and at least one content pane
remains expanded. The Sidebar's collapsed rail preserves launcher icons,
Activity source icons, ordering, and status.

The Sidebar owns launch and navigation. The Activity pane owns execution and
local instruments. The Editor owns authored files, inline model interaction,
reviewable diffs, and comments.

The project switcher keeps the current folder and a small most-recent-first
list at the top of the Sidebar. Active Activities remain the default working
set; archived rows stay behind an explicit counted disclosure instead of
accumulating in daily navigation.

## Kernel

- **Activity supervisor:** native PTYs, exact argv, durable agent/routine
  records, bounded scrollback, resume strategies, status events, archive/clear.
- **Tool registry:** canonical names plus MCP aliases, schema validation,
  cancellation, live revision events, core UI handlers, and app-contributed
  providers.
- **Files:** native metadata index ordered by modification time, fast path
  filtering, bounded content search, and Cmd/Ctrl+P.
- **Apps:** built-in Changes plus a searchable catalog of local instruments
  manager for TOML definitions that embed UI, launch
  terminals/processes/windows, call tools, or use Rust helpers. Safe definition
  creation/duplication/title/Trash operations are shared with MCP; package
  management, trust, permission, and team ceremony are intentionally absent.
- **Routines:** TOML cron schedules that resolve launcher presets and create
  ordinary durable agent Activities.
- **Editor:** CodeMirror Markdown, tabs, formatting toolbar, optional paper
  line numbers, autosave, live in-editor Markdown rendering, Cmd+K inline AI,
  `++` ghost completions, diff review, and inline pseudo-XML comment
  discussions.

## Surface boundary

Mim has no general-purpose internal chat. The permanent navigation remains
Sidebar, Activity, and Editor. Additional workflows belong in Apps, tools,
Routines, or launcher presets.
