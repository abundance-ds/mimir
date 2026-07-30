# Product acceptance contract

This is the release behavior contract for Mimir 0.1.0. Unit tests support these
requirements; they do not replace runtime verification.

## Workbench

- The main window is one edge-to-edge Sidebar / Activity / Editor workbench.
- Editor is mounted and visibly expanded on startup.
- The Sidebar starts expanded and can collapse to a 52px live rail without
  reordering rows or losing status.
- Tools contains stable singleton surfaces. The Activities `+` and
  Cmd/Ctrl+P expose sources that create a fresh run; Activities contains only
  the active working set.
- The project switcher shows the current folder, recent folders, and an
  explicit native folder-picker action in both Sidebar states.
- The Sidebar has no Archived list. Closed durable work is searchable and
  restorable through Cmd/Ctrl+P History.
- Activity and Editor can each collapse to a mounted 44px rail.
- Activity and Editor cannot both remain railed; recovery always leaves a
  usable content surface.
- Activity and Editor each expose expand/restore-split and directional
  collapse controls in their own header.
- Railing Activity lets Editor reclaim all released width; no dead surface is
  left to its right.
- Both dividers use a persistent one-pixel rule inside a six-pixel resize
  target, and persisted widths restore on relaunch.
- Debounced pane widths, Activity order, and preferences flush in serialized
  snapshot order on Workbench teardown and before confirmed native quit.
- Changing Activity leaves Editor tabs, selection, unsaved state, and review
  state intact.
- Cmd/Ctrl+B toggles the Sidebar and Cmd/Ctrl+P opens the compact Go to panel.
- Empty Go to shows Start new activity first, then Tools, recent files, and
  Reopen last closed. Entering Start new activity replaces the root results
  with only launch sources; Back, empty-query Backspace, or Escape returns.
  `/` scopes files, `@` scopes closed History, and `+` scopes fresh-run
  sources; a typed query can find chat rooms without adding them to the empty
  default view; live Activities stay on the cycle shortcut.
- Go to traps and restores focus, ignores stale async results, and contains
  workbench shortcuts; Escape or Cmd/Ctrl+W closes it first from the root. Its
  top edge stays at a fixed near-window-top offset while subviews replace
  results.
- Unmodified Arrow Up/Down and Home/End move Sidebar row focus without
  activation. Option/Alt+Cmd/Ctrl+Left/Right cycles active Activity rows.
- Collapsing or restoring any pane transfers focus to visible chrome rather
  than leaving keyboard ownership in hidden content.

## Activities and agents

- Every terminal, agent, app instance, and routine run has a stable Activity.
- The Activities `+` menu launches every enabled dynamic Activity type,
  including Terminal, without duplicating the stable Chats workspace; it
  remains available in the collapsed Sidebar and is fully keyboard-operable.
- Native PTY launches preserve exact argv boundaries, cwd, and environment.
- Plain terminals are ephemeral. Agent and routine Activities persist bounded
  scrollback and final state across relaunch.
- Live output streams once, replay is ordered, resize reaches the PTY, and stop
  is idempotent.
- Terminal and agent surfaces use xterm 6 WebGL when available and remain
  interactive through the DOM fallback after initialization or context loss.
- The native system monospace stack is fixed before xterm cell measurement;
  text remains sharp at 100%, 125%, and 150% workbench zoom.
- Durable ended Activities can be renamed, archived/restored, and cleared.
- Cmd/Ctrl+W on a focused Sidebar Activity archives that exact durable row,
  including failed rows that are not currently selected; live rows stop before
  archival. Durable close intent is flushed before termination and survives an
  app or renderer restart.
- Codex, Claude, Pi, and Gemini detection reports precise unavailable states.
- Settings > CLI tools uses compact detected-agent rows, launcher-visibility
  switches, shell-like flag editing, progressive cwd/command/environment
  details, and no kind/agent/cwd select maze.
- Disabled or unavailable CLI presets do not clutter the Sidebar; they remain
  diagnosable and configurable in Settings.
