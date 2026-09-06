# Shell chrome

This document owns the workbench chrome: every bar, band, rail, footer,
canvas, and overlay, which layer each one sits on, and how they relate to
their neighbours. [design-system.md](design-system.md) owns tokens and
controls; this page owns where those tokens go. Verified on 2026-09-04.

## 1. Layers

The four shell tokens are one depth scale. `chrome` is the ground.
`chrome-mid` is one step up. `chrome-high` is two steps up. This order holds
in all eight themes. `surface` does not belong to the scale: it is the
lightest layer in light, slate, and monokai, it sits between `chrome` and
`chrome-mid` in dracula and zenith, and it equals `chrome-mid` in synthwave.

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
 Sidebar 240      Activity 560                 Editor 520
 ┌───────────────┬────────────────────────────┬──────────────────────────┐
 │ top 40        │ pane header 40             │ editor header 40, tabs   │ row 1: band
 │               ├────────────────────────────┼──────────────────────────┤
 │ rows 32       │ bar 36                     │ toolbar 36               │ row 2: bar
 │               │ sub bar 28                 │                          │ row 3: sub bar
 │               │                            │                          │
 │               │ content                    │ document, surface        │ canvas
 │               │                            │                          │
 │ settings 49   │ status 26 or input ≥36     │ status 26                │ footer
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

The sidebar top, Activity header, and Editor header now use `chrome` with a
`rule` below them. The Editor active tab can therefore rise from the ground
layer without making the band heavier than the sidebar.

## 3. Inventory as built

Heights include the rule. Layer is the background token.

### Row 1, the band

| Surface | File | Height | Layer | Rule | Content |
|---|---|---|---|---|---|
| Sidebar top | `WorkbenchSidebar.vue`, `WorkspaceSwitcher.vue` | 40 | `chrome` | `rule` | Collapse button, workspace name 12 px, meta mono 9 px |
| Activity pane header | `PaneFrame.vue` | 40 | `chrome` | `rule` | Previous, next, title 12 px, meta mono 9 px uppercase, contributed actions, expand, collapse |
| Editor header | `editor/components/shell/AppHeader.vue` | 40 | `chrome` | `rule` | Bottom-aligned file tabs; active tab is a neutral `chrome-high` plate; HTML open-in-browser, add, expand, collapse |
| Rail restore | `RailRestore.vue` | 40 top cell, full height | `chrome-high`, hover `chrome-mid` | `rule-light` | Vertical title of a collapsed pane |

### Row 2, the bar, 36 px `chrome-high` with `rule`

| Surface | File | Content | Before 2026-09-04 |
|---|---|---|---|
| Editor toolbar | `editor/components/workspace/EditorToolbar.vue` | Format buttons 22 px, 12 px inset | 30 px, `chrome-mid`, `rule-light` |
| Files view tabs | `FilesActivity.vue` | Project, Changes, Recent, Favorites with 2 px accent underline; three 28 px icon buttons | 40 px |
| Graph top bar | `business-graph/GraphAppHeader.vue` | Direct Work and Graph tabs 26 px at every width; search 28 px; scope 28 px; refresh; New | 40 px, `surface` mix, brand mark, wrapped to two rows under 1050 px |
| Tracker range | `TrackerApp.vue` | Range tabs, previous, range label, next | 36 px wrapping strip under a 40 px identity header |
| Scribe transport | `ScribeApp.vue` | Recording dot, timer, status, save state, Mute, Stop 28 px | 42 px `chrome` |
| Scribe detail bar | `ScribeApp.vue` | Back, save state, Continue, menu | 40 px |
| Scribe settings header | `scribe/ScribeSettings.vue` | Title | 40 px |
| PDF preview | `editor/components/workspace/PdfPreview.vue` | Page controls | 40 px |
| Image preview | `editor/components/workspace/ImagePreview.vue` | SVG view, Fit, actual size, zoom, native open | |
| File history | `FileHistoryPanel.vue` | Title, close | 40 px |
| Embedded app host | `EmbeddedAppHost.vue` | App name, controls | 36 px |
| Launch plan host | `LaunchPlanHost.vue` | Title | 40 px, no layer |

Routines and Tracker no longer draw an identity header. Their status line
and primary actions go into the Activity pane header through
`usePaneChrome` (`src/mimir/composables/usePaneChrome.js`). Today, Chat,
Terminal, and agent sessions have no row 2.

### Row 3, the sub bar, 28 px `chrome-high` with `rule-light`

| Surface | File | Content |
|---|---|---|
| Files ledger status | `FilesActivity.vue` | Mono 10 px status line |
| Files ledger columns | `FilesActivity.vue` | Mono 10 px column labels in the tree grid |
| Graph viewbar | `business-graph/GraphViewbar.vue` | View buttons 22 px; frequent task filters beside the views; Display at the right; narrow panes use clearable active-filter chips and a 24 px Filter button |

