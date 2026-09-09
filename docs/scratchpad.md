# Scratchpad

Scratchpad is one shared Markdown document for short writing sessions. It is
global across projects and agents. It has one timeline of saved text. There
are no task boundaries, named drafts, or special agent write tools.

## Use

- Type `@scratchpad` in a supported agent terminal and select the file.
  Ask the agent to edit it with its normal file tools.
- **Tools → Scratchpad** and **Cmd+P → Scratchpad** open the same Editor tab.
  They do not open a main tab. Graph remains a main-tab tool.
- Agent writes reveal the Editor tab without taking keyboard focus. An active
  review, another focused document, or a displayed history entry stays in place
  with an update notice. In a one-pane window, an external write does not hide
  the terminal.
- Typing saves after a short pause, including when normal file auto-save is off.
- **Previous / Next** show saved text without changing the live file.
  **Latest** returns to the live document. **Changes** shows additions and
  removals from the preceding save. **Restore** writes the selected text as the
  latest state. Later text remains in history.
- **Clear** saves empty text; the prior content stays in history. **Copy** copies
  only authored text. **Save As** exports a copy and keeps the shared tab.
- Closing the tab hides it. The next external write can open it again.

## Storage and conflicts

`~/.mimir/scratchpad.md` is the actual file. Its HTML comment explains the shared
path to readers outside Mimir. The Editor omits that comment. Mimir adds it back
after a whole-file write.

Native `scratchpad.rs` keeps the last 100 settled states in
`~/.mimir/scratchpad-history.json`, using the shared atomic persistence helpers.
It samples external writes every 500 ms while Mimir runs. Several writes inside
one interval can become one state. While Mimir is closed, only the final text
can be captured on the next launch. The timeline is local to this Mac.

The renderer saves against the text it last read. If the file changed in the
meantime, the save fails and the dirty Editor text stays intact. **Keep my text**
and **Use latest** retain both sides in the same timeline. Ordinary file tools
do not share a write lock with Mimir; the timeline cannot guarantee capture of
every intermediate byte during simultaneous external writes.

History inspection is read only and stays on the selected text during new saves.
The live buffer, document tabs, and pending reviews remain mounted.

## Project links and terminal completion

Opening a workspace or launching a supported agent prepares
`<working-directory>/scratchpad.md → ~/.mimir/scratchpad.md`. A normal file, a
tracked file, or a link to another target is never replaced or ignored.

For a Git repository, the link receives an anchored path rule in the repository's
local `info/exclude`, resolved with `git rev-parse --git-path`. No global ignore
file or project `.gitignore` is changed. Git shares `info/exclude` between linked
worktrees, so its rule also applies at the same relative path in sibling worktrees.
Tracked files remain tracked.

Codex and Pi need `!/scratchpad.md` in the working directory's `.ignore` to find
the Git-excluded link. Existing content is preserved. If Mimir creates `.ignore`,
it also excludes that file locally. If `.ignore` already exists and is tracked,
the appended rule appears as a normal project change. The native setup checks
that Git excludes the link. Ignore files that are themselves symbolic links are
left unchanged; Mimir reports the setup problem and the agent can still launch.

Mimir Files omits links to the central Scratchpad. Finder can show them.
`~/.mimir/scratchpad-links.json` records prepared links. If an external editor
replaces an owned link with a normal file, Mimir retains the central text in
history, saves the detached text, moves the detached file to
`scratchpad-recovered-<time>.md` beside the link, and restores the link. An unrelated
replacement symlink is left alone.

| Agent | Completion and launch integration |
|---|---|
| Codex | Native project-file completion; adds `~/.mimir` with `--add-dir`. Existing sandbox settings stay in effect. |
| Claude Code | A run-local `fileSuggestion` command returns the canonical path for `@scratchpad`. Its Edit tool refuses symlink paths. The helper forwards an existing suggestion command or searches normal project files with `rg`, with Git as a fallback. Explicit settings are preserved. Adds `~/.mimir` with `--add-dir`. |
| Pi | Native project-file completion and file tools; no extra directory option. |
| Gemini CLI | Native project-file completion; adds `~/.mimir` with `--include-directories`. Gemini retains its own workspace trust prompts. |

These launch options apply to new Mimir agent sessions. For agents launched
directly in an external terminal, the prepared project link remains available,
but their own sandbox, trust, and completion settings apply. A name collision
leaves the project's file intact; use the canonical path for the shared document.

## Source and checks

- Native storage, link preparation, and recovery: `src-tauri/src/scratchpad.rs`.
- Launcher integration: `src-tauri/src/launchers.rs`, `bin/mimir-file-suggestion.mjs`.
- IPC and state: `src/services/scratchpad.js`, `src/stores/scratchpad.js`.
- Editor integration: `useScratchpadEditor.js`, `ScratchpadBar.vue`, and
  `ScratchpadHistory.vue` under `src/editor/`.
- Native tests cover conflict rejection, retention, restore, header preservation,
  file collisions, local exclusions, linked worktrees, and replaced links.
  Renderer tests cover focus, history browsing, conflicts, Clear, and global tabs.

Today remains the daily planning tool. It has separate storage and behavior.
