# Workbench design

Mimir is one edge-to-edge Sidebar / Activity / Editor shell. Activity changes
must never replace or disturb the mounted Editor document and review state.

## Pane grammar

- Sidebar defaults to 280 px, resizes from 240 to 400 px, and collapses to
  a mounted 52 px rail. Narrow windows still collapse it automatically; the
  user can expand it manually.
- Activity defaults to 560 px; Editor defaults to 520 px. Each content pane has
  a 336 px working minimum and collapses to a 44 px rail.
- Activity and Editor cannot both remain railed. In narrow windows, opening one
  rails the other.
- Activity owns flexible width in a split. If it becomes a rail, Editor takes
  the released width.
- Resize handles use a one-pixel rule inside a wider hit target. Remembered
  desktop widths survive compact responsive layouts. Window shrinking can
  collapse panels to fit. Window growth preserves current panel states; it
  never restores an older layout or opens an empty Editor. Manual expand
  controls reopen panels. Current states persist at every window width.
- Pane controls retain the original header arrangement. Sidebar restore
  precedes Main restore when both are collapsed. Main has a quiet rail;
  Editor has a rail arrow. [chrome-ui.md](chrome-ui.md) owns the six-state
  control map and the Expand / Restore split toggle.
- Activities and apps lift primary actions into the main header through
  `usePaneChrome`. Main tabs do not add a second status or actions row.
  Bar heights and layers are fixed in [design-system.md](design-system.md),
  "Pane chrome".

## Sidebar and main tabs

- The Sidebar contains the project switcher, collapsible Tools, Files, and
  Settings. Tools has a bounded height; Files takes the remaining space.
  [files.md](files.md) owns the file browser controls.
- [Scratchpad](scratchpad.md) opens its unique Editor tab from Tools. Other
  Tools are stable main-tab destinations. Opening an existing tool selects its
  unique tab. Closing its tab retains the mounted surface during the app
  session, including unsaved local state, selection, and scroll position.
  Reopening does not recreate its launch record. Tool-specific durable state
  remains with each tool; closing a tab is not a reset command.
- Main tabs contain tools, agents, and terminals. Document tabs remain in the
  Editor. Switching main tabs does not change the Editor document or review.
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
  Cmd/Ctrl+Alt+Left/Right cycles visible tabs in their displayed order. The
  previous/next Activity navigation history and controls are removed.
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
- Arrow keys cross group boundaries and skip headings. Result bounds and
  ranking belong to `quickOpenResults.js`.
- History browses the current project when empty and searches all projects when
  given text. Opening a result from another project switches there first.
- The panel traps focus, ignores stale asynchronous results, and restores focus
  on cancellation. Selecting a result transfers focus to its destination.

Workbench teardown snapshots layout and tab order before Settings flush.

Workbench diagnostic toasts close after 25 seconds. Each new message starts
a new timer. A queued sync error gets its own 25 seconds when it appears.
The message text supports selection and copying. The close button can dismiss
the message at any time.

Visual rules are in [design-system.md](design-system.md); Activity projection is
in [activities.md](activities.md).
