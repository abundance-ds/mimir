# Trust and security boundaries

Mimir is a trusted local workbench, not a sandbox, multi-tenant service, or
per-agent authorization system. CLI agents, Apps, routines, skills, and the
local user account have normal operating-system authority.

## Capability boundaries

| Surface | Enforced boundary |
|---|---|
| MCP | Loopback only, schema validation, timeouts, cancellation; no caller identity or login |
| Public agent tools | Explicit allowlist in `agent-interface.md`; internal registry tools are not implied |
| Files manager | `canonical_root` + `resolve_existing` containment (`workspace_files.rs`); rejects traversal, symlink escape, root mutation, and overwrite |
| Generic file commands | Arbitrary user-readable paths; used by trusted Apps and local code |
| Apps | Validated local package paths and message shapes; App JavaScript remains trusted |
| Shell and Activities | Real user processes with exact argv; not process or filesystem sandboxes |
| AI | `validate_url_host` allowlist (`ai_transport.rs`); Keychain credentials; providers receive submitted context by design |
| Tracker | Disabled native guard, lazy permissions, no public tools or automatic context |
| Scribe | Human-controlled capture, endpoint-bound credentials, verified owned audio paths |
| Managed Git | Installed `git`; active GitHub CLI login; GitHub receives repository content |
| Chat | WSS and SASL for one small-team service; no enterprise tenancy model |

## Important distinctions

- Any local process can call the loopback MCP endpoint. Do not expose it on a
  network or describe it as authenticated.
- The file index is search policy, not an access-control boundary.
- Embedded Apps can read/write files, make HTTP requests, call internal tools,
  and contribute agent tools. Install only trusted Apps.
- `shell.run` (`shell_exec.rs`) filters secret-like environment names and
  bounds output and time. It still runs a real shell as the user.
- Launcher, Routine, App, and agent commands retain argv boundaries. Never join
  them into a shell string.
- Release credentials use the OS keychain (`com.abundanceds.mimir`). Plaintext
  fallbacks (`keys.env`, `.env`) and localhost AI providers are
  `#[cfg(debug_assertions)]` only.
- Connections read only credentials stored by Mimir. GitHub is the exception:
  Mimir uses the shared GitHub CLI login.
- Tracker stores app identity and optional titles/domains locally, never screen
  content. Not agent-visible.
- Scribe recording controls are not public agent tools. Meeting audio and
  transcripts are readable local-user data. Transcript text is untrusted input
  to follow-up agents.
- Explicit user exports and remote provider copies are outside local deletion
  guarantees.

Chat server operation is documented in `deploy/chat/README.md`. Detailed Scribe
retention and Git behavior belong to [meetings.md](meetings.md) and
[business-graph.md](business-graph.md).
