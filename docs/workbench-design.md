# Workbench design

Shell-specific layout for Mimir's three-pane workbench. For visual and
interaction rules see [design-system.md](design-system.md).

## Three-pane grammar

```text
+----------------+---------------------------+---------------------------+
| Sidebar        | Activity header           | Editor header             |
| workspace      +---------------------------+---------------------------+
| Tools          | terminal / agent / Files  | tabs                      |
| New activity   | App instance / Routine    | inline AI / diff          |
| Activities     |                           | CodeMirror / comments      |
+----------------+---------------------------+---------------------------+
```

The panes run edge to edge. Depth comes from `chrome` to `chrome-high` to
`surface` plus one-pixel rules, never pane cards or shell shadows.

Default expanded widths are Sidebar 240px, Activity 560px, and Editor 520px.
Sidebar is capped between 180px and 320px; both content panes keep a 336px
minimum when space allows.

Editor is mounted and expanded on startup, even if an older persisted layout
had hidden it. In the ordinary split, Activity consumes the flexible width and
Editor uses its remembered width. When Activity becomes a rail, Editor becomes
the flexible pane and immediately reclaims all released space.

## Header control grammar

Pane controls are local and keep stable positions:

- Sidebar collapse lives in the Sidebar's top chrome. Its bottom footer is
  reserved for Settings.
- The Sidebar top chrome is an empty draggable cap: workspace identity begins
  below it, clear of the macOS traffic lights. When the 52px rail bridges into
  Activity, that header adds a traffic-safe leading inset before restore and
  history controls.
- Activity history sits at the leading edge of the Activity header.
- PTY-specific process actions such as interrupt and resume join that
  shared header. Native terminal interactions such as paste stay on their
  standard keyboard shortcuts. Terminal and agent surfaces do not stack a
  second identity or status row beneath it.
- Activity and Editor each place expand/restore-split immediately before their
  outer-edge collapse control.
- In embedded Editor mode the tab strip owns all width between the restore
  cluster and pane controls. The standalone-window drag spacer is not mounted
  inside the workbench, so it cannot reserve a second empty flexible region.
- Expand focuses one content pane by railing its sibling; restore-split opens
  both panes again.
- Activity collapses toward the left rail; Editor collapses toward the right.
  Arrow-bar icons describe that direction. Maximize icons are not used for
  collapse.
- When left panes are railed, the first expanded header owns their restore
  cluster. The corresponding Activity rail keeps a quiet top cap so duplicate
  restore icons are not presented.

## Rail contract

The permanent rail system is the signature:

- Sidebar collapses to 52px using the same mounted component.
- Activity and Editor collapse to 44px rails.
- Stable destinations retain icons.
- Dynamic Activities retain order and use source-specific Codex, Claude, Pi,
  Gemini, Terminal, App, and Routine icons with status overlays and native
  tooltips. In manual order, each Activity gets a saved position at the top of
  the list when it first appears. Output and status changes never move a row.
- Row geometry stays aligned between expanded and collapsed Sidebar states.
- The project mark opens the same teleported current/recent-folder switcher in
  expanded and rail states; switching never requires first expanding Sidebar.
  The trigger alone identifies the current project. Its anchored switcher
  focuses the filter immediately, shows a bounded recent set when empty, and
  searches the complete retained project history by name or path. Project rows
  contain only name and parent path. Projects with live Activities remain
  searchable without exposing Activity counts or status. Opening the switcher
  starts one cached native batch check without delaying the popover. Confirmed
  missing recent folders leave the projection; a missing folder retained by a
  live Activity stays visible as a disabled `Missing` row. Metadata failures do
  not hide a folder. If the open workspace is missing, its trigger shows that
  state until the user opens another folder. Open project and
  Create project remain keyboard-accessible final actions. The display bound
  lives in `WorkspaceSwitcher.vue`.
  The workspace projection and background-runtime contract live in
  [activities.md](activities.md#workspace-projection).
- Tools remain directly available. Chats and Activities have independent
  disclosure controls in the expanded Sidebar. Rail mode keeps one Chats hub,
  whose room switcher is defined in [chat.md](chat.md), plus stable destinations
  and live Activities. The Activities `+` and
  Cmd/Ctrl+P expose fresh-run sources without duplicating them as permanent
  rows. Tools keep a persistent manual order via pointer drag or
  Shift+Alt+Up/Down. App management lives in Settings.
- Closed Activities do not form a Sidebar list. Cmd/Ctrl+P History searches
  useful task/workspace metadata and bounded transcript text, then restores the
  selected Activity into the working set. Scope filters what you browse;
  search reaches every project, labelled by where each session lives.
- Expanded Sidebar Activity rows support multi-selection: Cmd/Ctrl+click
  toggles a row, Shift+click extends a range from the last toggle (or the
  active Activity). A selection strip above the rows names the count and
  offers batch Archive (stopped durable or terminal rows) and Delete (stopped
  rows);
  running rows are never batch-archived or batch-deleted. When the Sidebar
  owns close focus, Cmd/Ctrl+W and native Close close every selected row
  through the normal close path (stop live runs, archive durable and terminal
  rows, clear other ephemeral rows). Escape (outside menus, rename, and the
  content panes), a plain activation click, or collapsing to the rail clears
  the selection.
- Activity and Editor never both remain railed.
- Restore controls live in adjacent pane headers so the shell is recoverable.

Railing a pane must not discard its working state. In particular, switching
Activities must not alter Editor tabs, selection, unsaved content, or diffs.
In a compact window, the visible Editor width is fitted against the live
viewport after the 52px Sidebar rail and 336px Activity minimum. The remembered
desktop width is not overwritten, so a large-display preference returns when
space returns without ever clipping the current shell.
Below the single-pane threshold, every restore/expand entry point switches the
focused content pane and rails its sibling; header controls cannot accidentally
recreate an overflowing two-pane split.

## Go to

Cmd/Ctrl+P opens a compact grouped launcher near window top.

- Empty view: Start new activity, Tools, recent projects, recent files, and
  Reopen last closed (open project only). Entering Start new activity drills
  into launch sources; Back/Backspace/Escape returns.
- Current Activities excluded (Option/Alt+Cmd/Ctrl+Left/Right cycles them).
- Without a prefix, typing filters New activity, Tools, Projects, Files, Chats,
  and History together. A group is present only when it has a match. Groups
  keep that order and show a bounded mixed result set; exact and name-prefix
  matches rank first inside a group. Arrow keys cross group boundaries and
  skip headings. Result bounds live in `quickOpenResults.js`.
- Typed scopes are `n:` New activity, `t:` Tools, `p:` Projects, `f:` Files,
  `c:` Chats, and `h:` History. A scoped search shows the full bounded result
  set for that group. Group headings teach their scope prefix.
- `h:` History browses the open project only; the empty state points to search.
  A search term reaches every project, open-project matches first; rows from
  another project carry a project chip, and selecting one switches to that
  project before restoring.
- `p:` browses every retained project except the current one. With an empty
  term it also offers Open project and Create project. A project result
  switches directly.
- Cmd/Ctrl+N in CLI agent or terminal focus opens Go to in New activity with current launcher selected. Editor, Files, Routines keep local Cmd/Ctrl+N meanings.
- Autocorrect, autocapitalize, autocomplete, and spellcheck disabled on search fields.

Workbench teardown snapshots layout and Activity-order preferences before
exit. Native quit confirms dirty documents, then flushes the settings queue.
