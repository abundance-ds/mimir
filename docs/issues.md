# Issues

Known defects and gaps. Check before editing; add problems found outside your
task scope.

## Open

- Local Apps have no management surface. The empty `Settings > Apps` section
  was removed because it exposed no installed local definitions and duplicated
  built-in product navigation. The native app commands, catalog store/service,
  launch pipeline, and SDK remain. Revive the manager only for real definitions
  under `~/.mimir/apps`: add one direct Settings destination, show local apps
  and diagnostics only, reconnect definition editing and app launch to the
  Editor and Workbench, and restore focused UI tests. Do not put Today, Scribe,
  Business graph, or Tracker in that manager.

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

- Terminal command-aware `working` status is a future specification candidate.
  The current truthful live-shell state is `idle`; any later implementation
  needs the explicit shell command-boundary contract in
  [activities.md](activities.md#plain-terminal-status).

- Editor comment navigation is available only while the formatting toolbar is
  enabled. Add reusable keyboard or menu commands before treating comment
  navigation as independent of toolbar visibility.