### Canvases

| Surface | Layer | Notes |
|---|---|---|
| Editor document | `surface` | Commit Mono, 28 px inset matches the status footer |
| Chat transcript, Terminal, Today journal | `surface` | |
| Files tree | rows on the pane ground, 28 px rows, hover `chrome` | |
| Routines, Tracker | `chrome-high` root | Section headers inside Tracker views are 28 px with `rule-light` |
| Graph board | `chrome` columns, `chrome-high` cards with `rule-light` edge and 2 px radius, hover `chrome-mid` | 8 px canvas inset and column gap; 252–420 px columns with a full `rule` edge; headers 38 px `chrome-high` inside each column |
| Graph list | sticky group headers 28 px `chrome-mid`, rows 34 px | |
| Sidebar | `chrome`, rows 32 px, hover `chrome-mid`, section kickers 24 px mono 9 px uppercase, project box `surface` with `rule` | |

### Footers

| Surface | File | Height | Layer | Rule | Content |
|---|---|---|---|---|---|
| Editor status | `editor/components/shell/AppFooter.vue` | 26 | `chrome` | `rule` | Words, save state, comments, zoom; mono 10 px |
| Files status | `FilesActivity.vue` | 26 | `chrome` | `rule` | Count, selection, workspace |
| Today status | `TodayApp.vue` | 26 | `chrome` | `rule` | Save state, date navigation 24 px |
| Routines status | `RoutinesActivity.vue` | 26 | `chrome` | `rule` | Directory, notice or revision |
| Launch plan | `LaunchPlanHost.vue` | 26 | `chrome` | `rule` | Plan state |
| Graph dispatch | `business-graph/DispatchBar.vue` | 36 | `chrome-high` | `rule` | Prompt, mono 11 px input, node count; overlay above on `surface` |
| Chat composer | `ChatActivity.vue` | grows, min 36 | `chrome-high` | `rule` | Bordered `surface` textarea, uploads |
| Sidebar settings | `WorkbenchSidebar.vue` | 32 | sidebar ground | `rule-light` | Settings row |

### Banners, not bars

| Surface | Layer | Rule |
|---|---|---|
| Terminal, Tracker, Routines errors | `rem` at 5 % | `rem` at 25 to 30 % |
| Today carry-over prompt | `chrome-high` | `rule` |
| Scribe inline notice | own style | |

Banners keep their own height and stack next to a bar. They are never
counted as a row.

### Overlays and dialogs

| Surface | Layer | Edge |
|---|---|---|
| Select menus, scope menu, columns menu, dispatch overlay, date picker | `surface` | 1 px `rule`, 3 to 5 px radius, shadow |
| Graph create, confirm, summary dialogs | `surface` | own header and footer |
| Routines dialogs | header 40 px `chrome-high` with `rule` | |
| Quick open | own | 44 px top cell |

### Controls that live in bars

| Control | Height | Where |
|---|---|---|
| Icon button `size-7` | 28 | Row 1, row 2, sidebar |
| Icon button `size-6` | 24 | Footers, row 3 |
| Editor toolbar button | 22 | Editor toolbar |
| Graph section tab | 26 | Graph row 2 above 1050 px |
| Graph select `bar` | 28 | Graph row 2 |
| Graph select `toolbar` | 24 | Graph row 3 |
| Graph view button, filter reset | 22 | Graph row 3 |
| Graph search, scope trigger, primary button | 28 | Graph row 2 |
| Files view tab | full row, 2 px underline | Files row 2 |
| Tracker range tab | full row | Tracker row 2 |
| Date trigger | full row, 104 px | Today footer |

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

## 5. Repair record

The 2026-09-04 repair made these changes:

1. The full top band uses `chrome` with a `rule` below it.
2. Graph row 2 keeps Work and Graph navigation, search, scope, refresh, and New.
   Row 3 keeps frequent task filters beside the views and Display at the right.
   Narrow panes collect task filters under Filter with named, clearable chips.
   Layout settings stay in Display. The row does not scroll sideways.
3. Routines New is a labelled 28 px action in the pane band.
4. Tracker content headers use the 28 px sub-bar height.
5. Files and Routines confirmation dialog headers use 36 px.
6. The Sidebar Settings row uses the normal 32 px row height.
7. Row 2 and row 3 use a shared 12 px horizontal inset. The Editor document
   and status footer keep their 28 px document margin.
8. Sidebar, Activity, and Editor use the same `pane-header` class. Editor file
   tabs fill that band, align to its bottom edge, and use a raised active plate.
9. Work and Graph navigation stays direct at every width. List, Timeline,
   Meetings, and Changes remain views within Graph.
10. The Sidebar has no redundant Tools heading in either expanded or rail
    state. The first tool row follows the normal 4 px navigation inset.
