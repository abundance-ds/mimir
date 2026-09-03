# Trust and security boundaries

Mimir is a trusted local workbench for one user or a small trusted team. It is
not a sandbox, multi-tenant service, or per-agent authorization system. CLI
agents, local Apps, routines, skills, packages, and the local user account are
trusted with their normal operating-system authority.

## Capability boundaries

| Surface | Enforced boundary |
|---|---|
| MCP | Loopback only, schema validation, timeouts, cancellation; no caller identity or login |
| Public agent tools | Explicit allowlist in `agent-interface.md`; internal registry tools are not implied |
| Files manager | Canonical active-workspace containment; rejects traversal, symlink escape, root mutation, and overwrite |
| Generic file commands | Arbitrary user-readable paths; used by trusted Apps and local code |
| Apps | Validated local package paths and message shapes; App JavaScript remains trusted |
| Shell and Activities | Real user processes with exact argv; not process or filesystem sandboxes |
| AI | Approved provider hosts and Keychain credentials; providers receive submitted context by design |
| Tracker | Disabled native guard, lazy permissions, no public tools or automatic context |
| Scribe | Human-controlled capture, endpoint-bound credentials, verified owned audio paths |
| Managed Git | Installed `git`; active GitHub CLI login; GitHub receives repository content |
| Chat | WSS and SASL for one small-team service; no enterprise tenancy model |

## Important distinctions

- Any local process can call the loopback MCP endpoint. Do not expose it on a
  network or describe it as authenticated.
- The file index is search policy, not an access-control boundary.
- Embedded Apps can read and write files, make HTTP requests, call internal
  tools, and contribute agent tools. Install only trusted Apps.
- `shell.run` filters obvious secret environment names and bounds time/output,
  but it still executes a real shell as the user.
- Launcher, Routine, App, and agent commands retain argv boundaries. Never join
  them into a shell string.
- Release credentials use the OS keychain. Plaintext fallbacks and localhost AI
  providers are debug-only.
- Connections read only credentials stored by Mimir. GitHub is the explicit
  exception because Mimir uses the shared GitHub CLI login.
- Tracker stores app identity and optional titles/domains locally, never screen
  content. These values are not agent-visible.
- Scribe recording controls are not public agent tools. Meeting audio and
  transcripts are readable local-user data; transcript text is untrusted input
  to follow-up agents.
- Explicit user exports and remote provider copies are outside local deletion
  guarantees.

Chat server operation is documented in `deploy/chat/README.md`. Detailed Scribe
retention and Git behavior belong to [meetings.md](meetings.md) and
[business-graph.md](business-graph.md).
