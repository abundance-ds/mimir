# Runtime architecture

Rust owns processes, durable stores, tools, Graph, Tracker, Scribe, Chat, and
filesystem boundaries. Renderer stores project native state and own the
Workbench, Editor buffers, and UI-only navigation. Do not move authority into a
convenient caller.

## Bootstrap

Native setup in `src-tauri/src/lib.rs`:

1. Construct registries and native runtimes.
2. Install the CLI and projected skills.
3. Create the main window and attach native event sinks.
4. Start Routines and restore enabled background systems.
5. Register native and renderer-backed tool definitions.
6. Install Connections and Chat.
7. Queue startup file arguments.

The renderer starts the MCP socket only after its relay listeners exist.
Native runtimes must not depend on a mounted renderer or one particular window.

Workbench startup:

1. Install singleton Tool records and global handlers.
2. Load settings and restore a valid pane layout with Editor expanded.
3. Start launchers, Activities, tool relay, and Apps independently.
4. Open the saved workspace after those initializers settle.
5. Restore the selected Activity when it still exists.

One initializer failure must not cancel unrelated systems. Workspace opening
mounts Private, Workspace, and optional Team Graph roots separately. Editor
session hydration completes before draft creation, persistence, native
listeners, and file-open draining.

## IPC and lifecycle

- Renderer invokes normally go through `src/services/`.
- Install event listeners before starting producers, then read the native
  snapshot that closes the startup gap.
- Core singleton Activities are renderer records; PTY Activities are native.
- Editor buffers stay renderer-owned. Native proposal state coordinates callers
  and restart recovery but is not a second editor store.
- Every async controller rejects late listener installation after disposal.
- Window destruction releases that window's runtime and tool-server leases.

## Quit

1. Rust intercepts application exit and asks the main renderer to quit.
2. Editor hydration and content synchronization finish.
3. The user resolves every dirty document.
4. Session and Settings snapshots flush.
5. Renderer confirms native exit.
6. Native code disconnects Chat, stops Tracker and Routines, interrupts live
   Activities, and flushes durable stores.

Direct window close uses its own guarded close path. Repeated close requests
share one promise. HMR and destroyed windows still run component cleanup; they
cannot depend on the application Quit sequence.

Event names and relay details are in [ipc.md](ipc.md). Ordering traps are in
[gotchas.md](gotchas.md).
