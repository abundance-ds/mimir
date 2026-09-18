# Shell chrome

This document owns the workbench chrome: every bar, band, rail, footer,
canvas, and overlay, which layer each one sits on, and how they relate to
their neighbours. [design-system.md](design-system.md) owns tokens and
controls; this page owns where those tokens go. Geometry checked in Chrome on 2026-09-08; native window controls still need
an installed-app check.

## Shared implementation

`src/shared/ui/chrome/` owns the common panel structure:

- `PaneBand` assigns the header or footer class. Callers provide content and
  horizontal insets; the shared stylesheet owns height, layer, and rule.
- `PaneTabStrip` owns the tab row, scroll area, mouse-wheel scrolling, and
  fixed leading/trailing controls.
- `PaneTab`, `PaneTabButton`, and `PaneTabClose` own tab typography, shape,
  selected/hover/focus states, separators, and the close glyph and hit area.
  Main and Editor use these same parts. Neither defines a local tab skin.
  Preview italics and document save indicators retain their meaning.
- `PaneRestoreControls` and `PaneSizeControls` render both content headers'
  layout actions. `paneControls.js` owns the six-state placement policy,
  including Main's quiet rail. `usePaneControls` owns header action transitions
  and focus. The layout store still enforces the one-open-content-pane rule.

Document selection, save/discard, reviews, and session lifecycle remain with
those features. They supply content and actions to the shared tab parts.
Changes to common appearance belong in the shared parts, never in a local
Main or Editor override. Status footers in Sidebar, Editor, Files, Today,
Routines, and launch plans use `PaneBand`; input footers retain their own role.

`harness/pane-chrome-matrix.html` shows all six layouts together with controls
for width, theme, overflow, and an empty Editor. Each frame mounts the real
shell components through `pane-chrome.html`. `PaneChrome.test.js` rejects
local tab skins and checks bar ownership. `check-pane-controls.mjs` compares
computed Main/Editor tab styles as well as geometry and control ownership.
These checks complement the Sidebar collapse-position checks below.

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

The sidebar top, Activity header, and Editor header now use `chrome` with a
`rule` below them. The Editor active tab can therefore rise from the ground
layer without making the band heavier than the sidebar.

## 3. Inventory as built

Heights include the rule. Layer is the background token.

### Row 1, the band

| Surface | File | Height | Layer | Rule | Content |
|---|---|---|---|---|---|
| Sidebar top | `WorkbenchSidebar.vue` | 40 | `chrome` | `rule` | Collapse button; project switcher follows below |
| Activity pane header | `PaneFrame.vue` | 40 | `chrome` | `rule` | Optional main tabs; otherwise the existing title/meta with Open views, New Activity, and Close. Expand / Restore split and collapse stay fixed |
| Editor header | `editor/components/shell/AppHeader.vue` | 40 | `chrome` | `rule` | Bottom-aligned file tabs; active tab is a neutral `chrome-high` plate; HTML open-in-browser, add, Expand / Restore split, collapse |
| Rail restore | `RailRestore.vue` | 40 top cell, 26 footer | `chrome` top and footer; `chrome-high` body, hover `chrome-mid` | `rule` | Vertical title; Editor has a restore arrow; Main keeps a quiet top cell |

### Row 2, the bar, 36 px `chrome-high` with `rule`

| Surface | File | Content | Before 2026-09-04 |
|---|---|---|---|
| Editor toolbar | `editor/components/workspace/EditorToolbar.vue` | Format buttons 22 px, 12 px inset | 30 px, `chrome-mid`, `rule-light` |
| Files view tabs (wide manager) | `FilesActivity.vue` | Project, Changes, Recent, Favorites with 2 px accent underline; three 28 px icon buttons | 40 px |
| Graph top bar | `business-graph/GraphAppHeader.vue` | Direct Home, Work, Graph, and Changes tabs 26 px at every width; search 28 px; scope 28 px; refresh; New | 40 px, `surface` mix, brand mark, wrapped to two rows under 1050 px |
| Tracker range | `TrackerApp.vue` | Range tabs, previous, range label, next | 36 px wrapping strip under a 40 px identity header |
| Scribe transport | `ScribeApp.vue` | Recording dot, timer, status, save state, Mute, Stop 28 px | 42 px `chrome` |
| Scribe overview | `ScribeApp.vue` | Search, Prepare, Record, Settings; 28 px controls | In-content title, action row, and status lines |
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

The compact Files sidebar uses a 28 px strip with 28 px icon buttons on
`chrome`. Its search field follows directly, without an extra top margin.
The strip and search field form one navigation group; the wide File Manager
retains the pane-bar layout above. [Files](files.md) owns their behavior.

### Row 3, the sub bar, 28 px `chrome-high` with `rule-light`

