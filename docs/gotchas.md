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

### Durable does not mean a process survives relaunch

Durable Activity metadata and bounded scrollback survive. PTY and child handles
do not. A record restored after Mim exits becomes interrupted and can start a
new continuation where its CLI supports one.

### Archive and clear require an ended durable Activity

The supervisor rejects archive/restore for ephemeral records and archive/clear
for live records. Keep those rules in the native owner; hiding a menu item is
not enforcement.

## MCP and apps

### Install renderer listeners before starting MCP

Core tools relay from Rust to the renderer. `src/services/toolRuntime.js`
subscribes to request and cancellation events before `tool_server_start`.
Reversing the order creates a race where an early call has no handler.

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
authority. Proposal-backed accept/reject paths must report their outcome after
applying or discarding the review.

### Ghost positions become stale on any edit

A ghost completion is tied to one document offset. The extension cancels an
active request or suggestion when another edit or pointer action changes that
context. Preserve the request serial checks around async completion.

## Persistence and settings

### Use atomic writers for runtime state

Launcher config, durable Activities, Routine state, and app data use helpers in
`src-tauri/src/persistence.rs`. Keep temporary files beside the target so rename
is atomic on the same filesystem.

Loaders that quarantine corrupt JSON preserve the original bytes under a
diagnostic filename before regenerating defaults.

### Settings writes go through `settings.set`

`src/stores/settings.js` deliberately persists only explicit `set(key, value)`
calls. Direct assignments update reactive state but do not schedule the
debounced disk write.

### API key plaintext fallback is debug-only

Production key writes use the OS keychain. Repository `.env` and
`~/.mim/keys.env` are read only by debug builds; do not make them the release
storage path.

## Files and platform

### Cancel superseded content searches

Workspace content searches have native tokens. Starting a new query must cancel
the previous token and ignore late reports, including reports from a refreshed
index generation.

### Guard platform-only window APIs

macOS titlebar, traffic-light, and native spellcheck APIs require
`#[cfg(target_os = "macos")]`. Linux CI compiles the Rust app, so unguarded
platform calls break verification.

### Keep product identity synchronized

Version must match in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`. The package/crate name is `mim-workbench`; the
desktop product name is `Mim`.
