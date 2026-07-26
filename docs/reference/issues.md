# Issues

Known issues and gaps. Every agent should check this file and add to it when they encounter problems outside their current task scope.

## Open

- Business graph automated behavior, accessibility, build, and performance
  verification is complete, but its final desktop screenshot critique across
  narrow/default/wide, railed/expanded, and reduced-motion states remains a
  manual runtime release check. The current coding session had no compatible
  in-app browser-control surface, so this evidence must not be inferred from
  happy-dom geometry.
- `src/test/setup.js` describes its Tauri command allowlist as an exact mirror
  of `src-tauri/src/lib.rs::generate_handler!`, but it still contains removed
  compatibility commands and omits current commands including
  `push_proposals` and `workspace_file_inspect`. Reconcile or generate the
  allowlist so frontend tests cannot conceal command-registration drift.
- Files/Workbench test fixtures still seed the old flat `workspaceFiles.files`
  projection and assert Recent/Browse-era controls. The Project tree now waits
  on `treeChildren['']`, so those fixtures remain in the loading state and
  cannot exercise the rewritten rows/actions. Update the fixtures and
  assertions around Project/Recent/Favorites, `FileTreeRow.vue`, and preview
  opens before treating the full frontend suite as authoritative.
