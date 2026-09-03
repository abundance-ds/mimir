# Editor

The Editor stays mounted while Activities change. `src/editor/App.vue` composes
the surface; composables own lifecycle, synchronization, proposals, commands,
and cleanup. `src/stores/files.js` owns open files and save state.

## Files and tabs

- Tabs are `text`, `pdf`, or `external`. Inspect files before opening; only text
  enters CodeMirror and UTF-8 read/write commands.
- A single click opens a clean preview; editing or pinning makes it persistent.
- Project tabs are hidden, not closed, when the workspace changes. Dirty state
  and reviews remain attached to their stable file id.
- Files outside retained projects and untitled drafts are global. The
  standalone Editor shows all tabs.
- External changes replace only clean buffers. Missing dirty files recover as
  drafts; missing clean files disappear.
- Session hydration completes before fallback draft creation, persistence,
  native listeners, file-open draining, and Quit guards.
- Save, rename, move, and Trash must settle pending Editor writes before paths
  or ownership change.

## CodeMirror surface

`src/editor/codemirror/` owns formatting, live Markdown preview, comments, and
ghost completion. The file store is the durable renderer state; CodeMirror is
the active document projection. Toolbar pointer actions preserve focus and
selection.

## Proposal and Git review

- Rust owns proposal lifecycle; the renderer owns presentation and dirty
  buffers. Accept or reject is complete only after `proposal_respond` succeeds.
- Pending proposals survive restart. A source mismatch keeps the review open
  for recheck or explicit discard.
- Single-file review is bound to a stable file id, not a visible tab index.
- Git review uses a separate store and read-only virtual tab. It never accepts,
  rejects, or clears a proposal.
- Stage and unstage verify the loaded native snapshot. Stage is unavailable
  while the matching Editor buffer has unsaved text.
- Restoring file History writes a new working change; it does not rewrite Git
  history.

## Agent, AI, and comments

The Editor command bridge can inspect tabs, content, selection, and comments;
open or reveal a location; replace content; save; and present a proposal. The
public projection is defined in [agent-interface.md](agent-interface.md).

Cmd/Ctrl+K and ghost completion are described in [inline-ai.md](inline-ai.md).
Comments are pseudo-XML stored in Markdown and rendered as protected block
widgets; see [comments.md](comments.md). File classification and managed
Project Git are in [files.md](files.md).
