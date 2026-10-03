# Issues

Known defects and gaps. Check before editing; add problems found outside your
task scope.

## Open

- Workspace tests: three `workbenchControllers.test.js` assertions count the
  new `set_smart_quotes` startup call as workspace I/O. Two `WorkbenchApp.test.js`
  menu assertions read a Vue `v-if` comment node through `firstChild`. These five
  failures remain outside the comment review change.

- Spelling: native macOS verification of Mimir-drawn underlines, the custom menu,
  and absence of native popups remains open. The development sandbox denies
  access to the Apple spelling service (`NSCocoaErrorDomain` 4099, sandbox
  restriction). Renderer mocks and a native compile cannot close this check;
  follow [Editor spelling verification](editor-system.md#spelling-and-automatic-text-input).

- `scripts/tauri.mjs`: the Windows release error cites a restoration path in
  `building.md` that the doc does not contain. Fix the message or add the path.

- Code comments in `useBoardDrag.js` and `BusinessGraphApp.test.js` cite a
  `gotchas.md` anchor that does not exist; the constraint is a bullet under
  [UI and input](gotchas.md#ui-and-input).

- Packaged skills: `skills/mimir-config/SKILL.md` has 227 words; limit in
  `mimir_cli.rs` is 220. `packaged_skills_stay_lean` test fails.

- Interactive sheets (deferred): Markdown tables lack cell editing and live
  formulas. Candidates: Jspreadsheet CE, Univer Sheets, Handsontable +
  HyperFormula. Check size, formulas, and licenses. Multi-user editing is
  separate scope.

- Connection setup: automated coverage exists for credentials, OAuth flows,
  login subprocess lifecycle, and inline forms. Remaining: signed-app checks
  with real Google/Slack consent, Slack/Granola Keychain storage, and GitHub
  login. The agent runs the checks; the user supplies only login and consent.

- Native Editor menu: Select All, Undo, and Redo call the Editor surface even
  when a non-editor text input (e.g. Go to search) has focus. Route these edit
  commands to the active text control. Copy/Cut/Paste use native roles.

- Editor document changes: native macOS verification needed for sidebar opens,
  key routing, close decisions, and restart recovery. Follow
  [Editor verification](editor-system.md#verification).

- CLI entry path: `bin/mimir.mjs` compares `pathToFileURL(process.argv[1])`
  against `import.meta.url` without resolving symlinks. A symlink (e.g.
  `/tmp` vs `/private/tmp` on macOS) silently exits with status 0. Resolve both
  paths before comparison.

- Scribe notification repair: banner/RECORD behavior, repeated-call CPU, call
  transitions, and signed installed-app verification need real-app records.
  See [meetings.md](meetings.md).

- Files sidebar: native verification open for file-drop,
  workspace-switch-during-search, and click/Return rename-focus.
  See [files.md](files.md#verification).

- Release 0.3.3: basic signed-app checks passed
  ([building.md](building.md#release-smoke)). Permission prompt capture,
  Scribe smoke, and managed Git evidence remain open.

- Image preview: verify physical pinch, default-app opening, and return-focus refresh in the installed macOS app.

- Git dependency review: revisit the local Git and `gh` dependency after real
  Team onboarding. Keep it (no Mimir-owned token) unless `gh` install or
  sign-in causes repeated setup friction; only then consider GitHub device
  login. Keep the existing-repository-only URL handoff while GitHub's form
  handles owner, visibility, and collaborator choices.

- Managed Team: needs a signed-release smoke record covering GitHub login,
  repository URL setup, two-machine sync, offline recovery, History, and
  repository migration. Automated tests cover rollback, validation, limits,
  batching, merging, and recovery.

- Project-specific agent context (deferred): `contextPolicy` and isolation
  code removed. Before reintroducing, define retrieval boundary, workspace
  behavior, and human control as one design. A workspace Project link
  associates new work but does not restrict graph reads.

- Local Apps management (deferred): `Settings > Apps` was removed (no local
  definitions, duplicated navigation). Native app commands, catalog, launch
  pipeline, and SDK remain. Revive only for real definitions under
  `~/.mimir/apps`: one Settings destination, local apps and diagnostics only.
  Built-in apps (Today, Scribe, Business graph, Tracker) stay out.

- Scribe not ready: `com.abundanceds.mimir` identity needs signed installed-app
  smoke (TCC, microphone, live transcription, Stop, library reads). Live
  audio-to-durable transcript and interrupted-recording recovery still need
  signed end-to-end records. Automated contracts do not substitute for those.

- Business graph: desktop screenshots (narrow/default/wide, rail,
  reduced-motion) remain a manual release check.

- Terminal `working` status (deferred): current live-shell state is `idle`.
  Any implementation needs the command-boundary contract in
  [activities.md](activities.md#plain-terminal-status).

- Terminal replay: verify no replay after >5 min minimized in rebuilt macOS app.
  Mocked tests cannot prove WebKit scheduling or GPU behavior.

- Live Preview nested emphasis: `***bold italic***` keeps its inner `**`
  visible. In `livePreview.js`, `StrongEmphasis` is never reached
  because `Emphasis` returns false; the Emphasis handler hides only the
  outer marks (first and last `EmphasisMark`).

- Editor comment navigation is available only while the formatting toolbar is
  enabled. Add reusable keyboard or menu commands before treating comment
  navigation as independent of toolbar visibility.

- Unified-diff deletion widgets render original text without comment
  concealment. When a proposal deletes commented text, the struck-through
  block shows the raw pseudo-XML tags. Editor panes and both split panes
  conceal correctly; only the library-rendered deletion widget is affected.

- Proposal restart: `create` proposals survive in `proposals.json` but have
  no open tab after restart. `checkProposalsForFile` in
  `useEditorProposalLifecycle.js` only checks proposals matching the
  current file's path, so `create` proposals stay invisible.