- Supported agents resume only with the exact recorded provider session id
  inside the same Activity row; resume never uses latest/last/implicit continue
  and never creates a second record. Resume preserves that Activity's recorded
  model, permission, and tool flags while refreshing Mimir's scoped connection.
- History rows without an exact id restore the transcript only. Run again is a
  distinct new-session action, ambiguous legacy identity fails closed, and
  failed or duplicate Resume attempts cannot unarchive or respawn twice.
- Routine reruns resolve the current routine definition. Plain terminal and
  app-process reruns preserve their exact stored command, argv, cwd, and env.
- `mimir` is on PATH in every Mimir-launched PTY.

## MCP

- The MCP endpoint binds to loopback and exposes `initialize`, `ping`,
  `tools/list`, and `tools/call`.
- One canonical registry backs the UI and runtimes; MCP and `mimir` use its
  explicit public projection.
- Default agent discovery contains only `mimir_state`, `mimir_title`,
  `mimir_reveal`, and `mimir_propose`; the remaining public tools require CLI
  discovery.
- Tool calls validate complete object schemas, report all input failures
  together, and return structured stable errors.
- The public surface is 16 permanent Workbench/Graph tools, Chat tools
  while Chats is enabled, plus conditional
  connection tools; internal UI/runtime domains never leak into agent
  discovery.
- Live app providers can add, update, remove, execute, and cancel private
  registry tools without restarting the server.
- Mimir-launched Codex, Claude, Pi, and Gemini receive the endpoint
  automatically with activity and agent provenance.
- The one-line `mimir tools` (all) / `mimir tools <group>` / `mimir tool` /
  `mimir skill` / `mimir doctor` routing contract is delivered once, without
  client tutorials.
- Every connection uses the product-owned `mimir_workbench` identity and
  preserves unrelated client configuration.
- Catalog and personal skills trigger natively in every client; project skills
  trigger natively in Claude and Pi and remain one explicit lookup away in
  Codex and Gemini.

## Chats

- Chats is one stable Activity with separate channel/direct-message state;
  changing rooms never creates or reorders an Activity.
- Settings > Chat can disable the complete local chat surface: the Sidebar
  section disappears, the transport disconnects, chat tools unregister, and
  cached history remains available for re-enabling later.
- The expanded Sidebar places one flat channel/direct list below Tools, uses
  per-place and aggregate unread dots, persists its disclosure state, and
  preserves room order when messages arrive. Its whole-Sidebar collapsed form
  is one Chats hub.
- The existing pane header owns room identity, topic/member summary, search,
  Start agent, and one details popover; there is no nested chat header.
- The transcript is dense, same-sided, and grouped by sender/time with day and
  first-unread markers, links/code, timestamps, visible agent provenance, and
  one-level inline replies.
- Replies, small reaction sets, own-message edits, deliberate own-message
  deletion, mentions, and exact copied message links sync through the server
  and materialize into the cached transcript.
- Authenticated file cards support picker, native drag/drop, clipboard paste,
  verified download, image preview, and native open. A changing room cannot
  redirect an upload already started.
- Member lists distinguish available from away without exposing activity
  surveillance. Typing state is ephemeral, expires defensively, and never
  enters history.
- Desktop alerts are opt-in and limited to DMs and explicit @mentions; muting
  suppresses alerts but not unread state. No room, Chats-header, or dock badge
  indicator is shown below one unread message.
- Each room retains its draft and scroll position. Loading earlier history
  preserves the viewport; incoming messages follow only at the bottom and
  otherwise expose a new-messages control.
- Offline mode keeps cached history and search available, blocks sending with
  a clear explanation, and preserves the draft.
- Search covers the local cache, scopes to one/all rooms, jumps with context,
  and lets Escape return to results.
- Create channel, Join channel, and Direct message are short keyboard-safe
  flows with validation and known-person selection.
- A channel details view shows current members and supports topic edit, mute,
  and leave. A direct message can be muted or hidden.