| Surface | File | Content |
|---|---|---|
| Files ledger status | `FilesActivity.vue` | Mono 10 px status line |
| Files ledger columns | `FilesActivity.vue` | Mono 10 px column labels in the tree grid |
| Graph entry view | `business-graph/GraphEntryDetails.vue` | 36 px band with Details and Source controls at 28 px; quiet save status, Save, and More; uses the Editor tab strip |
| Work viewbar | `business-graph/GraphViewbar.vue` | View buttons 22 px; frequent task filters; Display at the right; narrow panes use clearable active-filter chips and a 24 px Filter button |
| Graph table | `business-graph/GraphEntries.vue` | Sort labels and Kind/Project filter counts and clear actions in the column headings; no extra toolbar; see [Graph](business-graph.md#product-surface) |

### Canvases

| Surface | Layer | Notes |
|---|---|---|
| Editor document | `surface` | Commit Mono, 28 px inset matches the status footer |
| Chat transcript, Terminal, Today journal | `surface` | |
| Files tree (wide manager) | `surface`, 28 px rows, hover `chrome-high` | |
| Files tree (sidebar) | `chrome`, hover `chrome-mid`, selection `chrome-high` | Neutral folder icons and counts; guides use `rule`; accent remains for keyboard focus and drop targets |
| Routines, Tracker | `chrome-high` root | Section headers inside Tracker views are 28 px with `rule-light` |
| Graph board | `chrome` columns, `chrome-high` cards with `rule-light` edge and 2 px radius, hover `chrome-mid` | 8 px canvas inset and column gap; 252–420 px columns with a full `rule` edge; headers 38 px `chrome-high` inside each column |
| Graph list | sticky group headers 28 px `chrome-mid`, rows 34 px | |
| Sidebar | `chrome`, navigation rows 24 px, hover `chrome-mid`, section headings 28 px sans 11 px, project box `surface` with `rule` | |

### Footers

| Surface | File | Height | Layer | Rule | Content |
|---|---|---|---|---|---|
| Editor status | `editor/components/shell/AppFooter.vue` | 26 | `chrome` | `rule` | Words, save state, comments, zoom; mono 10 px |
| Files status | `FilesActivity.vue` | 26 | `chrome` | `rule` | Count, selection, workspace |
| Today status | `TodayApp.vue` | 26 | `chrome` | `rule` | Save state, date navigation 24 px |
| Routines status | `RoutinesActivity.vue` | 26 | `chrome` | `rule` | Directory, notice or revision |
| Launch plan | `LaunchPlanHost.vue` | 26 | `chrome` | `rule` | Plan state |
| Chat composer | `ChatActivity.vue` | grows, min 36 | `chrome-high` | `rule` | Bordered `surface` textarea, uploads |
| Sidebar settings | `WorkbenchSidebar.vue` | 26 | `chrome` | `rule` | Settings button fills the row in expanded and rail states |

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
| Select menus, scope menu, columns menu, date picker | `surface` | 1 px `rule`, 3 to 5 px radius, shadow |
| Graph link suggestions | `surface`, `rule-light` edge, small shadow | 320 px preferred width within pane/viewport; title 12 px, kind/scope 10 px; body portal prevents clipping |
| Graph create, confirm, summary dialogs | `surface` | own header and footer |
| Routines dialogs | header 40 px `chrome-high` with `rule` | |
| Quick open | own | 44 px top cell |

### Controls that live in bars

| Control | Height | Where |
|---|---|---|
| Header icon button `pane-icon-button` | 28 | Row 1 actions and sidebar restore; explicit px dimensions |
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
2. Graph row 2 keeps Home, Work, Graph, and Changes navigation, scope, refresh,
   and New. Work and Graph also show search; Home has a searchable Project
   selector in its page heading.
   Row 3 keeps frequent task filters beside the views and Display at the right.
   Narrow panes collect task filters under Filter with named, clearable chips.
   Layout settings stay in Display. The row does not scroll sideways.
3. Routines New is a labelled 28 px action in the pane band.
4. Tracker content headers use the 28 px sub-bar height.
5. Files and Routines confirmation dialog headers use 36 px.
6. The Sidebar Settings row now shares the 26 px status footer contract.
7. Row 2 and row 3 use a shared 12 px horizontal inset. The Editor document
   and status footer keep their 28 px document margin.
8. Sidebar, Activity, and Editor use the same `pane-header` class. Editor file
   tabs fill that band, align to its bottom edge, and use a raised active plate.
9. Home, Work, Graph, and Changes navigation stays direct at every width. Graph has
   one entry table; its column headings hold sort and filter controls.
10. Tools and Activities have fixed headings above Files. Main sessions
    also remain in the horizontal tab strip.

## 6. Expanded and rail states

`E` means expanded. `R` means rail. Main and Editor cannot both stay in rail
state. Each visible column has a 40 px top cell. Status and rail footers
are 26 px. The Chat input footer retains its input height.

| Sidebar | Main | Editor | Sidebar restore | Main restore | Editor restore |
|---|---|---|---|---|---|
| E | E | E | — | — | — |
| R | E | E | Sidebar Tools heading slot | — | — |
| E | R | E | — | Editor header; Main rail body | — |
| R | R | E | Sidebar Tools heading slot | Editor header; Main rail body | — |
| E | E | R | — | — | Editor rail arrow and body |
| R | E | R | Sidebar Tools heading slot | — | Editor rail arrow and body |

When Main is collapsed, its restore button appears at the left of the Editor
header, before the file tabs. Sidebar expand occupies the Tools heading slot
in its rail in every layout. Main's rail has no separate top arrow. Its 40 px
top cell remains, and its body still restores Main. Editor's rail keeps its
own top arrow.

Each content header retains one Expand / Restore split toggle at the same
position relative to its right edge. Expand makes that pane the open content
pane; Restore split reopens the other pane when the window permits a split.
The button changes icon and label, and retains focus. Collapse remains a
separate action. It opens the opposite pane if necessary, because both
content panes cannot stay collapsed. A restore action moves focus into the
restored pane. Sidebar expand uses the Tools heading row; it does not add a row.

The macOS window buttons start at x=14 and extend past the 52 px Sidebar
rail. The quiet Main rail top cell leaves this area free. The Sidebar
workspace switcher follows its top cell directly.

Header action buttons are 28 by 28 px, with 15 px icons at stroke width 1.8.
They share the vertical centre of the 39 px interior above the bottom rule.
The 28 px tabs stay aligned to the bottom rule. New Tab sits outside each
scrolling tab list, so it stays visible when the list overflows.

`harness/pane-chrome.html` mounts the actual shell, Sidebar, Main tabs, and
Editor header with local sample content. Query parameters select `sidebar`,
`activity`, or `editor` as `rail`; `tabs=12` checks overflow and `html` adds
the browser action. `vertical` hides Main tabs; `theme` selects a theme. Use the panel controls to check
state transitions. The combined component test `PaneControls.test.js` checks all six states,
restore ownership, focus return, and collapse of the sole open content pane.
Browser checks cover all six states at 1360 px and the three Sidebar rail
states at 760 px, with Main tabs shown and hidden. They check the restore-button order, quiet Main top cell,
40 px headers, expansion toggle identity and position within its header,
focus return, and restore actions. `scripts/check-pane-controls.mjs` runs
these checks with an existing Puppeteer Core installation. Native macOS
window-button clearance still needs an installed-app check.

## 7. Sidebar icon positions

Sidebar collapse changes the width and label visibility. Navigation rows keep
their height, including the recording strip. Workspace, Tools, Activities, Files, and Settings share
an icon centre 26 px from the left edge in both states.

- Tools and Activities use 24 px navigation rows in the Sidebar and rail.
  Their headings remain 28 px. In the rail, the Tools heading becomes Expand sidebar. It remains
  visible and keyboard accessible, with its icon at the same 26 px centre.
  This heading stays at the top while one shared navigation area scrolls.
  The Activities heading and New button are hidden in the rail.
- Navigation rows never shrink and have no nested scroll areas. The rail hides
  the navigation scrollbar while retaining wheel and keyboard navigation.
- Collapsed Files has a 28 px restore row directly above Settings. Expanded
  Files has Collapse beside its header menu and no footer. In the rail, Files
  collapses to one icon above Settings and releases its space to navigation.
  The top resize rule has a slightly stronger neutral color, an 8 px hit target,
  and a 2 px hover/focus highlight. Its behavior and saved state belong to
  [workbench-design.md](workbench-design.md#sidebar-and-main-tabs).
- Recording sits directly below the Scribe tool row and follows that row when
  Tools are reordered. It stays with Scribe inside the shared navigation scroll
  area in both expanded and rail states. The strip is 48 px in both states,
  including two rules when expanded. The expanded Sidebar shows Recording above elapsed time, with Mute and Stop
  beside them. Clicking the status opens Scribe; its tooltip includes the
  meeting title. In the rail, a small recording dot sits on the Scribe icon.
  A 48 px strip below it has one timer row and one row with equal 24 px Mute
  and Stop buttons. The rail strip has no surrounding rules. Time remains visible without
  hover. The recording dot and Stop use `rem`, matching Scribe's recording
  controls. Muted uses the crossed microphone glyph. Stopping and Finalizing use
  a progress glyph; their recording controls are disabled. The status uses a
  live region for screen readers. The clock is outside that region.
- Settings remains anchored in the 26 px footer.

`scripts/check-sidebar-geometry.mjs` uses the real Files harness to compare
icon positions through both collapse and expand round trips, the collapsed Files
rail, and restored Sidebar scroll.
It covers 240, 280, and 400 px sidebar widths, short and tall
windows, long tool and session lists, recording controls, open/closed Files,
drag resizing, drag collapse and reopening, size restoration, and search field geometry.
`scripts/check-activity-states.mjs` checks status markers, live animation,
reduced motion, and row heights in the Sidebar and rail, in light and dark themes.
Both scripts use the running dev server (port 1420 by default) and an existing
Puppeteer Core installation through `PUPPETEER_MODULE`:

```bash
PUPPETEER_MODULE=/absolute/path/to/puppeteer-core node scripts/check-sidebar-geometry.mjs
PUPPETEER_MODULE=/absolute/path/to/puppeteer-core node scripts/check-activity-states.mjs
```

These browser fixtures do not prove native input behavior. The Files native
checks and remaining gaps are in [files.md](files.md#verification).
