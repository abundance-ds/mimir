# Gotchas

Non-obvious constraints that are still current in Mimir 0.1.0.
Known defects: [issues.md](issues.md).

## Terminal

### WebGL fallback lifecycle

The WebGL renderer is loaded after `terminal.open()`. If WebGL setup fails or
its context is lost, the addon disposes itself and xterm's built-in DOM renderer
keeps the session usable. Do not treat context loss as a terminal error.

### Unicode 11 addon requires `allowProposedApi`

The Unicode 11 addon supplies correct emoji/wide-character cell widths and
requires `allowProposedApi: true`. Without it xterm throws at load and the
surface shows an attach error instead of a terminal.

### Font readiness and pixel snap

Terminal initialization selects the native system monospace stack and waits for
the document font set before xterm measures cells. Do not open xterm while
another face can still change layout. `scheduleFit` snaps the WebGL screen onto
the device pixel grid; without it fractional pane-split offsets soften every
glyph. The transform must be cleared before measuring so the offset never
compounds.

### zsh spawn-size `%` artifact

The shell prints its first prompt before the terminal surface mounts. zsh pads
its partial-line mark to the PTY width: spawning wider than the eventual pane
strands a wrapped `%` line at the top of scrollback. Undershoot is corrected
invisibly by the first fit resize. `src/services/activities.js` remembers the
last pane-fitted size for spawn/respawn — do not reintroduce a generous
hardcoded default.

## CSS and input

### Keep the button reset in `@layer base`

The `button` reset in `src/shared/styles/base.css` must remain inside
`@layer base`; an unlayered reset outranks Tailwind v4 utilities.

### Preserve CodeMirror focus on toolbar actions

Toolbar `mousedown` normally moves focus and collapses the editor selection.
Formatting controls use `@mousedown.prevent`; keep that behavior when adding
editor actions.

### WebKit never focuses buttons on click

WKWebView (unlike Chromium and jsdom) leaves `document.activeElement` on
`<body>` after a `<button>` click, so focus-owner logic must not rely on
`document.activeElement` after mouse interaction. The workbench keyboard
router remembers the pane on capture-phase `pointerdown` and falls back to
that remembered owner when the live focus owner is `none`. Any new
focus-dependent feature needs the same fallback — the quirk is invisible in
browser dev and in tests, where clicks do focus buttons.

## Activities and launchers

### Commands are exact argv, never shell strings

`src-tauri/src/launchers.rs` and `ActivityLaunchSpec` preserve every argument
boundary. Do not join preset arguments for a shell or add quoting. App process
launches and Routine prompts follow the same rule.

Settings presents those boundaries as one familiar CLI-flags field.
`launcherFlags.js` is the deliberate parsing/formatting boundary: quoted and
escaped input becomes an argv array before save. Do not move parsing into the
native spawn path or execute the field through a shell.

### Keep Codex's injected MCP name product-owned

Codex config overrides merge with existing tables. Mimir therefore owns the
product-specific `mcp_servers.mimir_workbench` identity. Do not replace it with
the generic name `mimir` or reuse it for another transport.

### Durable does not mean a process survives relaunch

Durable Activity metadata and bounded scrollback survive. PTY and child handles
do not. A record restored after Mimir exits becomes interrupted and can start a
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

