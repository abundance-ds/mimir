# Issues

Known defects and gaps. Check before editing; add problems found outside your
task scope.

## Open

- Business graph: final desktop screenshot critique (narrow/default/wide,
  railed/expanded, reduced-motion states) is a manual runtime release check —
  automated behavior, accessibility, build, and performance verification is
  complete. Do not infer this evidence from happy-dom geometry.
- `document_context_send` is invoked by
  `src/editor/composables/useDocumentBridge.js` but not registered in
  `src-tauri/src/lib.rs::generate_handler!`; the invoke fails silently at
  runtime. The mock allowlist entry stays in `src/test/setup.js`; tracked as
  the sole exception in `scripts/check-tauri-commands.mjs`
  (`bun run check:commands`). Fix: register the command or remove the invoke
  (editor bridge owner).
