# Workbench design

Mim is a local instrument for directing capable CLI agents and reviewing the
files they change. The visual posture is dense, quiet, tactile, and precise.
It should remain comfortable for hours of terminal and document work.

## Three-pane grammar

```text
+----------------+---------------------------+---------------------------+
| Sidebar        | Activity header           | Editor header             |
| workspace      +---------------------------+---------------------------+
| launchers      | terminal / agent / Files  | tabs                      |
| core surfaces  | App / Routine             | inline AI / diff          |
| Activities     |                           | CodeMirror / comments      |
+----------------+---------------------------+---------------------------+
```

The panes run edge to edge. Depth comes from `chrome` to `chrome-high` to
`surface` plus one-pixel rules, never pane cards or shell shadows.

Default expanded widths are Sidebar 240px, Activity 560px, and Editor 520px.
Sidebar is capped between 180px and 320px; both content panes keep a 336px
minimum when space allows.

## Rail contract

The permanent rail system is the signature:

- Sidebar collapses to 52px using the same mounted component.
- Activity and Editor collapse to 44px rails.
- Stable destinations retain icons.
- Dynamic Activities retain order and use deterministic one- or two-character
  monograms with status overlays and native title tooltips.
- Row geometry stays aligned between expanded and collapsed Sidebar states.
- Activity and Editor never both remain railed.
- Restore controls live in adjacent pane headers so the shell is recoverable.

Railing a pane must not discard its working state. In particular, switching
Activities must not alter Editor tabs, selection, unsaved content, or diffs.

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
- Motion preserves spatial continuity and respects reduced-motion preferences.

## Implementation rules

- Use Tailwind utilities backed by tokens in `src/shared/styles/app.css`.
- Use component CSS for CodeMirror/xterm internals, native chrome,
  layout mechanics, and animation keyframes.
- Keep shell panes square and flush. Rounding belongs to local controls,
  popovers, tabs, and dialogs.
- Keep one accent per theme and use add/remove colors only for diffs and status.
- Test shell changes with all panes expanded, each rail state, and a narrow
  window.
