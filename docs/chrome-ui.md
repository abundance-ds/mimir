# Shell chrome

This document owns the workbench chrome: every bar, band, rail, footer,
canvas, and overlay, which layer each one sits on, and how they relate to
their neighbours. [design-system.md](design-system.md) owns tokens and
controls; this page owns where those tokens go.

## Shared implementation

`src/shared/ui/chrome/` owns common panel chrome (`PaneBand`, `PaneTabStrip`,
`PaneTab`, `PaneTabButton`, `PaneTabClose`). Main and Editor use these same
tab parts; neither defines a local tab skin. In Dark Contrast, inactive tabs
have an inset one-pixel outline in the rule colour.

`PaneRestoreControls` and `PaneSizeControls` render layout actions.
`paneControls.js` owns the six-state placement policy, including Main's quiet
rail. Changes to common appearance belong in the shared parts, never in a
local Main or Editor override.

`PaneChrome.test.js` rejects local tab skins and checks bar ownership.
`check-pane-controls.mjs` checks geometry and control ownership.
`harness/pane-chrome-matrix.html` shows all six layouts together.

## 1. Layers

The four shell tokens are one depth scale. `chrome` is the ground.
`chrome-mid` is one step up. `chrome-high` is two steps up. This order holds
in all themes. `surface` does not belong to the scale: it is the
lightest layer in light, slate, and monokai; it is darkest in slate-contrast.
It sits between `chrome` and `chrome-mid` in zenith, between `chrome-mid`
and `chrome-high` in dracula, and equals `chrome-mid` in synthwave.

| Token | Depth | Purpose | May be used for |
|---|---|---|---|
| `chrome` | ground | Window ground, quiet bands | Sidebar, top band, status footers, board columns, `#app` |
| `chrome-mid` | +1 | Hover on ground, quiet emphasis | Hover on `chrome` rows and buttons, sticky group headers, hover on plates |
| `chrome-high` | +2 | Instruments and plates | Toolbars, sub bars, rails, cards, input footers, banners |
| `surface` | canvas | Authored content and floating UI | Editor document, chat transcript, terminal, journal, menus, popovers, dialogs, sidebar project box |
| `rule` | | Pane and bar separation | Below row 1 and row 2, above footers, pane edges |
| `rule-light` | | Row separation inside one block | Below row 3, between rows and cards |
| `accent`, `accent-soft` | | The one hue | Primary button, selection, focus ring |
| `rem` | | Failure | Error banners, overdue, destructive |

Rules that follow from the scale:

- A bar is never `surface`, because `surface` changes side between themes.
- Hover goes one step: `chrome` to `chrome-mid`, `chrome-high` to
  `chrome-mid`. Hover never uses `surface`.
- Only overlays get shadow and radius. Bars and panes are square hairlines.

## 2. The window grid

Three columns, one band across the top, one row grammar below it.

```
 Sidebar 280      Activity 560                 Editor 520
 ┌───────────────┬────────────────────────────┬──────────────────────────┐
 │ top 40        │ pane header 40             │ editor header 40, tabs   │ row 1: band
 │               ├────────────────────────────┼──────────────────────────┤
 │ rows 24       │ bar 36                     │ toolbar 36               │ row 2: bar
 │               │ sub bar 28                 │                          │ row 3: sub bar
 │               │                            │                          │
 │               │ content                    │ document, surface        │ canvas
 │               │                            │                          │
 │ settings 26   │ status 26 or input ≥36     │ status 26                │ footer
 └───────────────┴────────────────────────────┴──────────────────────────┘
```

Everything in one row must share height, layer, and rule. That is the whole
rule. A pane may leave a row empty. A pane may not put a different height or
layer into a row.

Row 1 is a band, not three headers. It carries the workspace switcher, the
Activity title with its meta line and actions, and the Editor tabs. The
band must be one layer from edge to edge, and it must be the ground layer,
`chrome`, for two reasons: the sidebar under it is `chrome`, and the Editor
tabs need a raised active tab, which is only possible on the ground.

## 3. Inventory

`paneChromeInventory.js` is the normative bar list. `PaneChrome.test.js`
enforces that each listed bar uses its pane-chrome kind and does not size or
colour itself.

Constraints not expressed in the inventory:

- Routines and Tracker must not draw their own identity header. Their status
  and primary actions go into the Activity pane header through `usePaneChrome`.
- Today, Chat, Terminal, and agent sessions have no row 2.
- The compact Files sidebar uses a 28 px strip on `chrome`; the wide File
  Manager uses `pane-bar`. [Files](files.md) owns their behavior.
