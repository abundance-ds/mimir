# Issues

Known defects and gaps. Check before editing; add problems found outside your
task scope.

## Open

- Scribe is not ready. The signed installed `rs.shoulde.mimir` application has
  passed first-run TCC registration, known-playback microphone/system signal,
  dual-channel local live transcription, Stop, and fast historical-library
  reads on the reference Mac. A real endpoint-bound Keychain credential has
  completed OpenAI transcription-session creation, but live audio-to-durable
  transcript and interrupted-recording recovery still require signed
  end-to-end records. Automated contracts are necessary evidence, not a
  substitute for those provider/recovery paths.

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
