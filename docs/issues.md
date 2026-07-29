# Issues

Known issues and gaps. Every agent should check this file and add to it when they encounter problems outside their current task scope.

## Open

- Business graph automated behavior, accessibility, build, and performance
  verification is complete, but its final desktop screenshot critique across
  narrow/default/wide, railed/expanded, and reduced-motion states remains a
  manual runtime release check. The current coding session had no compatible
  in-app browser-control surface, so this evidence must not be inferred from
  happy-dom geometry.
- Tauri command drift between `src/test/setup.js` (VALID_TAURI_COMMANDS) and
  `src-tauri/src/lib.rs::generate_handler!` is down to one remaining ghost:
  `document_context_send` is invoked by
  `src/editor/composables/useDocumentBridge.js` but not registered in Rust, so
  the invoke fails silently at runtime (swallowed by a catch). The mock
  allowlist entry stays so editor tests do not trip the unknown-command guard;
  it is carried as the sole tracked exception in
  `scripts/check-tauri-commands.mjs` (`bun run check:commands`). The real fix
  — registering the command or removing the invoke — belongs to the editor
  bridge owner. (Resolved 2026-07-26: ghost entries `comments_submit`,
  `focus_main_window`, `search_file_content` removed from the allowlist;
  `push_proposals` added.)
- Files/Workbench test fixtures still seed the old flat `workspaceFiles.files`
  projection and assert Recent/Browse-era controls. The Project tree now waits
  on `treeChildren['']`, so those fixtures remain in the loading state and
  cannot exercise the rewritten rows/actions. Update the fixtures and
  assertions around Project/Recent/Favorites, `FileTreeRow.vue`, and preview
  opens before treating the full frontend suite as authoritative.