- The Graph entry detail header (`GraphEntryDetails.vue`) is 36 px on
  `surface` with `rule-light`. It is not in the inventory; it sizes itself.

### Canvases

| Surface | Layer |
|---|---|
| Editor document | `surface`, 28 px inset |
| Chat transcript, Terminal, Today journal | `surface` |
| Files tree (wide manager) | `surface`, hover `chrome-high` |
| Files tree (sidebar) | `chrome`, hover `chrome-mid`, selection `chrome-high` |
| Routines, Tracker | `chrome-high` root |
| Graph board | `chrome` columns, `chrome-high` cards, hover `chrome-mid` |
| Graph list | `chrome-mid` sticky headers, rows 34 px |
| Sidebar | `chrome`, hover `chrome-mid`, project box `surface` |

### Banners

Banners stack next to a bar. They are not counted as a row.

| Surface | Layer |
|---|---|
| Terminal, Tracker, Routines errors | `rem` at 5 % |
| Today carry-over prompt | `chrome-high` |

### Overlays

| Surface | Layer |
|---|---|
| Menus, date picker | `surface`, 1 px `rule`, 3–5 px radius, shadow |
| Dialogs | `surface`; `dialog-header` class is 36 px `chrome-high` with `rule` |
| Quick open | own; 44 px top cell |

### Control sizing

| Control | Height |
|---|---|
| `pane-icon-button` | 28 px |
| `size-6` icon button | 24 px |
| Editor toolbar button | 22 px |

## 4. How the pieces relate

1. Row 1 is one 40 px band on `chrome`. It names the place and holds the tabs.
2. Row 2 is the instrument on `chrome-high`. It is the first thing under the
   band in every pane that has tools. One height, one layer, so the Editor
   toolbar and the Files tabs read as one line across the split.
3. Row 3 belongs to row 2. Same layer, lighter rule. It refines what row 2
   selected: columns for a tree, views and filters for a projection.
4. The canvas is `surface` for authored content and `chrome` for boards
   that carry `chrome-high` plates. A list on a `chrome-high` root uses
   `chrome-mid` group headers so the headers are darker than the rows.
5. Footers are the ground again. A status footer is `chrome` and mono. An
   input footer is `chrome-high` because it is an instrument.
6. Overlays are the only things that float. `surface`, hairline, small
   radius, shadow.
7. Tool-row insets are 12 px in Activity and Editor. The Editor document and
   status footer use 28 px. That larger inset is a document margin, not a bar
   inset.
8. Type follows depth: band 12 px with mono 9 px meta; bar 11 px; sub bar
   10 to 11 px; footer mono 10 px; rows 12 to 13 px.

## 5. Expanded and rail states

`paneControls.js` is the normative six-state placement policy (Sidebar, Main,
Editor; each expanded or rail; Main and Editor never both rail).
[workbench-design.md](workbench-design.md#pane-grammar) owns sizes and
collapse rules.

- Each content header keeps one Expand / Restore split toggle at a fixed
  position; the toggle keeps focus. Collapse is a separate action and opens the
  opposite pane if necessary. A restore action moves focus into the restored
  pane.

Visual constraints:

- macOS window buttons start at x=14 and extend past the 52 px Sidebar rail.
  The quiet Main rail top cell leaves this area free.
- Header action buttons are 28 by 28 px, 15 px icons at stroke width 1.8,
  centred in the 39 px interior above the bottom rule.
- Tabs are 28 px, bottom-aligned to the rule. New Tab sits outside the
  scrolling tab list.

`PaneControls.test.js` checks all six states, restore ownership, and focus.
`scripts/check-pane-controls.mjs` runs browser checks via Puppeteer Core.

## 6. Sidebar icon positions

All Sidebar items share an icon centre 26 px from the left edge in both
expanded and rail states. Navigation rows keep their height through collapse.

- Navigation rows never shrink and have no nested scroll areas. In the rail,
  the Tools heading becomes Expand sidebar.
- The Scribe recording strip is 48 px in both states, sits directly below the
  Scribe tool row, and follows it when Tools are reordered. Recording dot and
  Stop use `rem`. The status uses a live region; the clock does not.
- Files resize rule: 8 px hit target, 2 px hover/focus highlight. Behavior
  belongs to [workbench-design.md](workbench-design.md#sidebar-and-main-tabs).

`scripts/check-sidebar-geometry.mjs` and `scripts/check-activity-states.mjs`
run browser checks against the running dev server (port 1420) via Puppeteer
Core (`PUPPETEER_MODULE=/absolute/path/to/puppeteer-core`). They do not prove
native input behavior.
