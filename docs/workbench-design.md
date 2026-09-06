# Workbench design

Mimir is one edge-to-edge Sidebar / Activity / Editor shell. Activity changes
must never replace or disturb the mounted Editor document and review state.

## Pane grammar

- Sidebar defaults to 240 px and collapses to a mounted 52 px rail.
- Activity defaults to 560 px; Editor defaults to 520 px. Each content pane has
  a 336 px working minimum and collapses to a 44 px rail.
- Activity and Editor cannot both remain railed. In narrow windows, opening one
  rails the other.
- Activity owns flexible width in a split. If it becomes a rail, Editor takes
  the released width.
- Resize handles use a one-pixel rule inside a wider hit target. Remembered
  desktop widths survive compact responsive layouts.
- Pane controls live in the pane header. Restore and collapse remain available
  from adjacent expanded panes so every state is recoverable.
- Activities and apps lift their status line and primary actions into the
  pane header through `usePaneChrome` instead of drawing a second header.
  Bar heights and layers are fixed in [design-system.md](design-system.md),
  "Pane chrome".

## Sidebar and Activities

- Tools are stable destinations. The `+` menu and Cmd/Ctrl+P create fresh
  Activities; they do not add permanent launcher rows.
- Live Activity order is manual and stable. Output or status cannot reorder it.
- Closed work is available through Cmd/Ctrl+P History, not an Archived list.
- The project switcher works from expanded and rail states. Activity records do
  not create project entries.
- Switching projects changes projections only; it never stops Activities or
  closes Editor tabs.
- Sidebar, Chats, and Activities keep independent disclosure state.

## Go to

Cmd/Ctrl+P opens one grouped launcher near the window top.

- Empty state shows new Activity sources, Tools, recent projects/files, and
  reopen-last-closed when available.
- Typing searches New Activity, unavailable Activities, Tools, Projects, Files,
  Chats, and History. Current Activities use the cycle shortcut and stay out of
  results.
- Scope prefixes are `a:`, `n:`, `t:`, `p:`, `f:`, `c:`, and `h:`.
- Arrow keys cross group boundaries and skip headings. Result bounds and
  ranking belong to `quickOpenResults.js`.
- History browses the current project when empty and searches all projects when
  given text. Opening a result from another project switches there first.
- The panel traps focus, ignores stale asynchronous results, and restores focus
  when it closes.

Workbench teardown snapshots layout and Activity order before Settings flush.

Workbench diagnostic toasts close after 25 seconds. Each new message starts
a new timer. A queued sync error gets its own 25 seconds when it appears.
The message text supports selection and copying. The close button can dismiss
the message at any time.

Visual rules are in [design-system.md](design-system.md); Activity projection is
in [activities.md](activities.md).