- Start agent links the target before process spawn. Linked agents can use
  `chat_read`, `chat_search`, `chat_send`, and verified `chat_download` in that
  target; their visible provenance opens the originating Activity and the
  Activity can return to chat. The bounded room prompt is seeded as editable
  PTY input and is never submitted until the user presses Enter.
- A clean restart retrieves the passphrase from macOS Keychain in release (or
  the owner-only fallback in debug and elsewhere), reconnects to the public
  WebSocket, and restores the local cache without putting a secret in chat
  configuration.
- Production health monitoring, nightly checksummed backups, and no-write
  restore verification are installed without controlling unrelated services.

## Files

- Opening a workspace builds a native reviewable-file index sorted by most
  recently modified first with deterministic tie-breaking.
- Path filtering remains responsive and supports keyboard selection.
- Content search is cancellable and bounded by result, file, and byte limits.
- Project is the default and exposes a lazy expandable directory tree; Recent
  follows Editor-open history, and Favorites persists relative paths per
  workspace.
- A Project query uses the complete native file index rather than only loaded
  tree branches.
- Single-click opens or reuses a clean preview tab; Enter/double-click pins the
  tab. Text mounts CodeMirror, PDFs render in the Editor, and unsupported
  resources expose metadata plus default-app/reveal actions.
- Visible controls and empty-surface actions create files and folders inline
  under the selected directory.
- Right-click and Shift+F10 expose open/default-app, rename, duplicate, reveal,
  favorite, copy-path, and confirmed system-Trash actions.
- Cmd/Ctrl and Shift selection support safe bulk copy and Trash.
- Renames keep Editor and descendant favorite paths coherent; dirty text
  survives user-initiated Trash.
- Native operations reject paths outside the indexed workspace.
- Refresh rebuilds index metadata and reloads already visited tree directories
  without changing workspace or polling while Files is idle.

## Apps

- Stable Apps appear under Tools; terminal/process Apps and configured CLI
  presets appear in the Activities `+` menu and Cmd/Ctrl+P. There is no generic
  Apps destination.
- Tools support persistent manual ordering by pointer or Shift+Alt+Up/Down.
- The bottom Settings control remains visible in both Sidebar states; Settings
  > Apps is the catalog and management surface.
- Settings > Apps is a searchable, keyboard-operable local instrument manager
  for built-ins and valid definitions from `~/.mimir/apps`.
- It launches and reloads Apps, opens or reveals local definitions, creates a
  runnable starter app, duplicates local packages, updates display titles
  without changing stable ids, and moves exact definitions to Trash.
- App mutations update Sidebar launch rows immediately through the human UI.
- Invalid TOML, duplicate IDs, missing entries, and invalid modes produce
  visible diagnostics without hiding valid apps.
- Embedded, terminal, process, window, Rust-helper, and action launch plans
  resolve explicitly.
- Stable Apps reopen one singleton Tool Activity and do not duplicate
  themselves in Activities. Terminal and process Apps create one real PTY
  Activity from Sidebar or Settings.
- Embedded apps can use the host SDK for app data, files, HTTP, tools, and
  opening a file in the Editor.
- App-defined tools join the live registry and unregister with their instance.
- Reloading an already-mounted embedded App replaces its exact tool provider
  and reloads its frame without accumulating listeners.
- Today is a durable single-priority editor that restores former Scratch text,
  highlights Markdown source without a preview layer, autosaves, and is
  included in `mimir_state`.
- Today and Business graph are functional built-in Tools.
- Tracker is a functional built-in Rust-helper that is always discoverable in
  Settings but absent from Tools and Go to until explicitly enabled.
- Git state remains available through Files decorations and summaries; there
  is no separate Changes built-in.

## Tracker

- Tracker is disabled by default. While disabled it performs no sampling,
  permission request, AI call, notification, login launch, or menu-bar install,
  and retains existing history/configuration.
- Enabling lazily exposes the singleton Tool Activity and menu-bar controls.
  Armed, paused, needs-access, break, unsupported, and error states remain
  distinct and visible.
