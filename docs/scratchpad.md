# Scratchpad

Scratchpad is one shared Markdown document for short writing sessions. It is
global across projects and agents. It has one timeline of saved text. There
are no task boundaries, named drafts, or special agent write tools.

## Behavior

- Agent writes reveal the Editor tab without taking keyboard focus. Active
  reviews, focused documents, or history views stay in place with an update
  notice. One-pane windows keep the terminal visible.
- Background reveals keep the Editor's scroll position instead of scrolling
  to the start. Large text replacements can still move the visible content.
- Typing saves after a short pause, even when auto-save is off.
- Save As to a project Scratchpad link saves the shared document and keeps the
  link intact.
- Closing the tab hides it. The next external write reopens it.
- History is append-only: Restore and Clear add a new latest state. History
  inspection is read-only; the live buffer stays mounted.
- Mimir Files omits links to the central Scratchpad.

## Storage and conflicts

`~/.mimir/scratchpad.md` is the file. The Editor strips the HTML comment header;
Mimir adds it back after a whole-file write.

`scratchpad.rs` keeps the last 100 settled states in
`~/.mimir/scratchpad-history.json`. It polls external writes every 500 ms while
Mimir runs; several writes in one interval merge to one state. While Mimir is
closed, only the final text is captured on the next launch.

The renderer saves against the text it last read. A concurrent change fails the
save and keeps the dirty Editor text. Both conflict choices keep both texts in
the timeline. File tools do not share a write lock; the
timeline cannot guarantee capture of every intermediate byte.

## Project links and terminal completion

Mimir prepares `<working-directory>/scratchpad.md → ~/.mimir/scratchpad.md`
on workspace open or agent launch. A normal file, tracked file, or link to
another target is never replaced.

- Git exclude: anchored rule in the repository's local `info/exclude`, resolved
  with `git rev-parse --git-path`. No global ignore or `.gitignore` is changed.
  Applies to sibling worktrees that share `info/exclude`.
- `.ignore`: Codex and Pi need `!/scratchpad.md` in `.ignore` to find the
  Git-excluded link. Mimir appends it and preserves existing content. A created
  `.ignore` is excluded locally; a tracked `.ignore` shows a normal project
  change. Symbolic-link `.ignore` files are left unchanged. Setup failure is
  reported; the agent still launches.
- Recovery: `~/.mimir/scratchpad-links.json` records prepared links. If an
  external editor replaces an owned link with a normal file, Mimir saves the
  detached text to the timeline, moves the file to
  `scratchpad-recovered-<time>.md`, and restores the link. An unrelated
  replacement symlink is left alone. Links are registered
  before ignore rules, so a failed ignore update does not disable recovery.
  If Git starts tracking a replacement, Mimir stops managing that path and
  does not recreate the link.

| Agent | Integration |
|---|---|
| Codex | `--add-dir ~/.mimir` |
| Claude Code | Its Edit tool refuses symlink paths: a run-local `fileSuggestion` command (`bin/mimir-file-suggestion.mjs`) returns the canonical path and forwards an existing suggestion command. Explicit settings are preserved. `--add-dir ~/.mimir` |
| Pi | Native completion; no extra directory option |
| Gemini CLI | `--include-directories ~/.mimir` |

A name collision leaves the project's file intact; use the canonical path.

Today remains the daily planning tool with separate storage and behavior.

## Verification

`bun run test:scratchpad` runs renderer, Editor integration, CLI helper, and
native tests. Before release, test all four agents in the signed app: agent
writes, conflict handling, tab recovery across restart, Undo/Redo isolation
between Scratchpad and project documents.
