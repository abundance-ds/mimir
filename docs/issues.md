# Issues

Known defects and gaps. Check before editing; add problems found outside your
task scope.

## Open

- Go to chords: native macOS verification of Cmd+P then Cmd+P, Cmd+O, Cmd+S, and
  Cmd+F remains open. Renderer tests cover the native menu callbacks, and
  browser checks cover the helper layout and saved minimized state. They do
  not establish installed-app accelerator delivery.

- Native Editor menu: Select All, Undo, and Redo call the Editor surface even
  when a Go to search input has focus. Route these edit commands to the active
  text control and verify them in macOS. Copy, Cut, and Paste use native roles.

- Editor document changes need a native macOS verification record for sidebar
  opens, key routing, close decisions, and restart recovery. Follow
  [Editor verification](editor-system.md#verification) with disposable files;
  renderer tests do not establish this evidence.

- CLI entry path: running `bin/mimir.mjs` through a symlink path can exit with
  status 0 and no output. The script-entry check compares the raw argument URL
  with the resolved module URL. On macOS, `/tmp` versus `/private/tmp` reproduces
  this. Resolve both paths before comparison and test a symlink entry point.

- Scribe tests: the reviewed-summary case in `ScribeApp.test.js` failed in a
  full-suite run but passed when that file ran alone; investigate its
  asynchronous completion check.

- Scribe notification repair: real banner/RECORD behavior and repeated-call CPU
  observations need a record from the repaired app. A long run with call
  transitions and signed installed-app verification remain open. Automated
  lifecycle tests do not establish these results; behavior belongs in
  [meetings.md](meetings.md).

- Files sidebar: native file-drop and workspace-switch-during-search checks
  remain open. The current development build has native evidence for search
  order, match navigation, separate panel queries, and the revised Files layout;
  see [files.md](files.md#verification).

- Release 0.3.2: signed installed-app checks for launch/relaunch, file save,
  one terminal Activity, and permission prompts have no new runtime record.
  The Scribe and managed Git evidence gaps below also remain open.

- Image preview: verify physical pinch, default-app opening, and return-focus refresh in the installed macOS app.

- Review the local Git and GitHub CLI dependency after real Team onboarding.
  Keep it while it reuses existing small-team setup with no Mimir-owned token.
  Reconsider GitHub device login only if installing or signing in to `gh`
  creates repeated setup friction. Also review the existing-repository-only
  URL handoff. Keep it while GitHub's form is the simplest place to choose a
  personal or organization owner, visibility, and collaborators.

- Managed Team needs one signed-release smoke record for real GitHub login,
  personal/organization repository URL setup, two-machine sync, offline
  recovery, History, and moving Team between repositories.
  Local automated coverage owns setup rollback, repository validation,
  resource limits, batching, merging, and recovery references.

- Project-specific agent context is intentionally deferred. The unfinished
  `contextPolicy` and isolation behavior were removed because the boundary and
  user journey were not clear enough. Before this returns, define the retrieval
  boundary, workspace behavior, and simple human control as one coherent design.
  For now, a workspace Project link associates new work but does not restrict
  graph reads.

- Local Apps have no management surface. The empty `Settings > Apps` section
  was removed because it exposed no installed local definitions and duplicated
  built-in product navigation. The native app commands, catalog store/service,
  launch pipeline, and SDK remain. Revive the manager only for real definitions
  under `~/.mimir/apps`: add one direct Settings destination, show local apps
  and diagnostics only, reconnect definition editing and app launch to the
  Editor and Workbench, and restore focused UI tests. Do not put Today, Scribe,
  Business graph, or Tracker in that manager.

- Scribe is not ready. The retired application identity passed first-run TCC
  registration, known-playback microphone/system signal, dual-channel local
  live transcription, Stop, and fast historical-library reads on the reference
  Mac. The current `com.abundanceds.mimir` identity needs the same signed
  installed-app smoke. A real endpoint-bound Keychain credential completed
  OpenAI transcription-session creation, but live audio-to-durable transcript
  and interrupted-recording recovery still require signed end-to-end records.
  Automated contracts are necessary evidence, not a substitute for those
  provider/recovery paths.

- Business graph: desktop screenshots (narrow/default/wide, rail and
  reduced-motion states) remain a manual release check.

- Terminal command-aware `working` status is a future specification candidate.
  The current truthful live-shell state is `idle`; any later implementation
  needs the explicit shell command-boundary contract in
  [activities.md](activities.md#plain-terminal-status).

- Terminal: verify no replay after >5 minutes minimized in a rebuilt macOS app;
  mocked tests cannot prove WebKit scheduling or GPU frames.

- Live Preview hides only the outer marks of nested emphasis. `***bold
  italic***` keeps its inner `**` because the Emphasis and StrongEmphasis
  handlers in `livePreview.js` stop at the outer node.

- Editor comment navigation is available only while the formatting toolbar is
  enabled. Add reusable keyboard or menu commands before treating comment
  navigation as independent of toolbar visibility.

- Unified-diff deletion widgets render original text without comment
  concealment. When a proposal deletes commented text, the struck-through
  block shows the raw pseudo-XML tags. Editor panes and both split panes
  conceal correctly; only the library-rendered deletion widget is affected.

- Proposal restart recovery covers `edit` proposals. A pending `create`
  proposal survives in `~/.mimir/proposals.json` but has no open tab to
  re-offer it after a restart, so it stays invisible until a caller applies
  or rejects it.
