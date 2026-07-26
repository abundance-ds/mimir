# IPC and event topology

This document maps non-obvious communication paths across Rust, the main
renderer, standalone/app windows, and embedded app frames. Command signatures
remain canonical in `src-tauri/src/lib.rs::generate_handler!` and their
defining functions; do not duplicate that list here.

## Boundary rules

- Renderer invokes belong behind `src/services/` unless the call is tightly
  local to an editor component.
- Rust command arguments serialize from JavaScript camelCase into Rust
  snake_case. Service wrappers own the translation and response normalization.
- Tauri events are notifications, not durable queues. State that must not be
  lost is stored natively and drained/snapshotted after the listener exists.
- Install listeners before starting producers. Remove them only after the
  producer has stopped or the owning window/provider has disconnected.
- Every request/response relay carries a stable request or correlation id.
  Cancellation must remove both execution ownership and the pending response.

`src/test/setup.js` contains the frontend Tauri-command allowlist. Adding or
removing a command requires updating both that set and
`src-tauri/src/lib.rs::generate_handler!`; otherwise happy-dom tests can either
reject a real command or conceal a removed one.

## Stable event paths

| Event | Publisher | Consumer | Non-obvious contract |
|---|---|---|---|
| `mim://activity-event` | `activity_commands.rs` sink | `activityRuntime.js` | ordered native upsert/status/exit projection; listener precedes initial `activity_list` |
| `mim://routines-changed` | `routine_runtime.rs` sink | `services/routines.js` | notification payload may update catalog/run state; explicit catalog load remains recovery path |
| `mim://open-files-pending` | `file_open.rs` | `useFileOpen.js` | payload is empty; consumer drains the native queue with `take_pending_files` |
| `mim://tool-relay-request` | Rust UI/app provider | core renderer or app relay | request id owns timeout/cancel/response |
| `mim://tool-relay-cancel` | Rust provider | same relay | abort before deleting pending entry; late response is ignored |
| `mim://tools-list-changed` | registry revision observer | dynamic clients | revision notification only; clients fetch a new snapshot |
| `mim://proposals-changed` | proposal coordinator | Editor | pending proposal list used for display/reconciliation |
| `mim://proposals-state` | proposal coordinator | other proposal consumers | complete state snapshot, unlike the pending-only event |
| `mim://proposal-apply` | proposal coordinator | owning Editor window | delegated apply; Editor must answer through `proposal_respond` |
| `mim://proposal-result` | proposal coordinator | main Editor | terminal lifecycle result; failed/conflict/stale stays reviewable |
| `mim://file-updated` | native proposal or renderer comment tools | Editor | refresh open clean content without replacing unsaved ownership |
| `mim://settings-changed` | `settings_changed` command | other windows | notification excludes caller; receiver flushes its local snapshot before reload |
| `mim://theme-changed` | settings store | terminal/app observers | renderer event used for live theme projection, not persistence |
| `mim://quit-requested` | Rust `ExitRequested` handler | Editor | begins guarded asynchronous Quit; native exit remains prevented |

AI streaming events are correlation-scoped rather than stable names:
`ai-stream-chunk-<id>`, `ai-stream-done-<id>`, and
`ai-stream-error-<id>`. `src/services/ai/bridgeFetch.js` must attach all three
listeners before invoking `ai_proxy_stream`.

## MCP/core tool relay

The path for a renderer-backed MCP call is:

```text
HTTP tools/call
  -> ToolRegistry schema validation and canonical lookup
  -> UiToolProvider pending call + timeout
  -> mim://tool-relay-request
  -> src/services/toolRuntime.js
  -> editor/store/native service handler
  -> tool_relay_response
  -> provider resolves pending id
  -> ToolRegistry result normalization
  -> MCP structuredContent + text
```

`createToolRuntime.start` subscribes to request and cancel before acquiring a
tool-server client lease. `stop` releases the native lease while listeners are
still present, then aborts remaining renderer work. Reversing either order
creates an accepted-call race.

App providers use the same Rust relay but a separate renderer implementation
in `src/services/appsCatalog.js` and frame protocol in
`src/mim/apps/EmbeddedAppHost.vue`. Provider identity is
`(appId, instanceId)`; a replacement instance unregisters stale ownership
before reconciling its definitions.

## File-open queue

Startup arguments, file associations, Finder open events, and second-instance
arguments all append normalized absolute paths to
`PendingFilePaths`. The native event contains no path by design:

1. renderer installs `mim://open-files-pending`;
2. renderer calls `take_pending_files`;
3. any later producer appends and emits another notification.

Putting paths only in the event payload reintroduces the listen/drain race.
See `src-tauri/src/file_open.rs`, `src/editor/composables/useFileOpen.js`, and
`useFileOpen.test.js`.

## Proposal coordination

`proposal_create` stores the proposal centrally after the initiating renderer
has opened its diff. Editors periodically register their path/dirty/active
snapshot through `proposal_register_editor`. On apply, Rust selects an owner:

- a matching dirty/open Editor receives `mim://proposal-apply`;
- otherwise Rust applies against disk after its conflict checks;
- an unavailable delegated window becomes `failed`;
- Editor responses map `applied`, `rejected`, `not-found`, and `conflict` into
  central terminal states.

Never dismiss a diff before `proposal_respond` succeeds. See
`src/editor/composables/useProposalBridge.js`, `useDiffReview.js`, and the
proposal coordinator in `src-tauri/src/lib.rs`.

## Change map

| Change | Files that must agree | Tests |
|---|---|---|
| Add/remove Tauri command | defining Rust module, `lib.rs`, service wrapper, `src/test/setup.js` | wrapper/component test plus Rust command logic |
| Add event | publisher, consumer setup and cleanup, test mock/listener assertions | nearest service/composable test |
| Change tool relay payload | `tool_bridge.rs`, `tool_runtime.rs`, `services/toolRuntime.js` or `appsCatalog.js` | Rust bridge/runtime and JS runtime tests |
| Change proposal status | Rust coordinator, diff/proposal composables, stores | `useProposalBridge.test.js`, `useDiffReview.test.js`, Rust tests |
| Change file-open behavior | `file_open.rs`, `useFileOpen.js` | Rust and composable tests |

See [runtime-architecture.md](runtime-architecture.md), [mcp.md](mcp.md), and
[apps-system.md](apps-system.md).
