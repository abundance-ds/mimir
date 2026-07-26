# Gotchas

Non-obvious constraints that are still current in Mim 0.1.0.

## CSS and input

### Keep the button reset in `@layer base`

Tailwind v4 utilities are layered. An unlayered `button` reset outranks them and
silently removes utility backgrounds and borders. The reset in
`src/shared/styles/base.css` must remain inside `@layer base`.

### Preserve CodeMirror focus on toolbar actions

Toolbar `mousedown` normally moves focus and collapses the editor selection.
Formatting controls use `@mousedown.prevent`; keep that behavior when adding
editor actions.

## Activities and launchers

### Commands are exact argv, never shell strings

`src-tauri/src/launchers.rs` and `ActivityLaunchSpec` preserve every argument
boundary. Do not join preset arguments for a shell or add quoting. App process
launches and Routine prompts follow the same rule.

Settings presents those boundaries as one familiar CLI-flags field.
`launcherFlags.js` is the deliberate parsing/formatting boundary: quoted and
escaped input becomes an argv array before save. Do not move parsing into the
native spawn path or execute the field through a shell.

### Keep Codex's injected MCP name app-specific

Codex config overrides merge with existing tables. Injecting
`mcp_servers.mim.url` into a user config where `mim` is a stdio server creates
an invalid hybrid transport. Keep the one-run HTTP entry under
`mcp_servers.mim_workbench` unless a full migration strategy replaces it.

### Durable does not mean a process survives relaunch

Durable Activity metadata and bounded scrollback survive. PTY and child handles
do not. A record restored after Mim exits becomes interrupted and can start a
new continuation where its CLI supports one.

### Archive and clear require an ended durable Activity

The supervisor rejects archive/restore for ephemeral records and archive/clear
for live records. Keep those rules in the native owner; hiding a menu item is
not enforcement.

### Routine `timezone = "local"` resolves TZ, then UTC

`parse_timezone` in `src-tauri/src/routines.rs` maps `local` (or empty) to the
`TZ` environment variable and falls back to UTC when `TZ` is unset — the
normal case for a macOS GUI launch. `local` is therefore usually UTC, not the
system timezone; write an explicit IANA name for local-time schedules.

## MCP and apps

### Install renderer listeners before starting MCP

Core tools relay from Rust to the renderer. `src/services/toolRuntime.js`
subscribes to request and cancellation events before `tool_server_start`.
Reversing the order creates a race where an early call has no handler.
Shutdown keeps those listeners installed until `tool_server_stop` has closed
the native accept loop, then aborts remaining calls and removes listeners.
Every renderer mount owns a client lease. Vite HMR may briefly overlap old and
new mounts, so releasing the old lease must not stop the server while the new
lease is active.

### The loopback MCP endpoint is deliberately stateless

Do not add an `mcp-session-id` header without also implementing and validating
the complete session lifecycle. The current direct launcher clients do not
need sessions. The server negotiates only its explicitly supported stable
protocol versions instead of echoing arbitrary client input.

### Registry names and aliases are separate

Canonical names such as `files.read` identify capabilities inside Mim. MCP
aliases such as `read` are client-facing. Both must remain unique and every
tool's canonical metadata must survive transport listing.

### Dynamic app providers are instance-scoped

App tools belong to `(appId, instanceId)`. Unmount must unregister the provider,
remove listeners, and resolve or cancel pending calls. Otherwise a stale iframe
can keep owning a live tool alias.

### Local app HTML must use the `app://` host path

The catalog resolves local entries from disk, but
`src/services/appsCatalog.js` converts an embedded local URL to `app://` so the
native protocol can validate the path and inject the SDK/theme. Loading the raw
file URL skips that contract.

## Editor

### Comment tags need four protection layers

Pseudo-XML hiding depends on replacement decorations, atomic ranges,
`changeFilter`, and boundary key handlers. Removing one makes hidden tag syntax
editable or creates destructive cursor behavior.

Every deliberate tag mutation must include
`commentMutation.of(true)` so the change filter allows it.

### Comment collapse is presentation state

Minimize/expand state belongs to the CodeMirror widget draft map. Only comment
text, replies, and `status` belong in the Markdown pseudo-XML.

