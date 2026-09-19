# Workbench design

Mimir is one edge-to-edge Sidebar / Activity / Editor shell. Activity changes
must never replace or disturb the mounted Editor document and review state.

## Pane grammar

- Sidebar defaults to 280 px, resizes from 240 to 400 px, and collapses to
  a mounted 52 px rail. Narrow windows still collapse it automatically; the
  user can expand it manually.
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
- Files is the only collapsible section. When collapsed, its row sits directly
  above Settings. Opening it grows the file browser upward below navigation.
  Collapse sits beside the file actions menu in its header. The expanded browser
  extends to Settings with no Files footer.
  Drag its top edge to change its height. Dragging below half the minimum height
  snaps Files closed. Keep the pointer held and drag upward to open it again
  during the same gesture. Releasing while closed preserves the saved open height;
  Escape restores the state from before the drag. With the Sidebar expanded, dragging
  the collapsed Files row upward opens a live height preview. Release saves the
  height; Escape or dragging back down keeps it collapsed. A click restores the
  saved height. The rail icon remains a click control.
  Arrow keys resize the focused separator;
  Shift uses a larger step. Home and End reach the limits; Escape cancels a drag.
  `sidebarFilesCollapsed` and `sidebarFilesHeight` persist through Settings.
  Window shrinking limits the displayed height without replacing the saved height.
  Sidebar rail mode collapses Files to its bottom icon and gives the released
  space to navigation. That icon expands the Sidebar and opens Files at its saved
  height. Restoring the Sidebar restores its prior file preference and navigation
  scroll position.
  The browser remains mounted through both kinds of collapse.
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
- Sidebar status retains the original nine-dot Working animation and compact
  relative times. Error records take priority. Starting and working records
  animate; restoration never appears as new work. Inactive blocking input
  requests use an attention dot, and inactive unread replies use an information
  dot. Ordinary prompts, idle shells, and ended sessions stay quiet. Error,
  attention, and unread markers have named tooltips and accessible labels.
  The rail keeps a compact signal beside the provider icon. Reduced-motion
  mode shows a static grid. One
  minute clock updates all row times without changing row order.
- [Scratchpad](scratchpad.md) opens its unique Editor tab from Tools. Other
  Tools are stable main-tab destinations. Opening an existing tool selects its
  unique tab. Closing its tab retains the mounted surface during the app
  session, including unsaved local state, selection, and scroll position.
  Reopening does not recreate its launch record. Tool-specific durable state
  remains with each tool; closing a tab is not a reset command.
- Main tabs contain tools, agents, and terminals. Document tabs remain in the
  Editor. Switching main tabs does not change the Editor document or review.
- Settings > Appearance > Show main tabs saves `showMainTabs` (default true).
  When off, the existing Main title and status header returns, with Open views,
  New Activity, and Close. Open views reuses the searchable All Tabs menu.
  Click the session title to rename it inline. Enter or Space on the focused
  title, or F2, also starts the edit. The title uses the same save and cancel
  rules as session tabs. Unique tools retain their names.
  Close uses Stop and archive for live PTYs, Archive for ended sessions, and
  Close for tools. Editor document tabs remain visible. The setting changes
  only navigation controls: selection, saved tab order, surfaces, and pane
  layout remain intact. Sidebar width and collapse never change this preference.
- Tabs use a small existing provider/tool icon and a short title. Tabs are
  28 px high, with widths that shrink to fit. Selection adds a quiet background
  without an enclosing border. The label area selects the tab. Close is always visible
  in a separate reserved area. Tabs retain a 92 px minimum width and scroll
  when they cannot fit. Resizing keeps the full selected tab in view.
  Main and Editor tabs share their visual components and have no selection, opening, or closing animation. One tab row
  scrolls horizontally. All Tabs stays fixed on the left; New Tab stays on the
  right. All Tabs focuses its search field, filters immediately, and keeps
  typing focus while Up/Down selects a result and Enter opens it. Escape closes
  the menu and returns focus. New tab remains available for every query.
  Errors, unread output, and requests for input have a textual/glyph signal,
  including in All Tabs. Status never reorders tabs.
- Dragging reorders tabs. The context menu also has Move tab left/right.
  Cmd/Ctrl+Alt+Left/Right cycles open tabs in the focused panel. When Main tabs
  are shown, it follows their displayed order. When Main tabs are hidden, it
  follows Sidebar order: open Tools, then current-project sessions, then the
  open Files manager. Closed Tools and the Editor Scratchpad are excluded.
  Other open views without a Sidebar row follow in saved tab order. The
  Sidebar rail uses the same order as the expanded Sidebar. Navigation wraps
  at both ends. Open views and selection after closing a Main tab use this
  same order. Changing the display mode does not change the saved tab order.
  The previous/next Activity navigation history and controls are removed.
- Right-click Rename, F2, or double-click on a session label edits its name
  inline, with the full name selected. Enter saves a nonempty trimmed name
  through the existing native rename command. Escape or blur cancels; IME
  confirmation does not submit. Unique tools retain their names.
- Cmd/Ctrl+W closes the focused tab. If that pane has no tab, it closes a
  remaining Main or Editor tab. If no tabs remain, it requests window close
  through the existing window close guard. Live AI and terminal sessions use the
  existing stop-and-archive lifecycle and become History after they end. Tool
  tabs only close their view. An ongoing Scribe recording retains its visible
  Sidebar controls. Closing the last main tab shows New Tab without collapsing
  the pane.
- Cmd/Ctrl+T and the Main `+` button open the Main New Tab picker with session
  sources, tools, open tabs, files, projects, chats, and History.
  Cmd/Ctrl+N always creates an Editor document, including from Main or Sidebar.
  Native New uses the same document action.
