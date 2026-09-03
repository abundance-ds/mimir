# IPC and events

Tauri command signatures are canonical in
`src-tauri/src/lib.rs::generate_handler!`. Renderer calls normally go through
`src/services/`; JavaScript camelCase arguments map to Rust snake_case fields.

## Rules

- Add or remove every command in both `generate_handler!` and the test allowlist
  in `src/test/setup.js`.
- Events are notifications, not durable queues. Install the listener before the
  producer, then read or drain native authority.
- Remove listeners only after the producer or owning lease stops.
- Request/response relays use stable correlation ids. Cancellation removes
  execution ownership and the pending response.

## Non-obvious event contracts

| Event | Contract |
|---|---|
| `mimir://activity-event` | Listen before `activity_list`; native sequence is authoritative |
| `mimir://routines-changed` | Invalidate or update the catalog; native reload remains recovery |
| `mimir://tracker-changed` | Revision notification; SQLite remains authority |
| `mimir://open-files-pending` | Payload is empty; drain the native path queue after listening |
| `mimir://tool-relay-request` / `cancel` | Correlation id owns timeout, abort, and response |
| `mimir://tools-list-changed` | Revision only; clients fetch a new catalog |
| `mimir://managed-git-error` | Listen before activation sync; current native error can be re-emitted |
| `mimir://settings-changed` | Other windows flush local state before reload |
| `mimir://quit-requested` | Native exit remains blocked until the Editor confirms |

Proposal events are centrally coordinated in Rust. An open or dirty matching
Editor receives delegated apply; otherwise Rust applies to disk after conflict
checks. A review closes only after `proposal_respond` succeeds. Pending
proposals persist by id and survive restart.

AI stream event names include their correlation id. App tool relays also carry
`(appId, instanceId)` so a replaced frame cannot retain tool ownership.

See [runtime-architecture.md](runtime-architecture.md) for startup and shutdown
order and [mcp.md](mcp.md) for the network tool boundary.
