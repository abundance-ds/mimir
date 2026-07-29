# Workbench design

Mimir is a local instrument for directing capable CLI agents and reviewing the
files they change. The visual posture is dense, quiet, tactile, and precise.
It should remain comfortable for hours of terminal and document work.

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
- PTY-specific process actions such as interrupt, stop, and resume join that
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
  tooltips.
- Row geometry stays aligned between expanded and collapsed Sidebar states.
- The project mark opens the same teleported current/recent-folder switcher in
  expanded and rail states; switching never requires first expanding Sidebar.
- Tools remain directly available. Chats and Activities have independent
  disclosure controls in the expanded Sidebar; rail mode keeps stable
  destinations and live Activities available. The Activities `+` and
  Cmd/Ctrl+P expose fresh-run sources without duplicating them as permanent
  rows. Tools keep a persistent manual order via pointer drag or
  Shift+Alt+Up/Down. App management lives in Settings.
- Closed Activities do not form a Sidebar list. Cmd/Ctrl+P History searches
  useful task/workspace metadata and bounded transcript text, then restores the
  selected Activity into the working set.
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

Cmd/Ctrl+P opens a compact launcher at a fixed near-window-top offset rather
than a tall centered palette. The empty view starts with Start new activity,
then Tools, recent files, and Reopen last closed. Entering Start new activity
replaces those root results with launch sources; Back, empty-query Backspace,
or Escape returns without closing Go to. Current Activities are deliberately
absent because
Option/Alt+Cmd/Ctrl+Left/Right already cycles them.

Typing searches Tools, launch sources, closed History, and indexed files.
`/` restricts results to files, `@` to History, and `+` to New activity.
History transcript search is lazy and native; recent files remain visible in
the empty state because Go to is the fastest keyboard route back to files.
The document root disables autocorrect and autocapitalization; focused search
fields also disable autocomplete and spellcheck so operating-system suggestion
UI does not cover launcher results.

Layout and Activity-order preferences remain debounced during interaction, but
Workbench teardown explicitly snapshots and flushes them. Native quit confirms
dirty documents first, then awaits the ordered settings queue before allowing
the Rust host to exit, so a final resize or reorder cannot disappear.

## Palette and typography

Parchment is the reference theme:

| Role | Reference |
|---|---|
| outer chrome | `#ebe9e3` |
| high chrome | `#f9f8f5` |
| work surface | `#ffffff` |
| primary ink | `#1a1a18` |
| signal accent | `#c05d3c` |
| structural rule | `#d8d7d2` |

The native system UI stack carries controls, readable status, and prose. The
native system monospace stack carries paths, flags, terminal text, timestamps,
metadata, and Activity monograms. No product surface uses serif.

Color communicates state rather than product category. Agent, app, routine,
and terminal kinds do not receive separate brand palettes. The theme accent
marks selection, activity, focus, and attention.

## Interaction

- Hover feedback is immediate and uses a nearby chrome level.
- Focus uses `:focus-visible`.
- Primary copy uses direct verbs: Open, Stop, Resume, Archive, Clear, Run now.
- Status copy is short and factual: Working, Input, Done, Stopped, Error.
- Empty states identify the next useful action.
- Failures name the failed object and remain recoverable.
- Pane state changes are immediate. Local motion may preserve spatial
  continuity and must respect reduced-motion preferences.
- Selecting an Activity lands keyboard focus inside its surface. Surfaces
  expose `focusEntry()` for this; WebKit leaves focus on `<body>` after
  Sidebar clicks, so the workbench calls it explicitly instead of relying on
  click focus (see gotchas.md).
- Cmd+Plus/Minus step whole-window interface zoom and Cmd+0 resets it, in
  every focus context including modals, Quick Open, and PTYs. The chords never
  reach a terminal or CodeMirror. Editor content zoom has no keyboard chord;
  it lives on the editor footer.

## Implementation rules

- Use Tailwind utilities backed by tokens in `src/shared/styles/app.css`.
- Use component CSS for CodeMirror/xterm internals, native chrome,
  layout mechanics, and animation keyframes.
- Keep shell panes square and flush. Rounding belongs to local controls,
  popovers, tabs, and dialogs.
- Keep one accent per theme and use add/remove colors only for diffs and status.
- Test shell changes with all panes expanded, each rail state, and a narrow
  window.
