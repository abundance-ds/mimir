# Workbench design

Mimir is one edge-to-edge Sidebar / Activity / Editor shell. Activity changes
must never replace or disturb the mounted Editor document and review state.

## Pane grammar

- Sidebar defaults to 280 px, resizes from 120 to 400 px, and collapses to
  a mounted 52 px rail. Narrow windows still collapse it automatically; the
  user can expand it manually.
- Sidebar drag uses a temporary layout until release. Below 86 px it snaps
  to the rail; at 98 px it reopens. The original pointer origin survives each
  snap, so a drag can reverse without release. The rail edge also resizes.
  Releasing in the rail retains the pre-drag saved width for button restore.
  Escape, pointer cancellation, and window blur discard the preview.
- Activity defaults to 560 px; Editor defaults to 520 px. Each content pane has
  a 336 px working minimum and collapses to a 44 px rail. A manually restored
  Sidebar fits the available width without replacing its saved width. If the
  window cannot fit both content panes, only one remains open. At the smallest
  window size, that pane uses the remaining width to prevent horizontal overflow.
- Activity and Editor cannot both remain railed. In narrow windows, opening one
  rails the other.
- Activity owns flexible width in a split. If it becomes a rail, Editor takes
  the released width.
- Resize handles use a one-pixel rule inside a wider hit target. Remembered
  desktop widths survive compact responsive layouts. Window shrinking can
  collapse panels to fit. Window growth preserves current panel states; it
  never restores an older layout or opens an empty Editor. Manual expand
  controls reopen panels. Current states persist at every window width.
- Sidebar expand occupies the Tools heading slot in the Sidebar rail.
  Main restore remains in the Editor header. Main has a quiet rail; Editor
  has a rail arrow. [chrome-ui.md](chrome-ui.md) owns the six-state control
  map and the Expand / Restore split toggle.
- Activities and apps lift primary actions into the main header through
  `usePaneChrome`. Main tabs do not add a second status or actions row.
  Bar heights and layers are fixed in [design-system.md](design-system.md),
  "Pane chrome".

## Sidebar and main tabs

- The Sidebar contains the project switcher, Tools, Activities, Files, and
  Settings. Tools and Activities remain open and share one scroll area. Each
  heading and navigation row keeps its height when the available space changes.
  [files.md](files.md) owns the file browser controls.
- Files is the only collapsible section. Drag its top edge to resize; dragging
  below half the minimum snaps it closed. `sidebarFilesCollapsed` and
  `sidebarFilesHeight` persist through Settings. Window shrinking limits the
  displayed height without replacing the saved height. Sidebar rail mode
  collapses Files to its bottom icon and gives the released space to
  navigation. The browser remains mounted through both kinds of collapse.
- Activities shows the open session tabs for the current workspace, in their
  relative tab order. It excludes unique tools, which remain in Tools. Both
  views use the same selected Activity, names, lifecycle records, rename and
  close actions. Reordering session rows changes the same tab order while
  retaining tool and other-project tab positions. Output never reorders rows.
- The Activities heading retains an attention signal. New Activity opens the
  existing New Tab picker. In the Sidebar rail, session rows retain their icons,
  selection, and attention signals. The rail uses one navigation scroll area;
  restoring the Sidebar restores its previous scroll position. Tools and Activities have no disclosure state.
- Sidebar row arrows and Home/End move focus; Enter/Space selects. F2,
  double-click, and the context menu rename sessions when the Sidebar is
  expanded. The context menu and pointer drag reorder rows. Rows have no close
  button. Close remains available in the context menu and the Main header or
  tabs, through the same lifecycle action.
- Sidebar status: error records take priority; starting and working records
  animate; restoration never appears as new work. Attention dot for blocking
  input, information dot for unread replies. Ordinary prompts, idle shells, and
  ended sessions stay quiet. Markers have accessible labels.
  Reduced-motion mode shows a static grid. One-minute clock updates times
  without reordering rows.
- [Scratchpad](scratchpad.md) opens its unique Editor tab from Tools. Other
  Tools are stable main-tab destinations. Opening an existing tool selects its
  unique tab. Closing its tab retains the mounted surface during the app
  session, including unsaved local state, selection, and scroll position.
  Reopening does not recreate its launch record. Tool-specific durable state
  remains with each tool; closing a tab is not a reset command.
- Main tabs contain tools, agents, and terminals. Document tabs remain in the
  Editor. Switching main tabs does not change the Editor document or review.
- `showMainTabs` (default true) toggles between the tab strip and a
  title/status header with Open views, New Activity, and Close. The setting
  changes only navigation controls; tab order, surfaces, and pane layout
  remain intact.
- Main and Editor tabs share visual components. 28 px high, 92 px minimum
  width, scroll when they cannot fit. Status signals never reorder tabs.
- Cmd/Ctrl+Alt+Left/Right cycles tabs in the focused panel. When Main tabs
  are hidden, it follows Sidebar order: open Tools, then current-project
  sessions, then the open Files manager, then other open views in saved tab
  order. Selection after closing a Main tab uses the same order. Navigation
  wraps. Changing display mode does not change saved tab order.
