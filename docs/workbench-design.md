# Workbench design

Mim is a local instrument for directing capable CLI agents and reviewing the
files they change. The visual posture is dense, quiet, tactile, and precise.
It should remain comfortable for hours of terminal and document work.

## Three-pane grammar

```text
+----------------+---------------------------+---------------------------+
| Sidebar        | Activity header           | Editor header             |
| workspace      +---------------------------+---------------------------+
| core surfaces  | terminal / agent / Files  | tabs                      |
| Apps / agents  | App instance / Routine    | inline AI / diff          |
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
  Terminal, App, and Routine icons with status overlays and native tooltips.
- Row geometry stays aligned between expanded and collapsed Sidebar states.
- The project mark opens the same teleported current/recent-folder switcher in
  expanded and rail states; switching never requires first expanding Sidebar.
- Apps and Activities have independent disclosure controls in the expanded
  Sidebar. Their local state survives pane collapse because the Sidebar remains
  mounted; rail mode always exposes both icon lists so collapsing a section
  cannot strand navigation. The Apps gear is a separate Settings action.
- Archived Activities are a secondary set: a quiet counted disclosure is
  present, but archived rows are not rendered until the user asks for them.
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

IBM Plex Sans carries controls and readable status. IBM Plex Mono carries
paths, flags, terminal text, timestamps, metadata, and Activity monograms. IBM
Plex Serif is available for authored prose.

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

## Implementation rules

- Use Tailwind utilities backed by tokens in `src/shared/styles/app.css`.
- Use component CSS for CodeMirror/xterm internals, native chrome,
  layout mechanics, and animation keyframes.
- Keep shell panes square and flush. Rounding belongs to local controls,
  popovers, tabs, and dialogs.
- Keep one accent per theme and use add/remove colors only for diffs and status.
- Test shell changes with all panes expanded, each rail state, and a narrow
  window.
