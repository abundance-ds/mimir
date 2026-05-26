# AI Permissions

## Global Approval Mode (`aiApprovalMode` setting)

| Mode | Behavior |
|---|---|
| `strict` | Every AI tool call requires user approval |
| `normal` (default) | Per-tool `requiresApproval` flags + path-based access tiers |
| `bypass` | All tool calls and path access auto-approved — no prompts |

## Path Access Tiers (normal mode only)

| Tier | Condition | Action |
|---|---|---|
| Allow | Path within linked project folder | Proceed silently |
| Ask | Path outside project, not on blocklist | Show approval dialog (Allow Once / Allow Folder / Reject) |
| Reject | Path matches sensitive blocklist | Block immediately, return structured error |

## Sensitive Path Blocklist (hardcoded)

```
~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, /etc, /private/etc, /var/run,
~/Library/Keychains, ~/.kube, ~/.docker, ~/.npmrc, ~/.pypirc,
**/credentials*, **/.env, **/secrets*
```

## Gate Composition

```
Tool call arrives
  → bypass:  skip all gates, execute
  → strict: always show approval dialog (tool + path info)
  → normal:
      → withGate checks (D1-D4: arg validation, whitelist, tool approval, output size)
      → pathGate checks:
          → resolveSafePath (traversal prevention)
          → classifyPath → allow / ask / reject
```

## Denied-Access Error Format

```json
{
  "error": "Access denied: <path> is outside the project folder.",
  "detail": "<blocklist match or user rejected>",
  "suggestion": "Copy the file into the project folder, or ask the user to adjust permissions."
}
```

## Session-Scoped Path Approvals

When the user approves a folder via the Ask dialog, that folder and its descendants are auto-allowed for the rest of the session. Cleared on session end.

## Shell Command Execution (`shell`)

The `shell` tool allows the AI to execute arbitrary shell commands.

| Property | Value |
|---|---|
| Risk level | `high` |
| Requires approval | Always (in normal and strict modes) |
| Skipped in bypass | Yes |
| "Always allow" scope | Session (all subsequent commands auto-approved) |

### Execution environment

- Commands run via `/bin/bash -lc` (macOS/Linux) or `cmd.exe /C` (Windows)
- Working directory defaults to the linked project folder
- Timeout: 30s default, 120s max. Timed-out processes are killed.
- Sensitive environment variables are stripped (`TAURI_*`, `*API_KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CREDENTIAL*`)
- Output is truncated (stdout: 20K chars, stderr: 8K chars)

### What is NOT restricted

- There is no command blocklist. The user's approval is the sole gate.
- Piped commands, subshells, and redirects are allowed (they run through bash).
- Commands can access any path the user's account can access.

### Security model

The security model for shell execution is **user approval**, not sandboxing:
1. The approval card shows the exact command with auto-expanded arguments
2. The AI is instructed to explain commands before running them
3. In `strict` mode, every individual invocation requires approval
4. "Always allow" is session-scoped and resets when the session ends

## Per-Project Overrides

Projects can override the global approval mode and disable additional tools.

| Property | Stored on | Behavior |
|---|---|---|
| `project.approvalMode` | Project object (persisted) | `default` = use global, or `normal`/`strict`/`bypass` to override |
| `project.disabledTools` | Project object (persisted) | Array of tool names disabled at the project level (merged with global `disabledTools`) |

Resolution in `buildChatConfig` (`chat.js`):
- `resolveApprovalMode()` — project override wins unless `default`, then falls back to global `aiApprovalMode`
- `resolveDisabledTools()` — union of global + project disabled lists

UI: ProjectHome → Permissions section (segmented control for mode, collapsible tool access with per-project toggles, "Reset to global defaults" button).

## Session Approval Revocation

Active session-scoped approvals (tools and paths) are visible and revocable from ProjectHome → Permissions → Session approvals.

| Function | Module | What it does |
|---|---|---|
| `getSessionToolAllows()` | `gate.js` | Returns array of always-allowed tool names for the session |
| `revokeSessionToolAllow(name)` | `gate.js` | Removes a tool from the session allow list |
| `getSessionPathAllows(sessionId)` | `pathPermission.js` | Returns array of always-allowed directory paths |
| `revokeSessionPathAllow(sessionId, dir)` | `pathPermission.js` | Removes a directory from the session path allow list |

## Tool Registry

Tools self-register with UI metadata via `registerTool()` in `gate.js`. The registry is the single source of truth for both runtime gating and UI rendering.

```js
registerTool('shell', {
  category: 'shell',
  label: 'Run Command',
  description: 'Execute shell commands in the project directory',
  mutating: true,
  risk: 'high',
  requiresApproval: true,
})
```

`getToolCategories()` returns tools grouped by category with human-readable labels. Used by `ToolsSection.vue` (global settings) and `ProjectHome.vue` (per-project overrides).

## Not Yet Covered (Phase 2+)

- Rust-layer enforcement (defense in depth)
- Audit logging of path access decisions
- Workflow runtime path sandboxing

## Implementation Files

| File | Role |
|---|---|
| `src/services/ai/tools/pathPermission.js` | `classifyPath()`, sensitive blocklist, session allow list, `getSessionPathAllows()`, `revokeSessionPathAllow()` |
| `src/services/ai/tools/gate.js` | Tool registry with UI metadata, mode-aware gating, `getToolCategories()`, `getSessionToolAllows()`, `revokeSessionToolAllow()` |
| `src/panel/components/ToolCallBlock.vue` | Inline approval UI (pending state, descriptions from tool registry) |
| `src/panel/components/ProjectHome.vue` | Per-project permissions UI (approval mode, tool access, session approvals) |
| `src/shared/ui/settings/ToolsSection.vue` | Global tool permissions (derived from tool registry) |
| `src/stores/settings.js` | `aiApprovalMode` and `disabledTools` (global) |
| `src/stores/panel/chat.js` | `resolveApprovalMode()`, `resolveDisabledTools()` — per-project override resolution |
| `src/services/ai/tools/shell.js` | `shell` tool definition, invokes Rust backend |
| `src-tauri/src/shell_exec.rs` | Rust command execution via `std::process::Command` |