### Proposed edits must complete their Rust lifecycle

The Editor diff is presentation; the native proposal coordinator is lifecycle
authority. Proposal-backed accept/reject paths must report their outcome before
dismissing the review. If reporting fails, leave the diff open with a visible
retryable error.

### Ghost positions become stale on any edit

A ghost completion is tied to one document offset. The extension cancels an
active request or suggestion when another edit or pointer action changes that
context. Preserve the request serial checks around async completion.

The `++` trigger must not consume identifier-adjacent increment/C++ syntax or
fire without a completion provider. Alt+Right partial acceptance must be
checked before whole-suggestion ArrowRight acceptance, and Enter dismisses the
ghost while remaining available to CodeMirror.

### Auto is a policy, not a model id

Inline AI keeps `aiInlineModel = "auto"` stored and resolves the first
configured entry from `defaults.rewrite` for each request. Do not replace Auto
with the first menu row or send the literal `auto` when no provider is
configured.

## Persistence and settings

### Use atomic writers for runtime state

Launcher config, durable Activities, Routine state, app data, AI model
configuration, session state, settings, and editor document writes use helpers
in `src-tauri/src/persistence.rs`. Keep temporary files beside the target so
rename is atomic on the same filesystem. Ordinary document replacement
preserves an existing file's permissions.

Loaders that quarantine corrupt JSON preserve the original bytes under a
diagnostic filename before regenerating defaults.

Editor session writes are serialized so a slow older snapshot cannot overwrite
a newer close flush. Dirty named files include recovery content; a deliberate
Don't Save writes only the disk path and omits discarded untitled drafts.
Compare discarded files by stable path/draft identity because Pinia may expose
reactive proxies rather than the raw confirmation object.

Dock/system Quit is asynchronous: native `ExitRequested` emits
`mim://quit-requested`, the Editor completes dirty-document and session guards,
and only then invokes `app_quit_confirmed`. Never allow the first exit request
to bypass renderer confirmation.

### Interface zoom must stay a capture-phase chord

`workbenchZoom` is Tauri webview zoom, not CSS scaling; it needs the
`core:webview:allow-set-webview-zoom` capability. WorkbenchApp handles
Cmd+Plus/Minus/0 in its capture-phase keydown before the quick-open and modal
guards and stops propagation, so the chords work everywhere and never reach
xterm or CodeMirror. The standalone editor window (`?view=editor`) does not
mount WorkbenchApp and binds the same chords in `useKeyboardShortcuts`; that
duplicate binding is required, not accidental. The chords match only the
platform-primary modifier so Ctrl+- keeps reaching macOS terminal readline.

### Settings writes go through `settings.set`

`src/stores/settings.js` deliberately persists only explicit `set(key, value)`
calls. Direct assignments update reactive state but do not schedule the
debounced disk write.

### API key plaintext fallback is debug-only

Production key writes use the OS keychain. Repository `.env` and
`~/.mim/keys.env` are read only by debug builds; do not make them the release
storage path. Its atomic writer enforces owner-only permissions on Unix before
secret bytes are written.

### Localhost AI hosts work only in debug builds

`validate_url_host` in `src-tauri/src/ai_transport.rs` accepts
`localhost`/`127.0.0.1` only under `cfg(debug_assertions)`. A release build
rejects the identical provider URL, so a local model endpoint that works in
development fails after packaging.

## Files and platform

### Cancel superseded content searches

Workspace content searches have native tokens. Starting a new query must cancel
the previous token and ignore late reports, including reports from a refreshed
index generation.

### File-open events are queue notifications

Startup arguments, Finder/file-association events, and second-instance
arguments append absolute decoded paths to one native queue. The renderer
installs `mim://open-files-pending` before draining `take_pending_files`; do not
send paths only as an event payload or reintroduce the listen/drain race.

### Guard platform-only window APIs

macOS titlebar, traffic-light, and native spellcheck APIs require
`#[cfg(target_os = "macos")]`. Linux CI compiles the Rust app, so unguarded
platform calls break verification. Never retain a raw native-window pointer
across an async delay; a closed window makes it invalid.

### Keep product identity synchronized

Version must match in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`. The package/crate name is `mim-workbench`; the
desktop product name is `Mim`.