- Session rename: Enter saves a trimmed nonempty name; Escape or blur cancels;
  IME confirmation does not submit. Unique tools retain their names.
- Cmd/Ctrl+W closes the focused tab; with no tab in that pane, a remaining
  Main or Editor tab; with no tabs, it requests window close through the close
  guard. Closing the last main tab shows New Tab without collapsing the pane.
  Live sessions use stop-and-archive lifecycle; tool tabs only close their view.
- Cmd/Ctrl+T opens the Main New Tab picker. Cmd/Ctrl+N creates an Editor
  document from any panel.
- Tab identities and order persist in `workbenchLayout.openTabIds`. Native
  session records remain the lifecycle authority. Saved tools are rebuilt
  from the installed catalog with lazy surface mounting.
- Project switching filters session tabs and remembers selection per project.
  It never stops other projects' sessions. Global tool tabs retain one
  identity.

## Keyboard scope

`src/shared/shortcuts.js` owns command bindings, scope, and Settings labels.
The Workbench capture handler, Editor fallback handler, interface zoom, and
Inline AI binding use this registry. Settings groups commands by scope.

| App-wide shortcut | Action |
|---|---|
| Cmd/Ctrl+P | Go to |
| Cmd/Ctrl+Shift+P | Switch project |
| Cmd/Ctrl+T | Main New Tab picker |
| Cmd/Ctrl+N | New Editor document |
| Cmd/Ctrl+B | Expand/collapse Sidebar |
| Cmd/Ctrl+, | Settings |
| Cmd/Ctrl+1 | Focus Main; expand it if collapsed |
| Cmd/Ctrl+2 | Focus Editor; expand it if collapsed |
| Cmd/Ctrl++ / − / 0 | Interface zoom in / out / reset |

Focusing an empty Editor creates a document through the same New action.
Focus commands respect the single-content-pane layout in narrow windows.
Creation and focus commands have the same target from every panel, including
text inputs and inline tab rename fields. IME composition is left alone.

Close and previous/next tab remain panel-scoped. When native buttons leave
focus on the body, the last clicked/focused panel remains the target. Editor
Save, Open, toolbar, and formatting shortcuts require Editor focus and do not
act through unrelated text inputs. On macOS, Control chords remain available
to terminals; the app uses Command. Other platforms use Control.

Dialogs and Go to suspend panel commands behind them. Zoom remains available.
The embedded Editor cannot run global fallback commands after a dialog blocks
the Workbench handler. The standalone Editor retains its document commands.

## Go to

Cmd/Ctrl+P opens one grouped launcher near the window top.

- Empty state lists open Main and Editor tabs first, in navigation recency
  order (current tab last). Output and saves do not affect recency. Open tab
  matches precede other groups when searching.
- Scope prefixes: `a:`, `n:`, `t:`, `p:`, `f:`, `g:`, `c:`, `h:`.
- `g:` searches Graph titles and content across mounted scopes, up to 100
  matches. Default search does not query Graph.
- Cmd/Ctrl+Shift+P opens Go to with `p: ` inserted. Previous project is
  selected first. Project order follows navigation recency.
- Open Editor tabs include unsaved documents and review tabs. Selection uses
  stable tab identity; it does not read the file again or create a duplicate.
  Open documents replace duplicate file results.
- History browses the current project when empty and searches all projects
  with text. A result from another project switches there first.
- Results are built only while the panel is open. The panel traps focus,
  ignores stale asynchronous results, and restores focus on cancellation.
- Result bounds and ranking belong to `quickOpenResults.js`.
- During IME composition, Enter/Escape stay with the input method.

### Go to chords

Opening Go to with Cmd/Ctrl+P enables second-step chords until the dialog
closes. The modifier can stay held between keys. Ordinary text still
searches; there is no chord timer. New Tab and the direct Switch project
entry do not enable this mode.

Bindings are the `scope: 'quick-open'` entries in `shortcuts.js`. Tool
chords reuse tool tabs and transfer focus. Files and Projects stay in Go to,
clear the query, and insert the scope prefix. Agent numbers (1-9) follow
New Activity order; zero starts a terminal.

The shortcut helper panel (bottom-right) shows enabled tools and launchers.
Tool assignments are fixed; Sidebar reordering does not change them. Disabled
tools keep their keys reserved; disabled presets take no agent number.
`quickOpenShortcutsMinimized` persists through Settings.

Held-key repeat does not run a second step from a webview keydown. Native
macOS menu accelerators offer their input to the open dialog first.

Workbench teardown snapshots layout and tab order before Settings flush.

Workbench diagnostic toasts close after 25 seconds. Each new message starts
a new timer. A queued sync error gets its own 25 seconds when it appears.
The message text supports selection and copying. The close button can dismiss
the message at any time.

Visual rules are in [design-system.md](design-system.md); Activity projection is
in [activities.md](activities.md).