- App/bundle collection continues without Accessibility when title collection
  is off. Browser domains require a separate opt-in, retain no full URL, and
  degrade to app-only classification when denied.
- The elapsed-time engine confirms foreground changes, backdates AFK to the
  actual idle boundary, records OFF/relaunch gaps and manual breaks, and closes
  the current interval before explicit Quit.
- Closing the main window hides Mimir without stopping enabled Tracker.
  Launch at login starts with the workbench hidden and its status is visible;
  normal launch/Dock reopen still reveal it. Explicit Quit uses the ordinary
  editor guard and checkpoints Tracker before process exit.
- Day exposes an exact timeline ruler and evidence log. Week, Month, and All
  provide exact clipped totals, composition, work/leisure ratio, longest Work
  streak, app/subcategory rankings, daily stacks, and a local-time heatmap.
- Unknown keys queue durably for provider-agnostic AI classification through
  Mimir's model/keychain/host policy and one daily cost cap. Titles stay out of
  prompts by default; manual rules win and can reclassify matching history.
- Nudges respect grace, spacing, per-session maximum, lunch, earned-break, and
  end-of-day protection. Provider/cost failure uses a local humane fallback.
- Argus preview/import is read-only then transactional, refuses overlapping
  collectors, handles malformed/zero/reversed/DST records explicitly, keeps
  manual precedence, records a source hash, is idempotent, and never changes
  the Argus source files.
- SQLite survives relaunch with WAL checkpointing and quarantines a damaged
  database without deleting it; a newer schema fails closed.
- Tracker evidence is not exposed through `mimir_state`, graph context, or
  public agent tools.

## Business graph

- Knowledge and Issue Markdown remain canonical and dual-read through one
  Rust-owned GraphStore without mandatory source rewrites.
- Private, current-project, and optional team roots compose into projections
  without losing scope, source path, source revision, or legacy metadata.
- A query limited to project or team scopes never returns private nodes,
  backlinks, counts, or context.
- The bounded ontology accepts business and HEOR kinds, normalizes legacy
  `org` to `company`, and diagnoses malformed sources, duplicate ids, dangling
  relations, and unresolved identities.
- Issue Board behavior includes status/project grouping, drag-and-drop and
  keyboard-equivalent movement, visible columns, filters, sorting, due and
  attention states, revision-aware updates, and Trash/undo.
- Kanban cards keep fixed geometry and persistent priority/status/due
  controls; visual constraints per [design-system.md](design-system.md).
- Projects, People, Companies, Knowledge, and All expose useful Portfolio,
  CRM, directory, timeline, list, and relationship graph projections over the
  same nodes. Portfolio is an operational table rather than presentation
  tiles.
- Project and assignee controls resolve visible graph entities. Focus also
  authors the bounded business relation vocabulary without exposing a generic
  schema editor.
- Every dropdown and date/datetime control uses a styled Vue
  listbox/combobox or calendar with keyboard navigation and visible focus,
  never the platform's native `select`, `datalist`, date, or datetime UI.
- The app follows Scan → Peek → Focus: projections remain scannable, Peek is
  read-first with quick issue properties and a relationship sentence, and
  Focus uses one spacious scroll with syntax-aware Markdown and auto-growing
  text fields.
- The inspector preserves a context trail, commits drafts before every
  replacing navigation or scope refresh, opens sources and deliverables in the
  Editor, shows related Activities, and reports revision conflicts rather than
  overwriting them.
- `graph.context` bounds bodies and node count, preserves provenance and
  selected scopes, filters hidden relations, and redacts `record` or
  `redactFromContext: true` (`sensitive: true` compatibility) content by
  default. Direct reads and searches still return it.
- Start Work first presents an editable objective and explains the selected
  scopes and bounded context. Explicit confirmation creates a durable agent
  Activity with explicitly untrusted graph context and associates that
  Activity with the focus node.
- Semantic commands can move/assign/complete work, link project companies and
  contacts, record decisions, attach deliverables, create next actions, and
  capture HEOR evidence.