See also [Terminal](#terminal) for spawn-size, WebGL fallback, pixel snap, and
Unicode 11 constraints.

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

### Public and internal names are separate

Canonical dotted names such as `files.read` identify capabilities inside
Mimir. The public MCP projection accepts only the underscore names in
`AGENT_TOOLS`; it does not expose dotted names, historical aliases, or
canonical metadata.

### Dynamic app providers are instance-scoped

App tools belong to `(appId, instanceId)`. Unmount must unregister the provider,
remove listeners, and resolve or cancel pending calls. Otherwise a stale iframe
can keep owning a live tool alias.

### Local app HTML must use the `app://` host path

The catalog resolves local entries from disk, but
`src/services/appsCatalog.js` converts an embedded local URL to `app://` so the
native protocol can validate the path and inject the SDK/theme. Loading the raw
file URL skips that contract.

## Scribe

### Keychain success requires endpoint-bound read-back

The hosted transcription key field must not clear merely because an IPC call
was issued. Native storage writes the endpoint-bound payload and reads it back
before returning success. Settings owns the visible saved/replace/remove state
and retains entered text on failure.

Keep the `keyring` dependency's `apple-native` Cargo feature enabled. Without
it, the crate selects an in-memory mock on macOS: writes appear successful but
disappear before read-back and never reach Keychain.

### Summary defaults and per-run recipes are different scopes

`summaryTemplate`, `summaryPrompt`, and `summaryPreset` are global defaults.
Review seeds a per-run draft from them; editing that draft must not update
global settings. `meetings_run_summary` freezes the exact format, prompt, and
launcher preset into a new retry-generation job. The native safety/output
envelope remains fixed around the editable instructions. Custom follow-up is a
separate interactive Activity, not a summary template or graph shortcut.

### Classify staged audio before accepting terminal text

A terminal transcript is not sufficient at restart until native recovery has
classified every staged audio row. A successfully promoted tail means the
terminal text is stale and must be repaired under the original capture
generation. Do not move terminal reconciliation ahead of
`finish_audio_recovery` or derive crash duration from the relaunch clock. The
full authority order is owned by [meetings.md](meetings.md).

### A collecting repair is an audio-retention hold

The `collecting` repair row survives independent job exhaustion and prevents
both retention and explicit source-audio deletion. Job state alone is not
enough to decide that audio is disposable. In the opposite direction, a retry
must prove committed source audio exists before starting a model or custom
provider; otherwise it could replace a valid transcript with an empty repair.

### Complete lifecycle and the default hook as one outbox transaction

Do not transition to `Completed` and enqueue the default title/summary job in
separate writes. The combined store operation is the crash boundary. Stop also
uses the narrow hook-configuration projection: reading the broader platform
projection would unnecessarily touch custom-STT credential authority.

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
`mimir://quit-requested`, the Editor completes dirty-document and session guards,
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
`~/.mimir/keys.env` are read only by debug builds; do not make them the release
storage path. Its atomic writer enforces owner-only permissions on Unix before
secret bytes are written.

### Localhost AI hosts work only in debug builds

`validate_url_host` in `src-tauri/src/ai_transport.rs` accepts
`localhost`/`127.0.0.1` only under `cfg(debug_assertions)`. A release build
rejects the identical provider URL, so a local model endpoint that works in
development fails after packaging.

### Scribe local and custom routes are different trust classes

“Local” means the managed in-process Whisper runtime and never a localhost
URL. A custom Scribe endpoint must be public HTTPS in debug and release; Mimir
upgrades it to WSS, DNS-validates and pins it, and releases its Keychain secret
only for that exact configured endpoint. Do not reuse `ai_transport.rs` or add
a localhost exception.

The OpenAI Realtime route is selected by the `/v1/realtime` path plus a
`gpt-*` model. It uses OpenAI's JSON event contract over two channel-specific
WebSockets and no `mimir.stt.v1` subprotocol. Keep the user-facing and
credential-bound endpoint canonical; the native OpenAI connector alone adds
the wire-only `intent=transcription` query selector. Other advanced hosted
URLs still use Mimir's versioned provider-neutral contract. Do not send the
proprietary start/audio frames to OpenAI or treat arbitrary URLs as
OpenAI-compatible.

### Scribe permissions belong to the application bundle

macOS TCC attributes a decision to the responsible application, so `cargo run`
can observe a terminal or development host's permission. Never project that as
Mimir permission. System-audio process taps expose no public non-prompting
authorization query: create the public tap to register/prompt, label the state
honestly, and use the bounded known-playback check to verify the signal path.
The check must retain no samples and must identify development-host results.

### Scribe startup must not scale with meeting history

The owner-only `~/.mimir`, meetings, and model roots are the startup access
boundary. Repair targeted authority files when opened, but never recursively
stat/chmod every audio chunk or model artifact at launch. Transcript pages are
secondary hydration and cannot hold the Record action unavailable.

The raw library rows intentionally contain no transcript text. Live and Review
surfaces must use the store's selected-meeting projection, which overlays the
bounded transcript page. Rendering a raw `meetings[]` row makes durable words
appear to vanish even though SQLite remains correct.

### Scribe mute is not pause

Microphone mute writes aligned silence while system capture and the canonical
clock continue. Do not introduce a paused lifecycle or remove muted frames:
that makes microphone/system timestamps and reconnect replay disagree.

Normal Stop can observe bounded callback skew between otherwise healthy Core
Audio sources. Pad that scheduling tail without opening a transcript gap; a
source divergence beyond the audited tolerance is still missing-audio evidence
and must remain an explicit gap.

### Capture and transcription must never share backpressure

The native audio callback may only write into the bounded realtime ring.
Durable one-second chunks are the handoff to local/custom STT. Do not await
inference, sockets, renderer events, or SQLite from the callback, and do not
let an STT failure stop or discard already captured audio.

STT must enumerate committed chunk rows from SQLite, then revalidate the
canonical path, metadata, length, digest, and no-follow open before disclosure.
Never rediscover audio by walking a meeting directory. Recovery also stays
bound to the exact route and model persisted from Start consent; current global
settings are not authority for older audio.

### Scribe events are invalidations, not transcript authority

The renderer installs both meeting listeners and then reads a snapshot.
Destroyed windows can miss events while native recording continues. Keep
events small and revisioned; correctness belongs to SQLite plus snapshot/page
reads, not event replay.

Dock/system Quit has a native windowless guard for the same reason. If native
meeting state cannot be inspected, restore the window and fail closed instead
of allowing process exit.

### Scribe library search never depends on the renderer snapshot

The UI snapshot is deliberately capped. Agent search uses the private SQLite
indexes for full reviewed titles, summaries, tags, and terminal transcript
text, then loads only the bounded matching meetings. Keep the three-character
trigram minimum: falling back to substring-scanning arbitrary 4 MiB summaries
would hold the serialized meeting runtime for unbounded time. Content-file
fingerprints repair interrupted index synchronization without rereading every
summary on every launch.

### Scribe repair output is private until one terminal reconciliation

Never key transcription repair to `transcript_revision`; live or partial repair
output changes that value and can mint competing jobs after a crash. The
capture `runId` is the stable generation. Repair replays verified committed
audio from sequence zero into private staging, emits no renderer transcript
events, and atomically replaces the STT projection only after every staged
segment is final. Preserve capture-owned gaps and revision history. If a
terminal transcript is already authoritative, complete lifecycle or job
redelivery locally and do not resolve credentials, load a model, reconnect a
provider, or read audio again.

### Silence is a valid terminal transcript

A provider that drains with zero final segments and zero unresolved partials
represents a silent or too-short meeting, not a repair loop. Commit an empty
terminal revision and complete the meeting without starting title, summary, or
graph work. Unresolved partials still fail closed.

### Stop-time agents consume hostile transcript text

Meeting speech can contain instructions, paths, JSON, or shell syntax. Hook
launches must preserve exact argv, keep owned paths below the meeting root,
reject symlinks, bound reads/output, and validate the complete output schema.
Never interpolate transcript content into a command line or directly mutate
the knowledge graph.

## Files and platform

### Cancel superseded content searches

Workspace content searches have native tokens. Starting a new query must cancel
the previous token and ignore late reports, including reports from a refreshed
index generation.

### File-open events are queue notifications

Startup arguments, Finder/file-association events, and second-instance
arguments append absolute decoded paths to one native queue. The renderer
installs `mimir://open-files-pending` before draining `take_pending_files`; do not
send paths only as an event payload or reintroduce the listen/drain race.

### `PhysicalPosition` on a drag-drop event is not physical

Tauri types the webview drag-drop position as `PhysicalPosition`, but
`tauri-runtime-wry` passes wry's raw platform coordinates through unconverted,
and wry uses each platform's own units: AppKit points on macOS and GTK widget
coordinates on Linux (both logical), `ScreenToClient` device pixels on Windows.
Dividing by `devicePixelRatio` therefore slides every macOS drop up and to the
left by the display scale, which lands it on a different row — or a different
pane — with no error. `useFileDrop.js` scales per platform and measures the
window against the viewport so interface zoom is included; re-check
`dropCoordinatesArePhysical()` when wry is upgraded.

### HTML5 drag and drop is dead inside the webview

The same Tauri drag-drop interception that delivers OS file drops (above)
swallows the webview's native DnD, so `draggable` elements never receive
`drop`. Disabling the interception would trade away folder drops from outside.
Any in-app drag — Sidebar reorder, Files tree moves — must be pointer-event
driven (`usePointerReorder.js`, `useFileTreeDrag.js`); do not reach for HTML5
DnD when adding a new one.

### Guard platform-only window APIs

macOS titlebar, traffic-light, and native spellcheck APIs require
`#[cfg(target_os = "macos")]`. Linux CI compiles the Rust app, so unguarded
platform calls break verification. Never retain a raw native-window pointer
across an async delay; a closed window makes it invalid.

### Keep product identity synchronized

Version must match in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`. The package/crate name is `mimir`; the
desktop product name is `Mimir`.