- Open tab identities and order persist in `workbenchLayout.openTabIds`.
  Native session records remain the lifecycle authority. Saved renderer tools
  are reconstructed from their installed catalog, with lazy surface mounting.
- Project switching filters session tabs and remembers the selected Activity
  and Editor tab for the app session. It never stops other projects' sessions.
  Global tool tabs retain one identity. The project switcher is available in
  expanded and rail states; Activity records do not create project entries.
- Chats remains one unique tool tab. Rooms are available through Go to.

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

- Empty state lists all open Main and Editor tabs first, in navigation recency
  order with the current tab last. Output and saves do not affect recency.
  Other groups retain new Activity sources, Tools, recent projects/files, and
  reopen-last-closed when available. New tab remains in the fixed footer.
- Open Editor tabs include unsaved documents and review tabs. Selection uses
  stable tab identity through the Editor navigation API; it does not read the
  file again or create a duplicate. Matching open documents replace duplicate
  file results. Open tab matches precede other groups when searching.
- New Tab keeps its source-first layout. Search groups and scope prefixes remain
  available in both entry points.
- Typing searches New Activity, open tabs, unavailable Activities, Tools,
  Projects, Files, Chats, and History.
- Scope prefixes are `a:`, `n:`, `t:`, `p:`, `f:`, `c:`, and `h:`.
- Cmd/Ctrl+Shift+P opens Go to with `p: ` inserted and the cursor after the
  space. It shows all available recent projects, with the current project
  excluded. The previous project is selected first; Enter switches to it.
  Project order follows navigation recency, not agent output or file changes.
  Names and parent paths identify projects. Open project and Create project
  follow the list. Typing filters projects; clearing the prefix returns to
  all results. Escape closes the panel and restores focus. The shortcut appears
  in Settings and the project control tooltip in expanded and rail states.
- Arrow keys cross group boundaries and skip headings. Result bounds and
  ranking belong to `quickOpenResults.js`.
- History browses the current project when empty and searches all projects when
  given text. Opening a result from another project switches there first.
- The panel traps focus, ignores stale asynchronous results, and restores focus
  on cancellation. Selecting a result transfers focus to its destination.
  During text composition, Enter, Escape, and navigation keys remain with the
  input method; they do not select a result or close the panel.
- Results are built only while the panel is open. Reopening uses current tabs,
  files, and workspace context without scanning them during closed-panel updates.

### Go to chords

Opening Go to with Cmd/Ctrl+P enables these second steps until the dialog
closes. The primary modifier can stay held between keys. Ordinary text still
searches; there is no chord timer. New Tab and the direct Switch project entry
do not enable this mode.

| Second step | Destination |
|---|---|
| Cmd/Ctrl+T | Today |
| Cmd/Ctrl+G | Graph |
| Cmd/Ctrl+S | Scribe |
| Cmd/Ctrl+D | Scratchpad |
| Cmd/Ctrl+R | Routines |
| Cmd/Ctrl+L | Tracker |
| Cmd/Ctrl+J | Chats |
| Cmd/Ctrl+F | Files search (`f: `) |
| Cmd/Ctrl+P | Switch project (`p: `) |
| Cmd/Ctrl+O | Open a project folder |
| Cmd/Ctrl+1–9 | Start the corresponding available AI launcher |
| Cmd/Ctrl+0 | Start a new terminal |

Tool chords use the Sidebar's existing open action. They reuse tool tabs and
transfer focus to the destination. Files and Projects stay in Go to, clear the
previous query, and focus the input after the scope prefix. Project order and
selection match the direct Cmd/Ctrl+Shift+P entry.

Numbers follow the available AI presets in New Activity order, up to nine.
The helper shows each launcher's actual name. Disabled and unavailable presets
and local apps do not take agent numbers. Zero uses the standard Terminal preset,
or the first available terminal preset. Each launch creates a fresh Activity.
Unused numbers do nothing. Outside this Go to mode, zero still resets zoom.

The bottom-right shortcut panel shows enabled built-in tools, navigation, and
available launchers. Tool assignments are fixed; disabled tools keep their keys reserved,
and Sidebar reordering does not change them. Search results do not filter the
shortcut panel. Each row is also a button. On smaller windows, the helper sits
below the search panel and each panel can scroll without covering the other.

Minimize reduces the helper to a keyboard button. Chords remain active, and
`quickOpenShortcutsMinimized` persists through Settings. Minimize and restore
retain the query and return focus to search. The helper and its button disappear
when Go to closes. Both belong to the existing dialog's Tab sequence, along
with its New tab button; they do not add another modal.

The shared shortcut registry owns these bindings, Sidebar tooltips, and Settings labels.
Only the Go to handler matches this scope. Text editing commands, IME input,
and Editor commands outside Go to keep their existing behavior. Held-key repeat
does not run a second step from a webview keydown. Native macOS Go to, Open, Save,
and Find menu accelerators offer their input to the open dialog first because
the OS can consume them before a webview keydown arrives.

On 2026-09-19, the signed installed 0.3.3 build from `e7373ce` passed native
Cmd+P sequences for Projects (Cmd+P), Files (Cmd+F), the project-folder dialog
(Cmd+O), Graph (Cmd+G), Scribe (Cmd+S), and a new terminal (Cmd+0).

Workbench teardown snapshots layout and tab order before Settings flush.

Workbench diagnostic toasts close after 25 seconds. Each new message starts
a new timer. A queued sync error gets its own 25 seconds when it appears.
The message text supports selection and copying. The close button can dismiss
the message at any time.

Visual rules are in [design-system.md](design-system.md); Activity projection is
in [activities.md](activities.md).