- `graph.migration_report` never writes; explicit project/assignee resolution
  is kind-checked; compatibility facades and golden round trips preserve
  legacy capability and unknown metadata.
- The 5,000-node index and 600-source startup, query, search, traversal,
  mutation, and refresh performance contracts stay within the debug budgets
  documented in [business-graph.md](business-graph.md).

## Routines

- TOML definitions load from `~/.mimir/routines` with per-file diagnostics.
- Five-, six-, and seven-field cron expressions and IANA timezones resolve
  deterministically.
- Scheduler state survives relaunch in `~/.mimir/routines-state.json`.
- Enabled routines fire once per scheduled instant according to overlap and
  missed-fire policy.
- Every run resolves its current launcher preset and becomes a durable Activity.
- Run now uses the same runtime path and visible status as scheduled runs.
- A returned routine run opens as a terminal-backed Activity; the `Routines`
  singleton remains the manager surface.

## Scribe meetings

- Sustained microphone use by a recognized call process yields one deduplicated
  local candidate. Disabled detection owns no listeners and emits no prompt.
- A candidate or manual start uses one deliberate Record action. Native code
  binds that action to a short-lived route/candidate authorization, but no
  participant-attestation checkbox or second confirmation screen is shown.
- Recording exposes a persistent elapsed-time, mute, and Stop control outside
  the Scribe surface. Only one recording can be active.
- Settings forwards microphone repair to the native permission request and
  opens system-audio repair only at the fixed macOS Screen & System Audio
  Recording privacy pane. While a configuration save is pending, mutation
  controls are visibly disabled and accepted overlapping changes commit in
  request order. Settings lists microphones by stable Core Audio identity and
  streams bounded microphone/system input levels until the user stops the test.
- Microphone and system audio commit as separate lossless timelines. Mute
  writes microphone silence; route/device interruption reopens both streams
  with aligned gap evidence and monotonic timestamps.
- Capture remains durable while local inference is slow or a custom provider
  disconnects. A provider failure is visible and never triggers a silent route
  fallback.
- Local transcription uses only a fully verified pinned artifact and Metal
  runtime. Custom transcription uses only the exact public HTTPS endpoint
  upgraded to WSS, explicit model, endpoint-bound Keychain secret, and
  versioned bounded protocol.
- Partial transcript revisions are visually distinct and replaced
  idempotently by finals. Stop does not label a transcript final while any
  provider tail or partial remains unresolved. A silent meeting with no
  unresolved partial completes with an empty terminal transcript and no
  fabricated title/summary job.
- Forced renderer loss leaves native capture running. Forced process loss
  restores an interrupted, honest record and reuses one immutable
  capture-generation transcript repair. Incomplete repair output stays
  private; one all-final pass atomically replaces stale STT rows while
  preserving gaps and history. Crash duration ends at the final committed
  audio coordinate. A promoted staged tail invalidates earlier transcript
  completeness; durable capture-failure intent restores Failed. A terminal
  transcript/lifecycle or job-acknowledgement crash boundary completes without
  loading a model, reading credentials, connecting a provider, or disclosing
  audio again. Dock/system Quit with no renderer window still performs native
  durable Stop, or restores Mimir and fails closed.
- Capture worker disk/device/driver failure becomes a durable visible
  failed/interrupted state immediately; it is not deferred until the user
  presses Stop.
- Delayed transcription reads only integrity-verified committed audio and uses
  the exact route/model approved for that meeting, even if provider settings
  later change. An explicit **Transcribe again** action instead freezes the
  currently selected route/model, preserves the prior transcript on failure,
  and atomically replaces it only after one all-final pass.
- Stop finalizes durable audio and transcript before enqueuing a visible
  title-and-summary Activity. Completed lifecycle and the default summary
  outbox commit atomically; Stop reads hook policy without reading the STT
  credential. The Activity uses exact argv and controlled, immutable transcript
  input; failures remain retryable under monotonic manual-retry generations.
- Summary review offers Summary, Brief, and Decisions + actions presets plus
  Custom. Presets seed an expandable per-run prompt and optional CLI agent;
  fine-tuning one run does not mutate global defaults. The editable text is
  wrapped in a fixed native safety/output prompt. Custom opens a durable
  interactive Activity with the exact meeting identity. Scribe presents no
  knowledge-graph shortcut in this flow.
- Meetings with summaries open on Summary. Global settings never appear in a
  meeting detail. List and detail share accessible context/overflow actions for
  Rename, Show in Finder, save-copy actions, retranscription, and confirmed
  Delete. Full-library search remains native and ordinary browsing groups
  Needs attention, Today, Previous 7 days, and Earlier.
- Agent tools can list, get, search, and update completed/interrupted Scribe
  records with bounded results. They cannot start, mute, stop, request
  permission, configure a provider, or publish a graph mutation. Search terms
  are at least three characters and cover full reviewed title/summary/tags
  plus terminal transcript across the complete library, not only the latest
  renderer page. Update rejects live/private records before invoking the
  platform content writer. Reviewed tags remain visible in native detail,
  agent list/search metadata, and the keyboard-editable Scribe review surface;
  public writes are bounded to 64 tags of 80 characters each and the native
  per-tag byte limit.
- Delete audio preserves the reviewed record. Delete meeting removes owned
  local data. Retention never removes active or recovery-held audio, including
  a collecting repair whose job attempts are exhausted. Repair cannot start a
  provider after committed source audio is gone.
- Packaged macOS arm64 release evidence covers TCC prompts, real two-channel
  capture, model inference, custom WSS, crash recovery, long-run budgets,
  signing, notarization, and clean install.

## Editor and comments

- Markdown tabs, open/save/save-as, autosave, formatting, spellcheck, live
  in-editor rendering, and session restoration remain functional.
- The Markdown formatting toolbar is mounted in the Editor, preserves
  CodeMirror selection/focus, responds to narrow widths, and can be hidden in
  Settings > Editor.
- Optional line numbers use a transparent paper gutter with aligned tabular
  digits and reconfigure live without recreating the document. The current-line
  tint sits on the number cell when visible and moves to the editor row when
  line numbers are hidden.
- Tabs expose the tablist contract, keyboard navigation, independent close
  controls, immediate overflow reveal, drag cancellation, and a stable New Tab
  landing page. Closing the final embedded tab yields the Editor pane instead
  of fabricating another document.
- Dirty named documents and untitled drafts survive a crash. Native
  close/Dock Quit confirms every dirty document, serializes the final session,
  and never resurrects an explicitly discarded draft.
- Clean open workspace text documents refresh automatically after an external
  disk write, including edits from a CLI agent. Only matching open paths are
  read; an unsaved dirty buffer remains authoritative.
- Cmd/Ctrl+K opens inline AI with or without a selection.
- Inline AI resolves `Auto` from the rewrite-model registry per request,
  explains missing provider configuration, and covers loading, tool, retry,
  cancel, follow-up, model-switch, accept, and reject states.
- AI edits open as full-document diffs and require explicit accept or reject.
  Proposal lifecycle failures remain visible and reviewable rather than
  silently dismissing the diff.
- Typing `++` requests ghost suggestions; keyboard acceptance, cycling,
  partial-word acceptance, cancellation, and error display work. Ordinary
  increment/C++ syntax and Enter keep their normal editor behavior.
- Comment storage remains pseudo-XML embedded in Markdown.
- Comment tags remain hidden/protected while anchor text stays editable and
  reviewable.
- Inline discussions support minimize/expand, reply editing/deletion,
  copy/paste or direct terminal agent prompt, resolve/reopen, delete, and
  remove-all.
- Resolve and reopen change stored status; delete preserves the anchored text.

## Release checks

- `bun run test`, `bun run build`, `bun run docs:check`, Rust formatting, Rust
  tests, and Rust check pass.
- Documentation references only current files and current local data paths.
