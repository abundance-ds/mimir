# Audit & Compliance System

Audience: coding agents. Purpose: understand, locate, and extend the audit/compliance layer.

## What It Is

An append-only event log that records every significant action in the app: AI requests, tool executions (with approval decisions), session/project lifecycle, and document exports. The log lives in a separate SQLite database (`~/.mim/audit.db`) with per-row SHA-256 content hashes for tamper evidence.

The system serves two audiences:
- **Compliance officers** see a per-project activity timeline, compliance indicators, and can export a one-click DOCX compliance report.
- **Future observability** will use the same event stream with different queries and views (token efficiency, tool chain analysis).

## Architecture

```
Instrumentation points          Service layer              Storage
─────────────────────           ─────────────              ───────
gate.js (tool approval) ──┐
ai_proxy.rs (AI req/res) ──┼──▸ audit.js (logAudit) ──▸ audit.rs (SQLite)
actions.js (session/proj) ──┤     or                      ~/.mim/audit.db
SidebarExport.vue (export) ─┘   audit_log_internal()
```

## Event Types

| Event Type | Actor | Logged At | Key Payload Fields |
|---|---|---|---|
| `ai.request` | `ai:{model_id}` | `ai_proxy.rs` (spawn start) | correlationId, feature, provider, modelId, route |
| `ai.complete` | `ai:{model_id}` | `ai_proxy.rs` (done event) | correlationId, feature, aborted |
| `ai.abort` | `ai:{model_id}` | `ai_proxy.rs` (done event, aborted=true) | correlationId |
| `ai.error` | `ai:{model_id}` | `ai_proxy.rs` (non-2xx response) | correlationId, status |
| `tool.execute` | `user` | `gate.js` (withGate success/error/denied) | toolName, category, risk, mutating, approvalDecision, durationMs, success |
| `session.create` | `user` | `actions.js` | sessionId, projectId, modelId |
| `session.archive` | `user` | `actions.js` | sessionId, projectId |
| `session.delete` | `user` | `actions.js` | sessionId, projectId |
| `project.create` | `user` | `actions.js` | projectId, name, workspacePath |
| `project.remove` | `user` | `actions.js` | projectId, name |
| `export.run` | `user` | `SidebarExport.vue` | format, template, fileName |

## Database Schema

One table in `~/.mim/audit.db`:

```sql
audit_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL,          -- RFC 3339
    event_type    TEXT NOT NULL,          -- dotted: ai.request, tool.execute, etc.
    project_id    TEXT,                   -- nullable (some events are global)
    session_id    TEXT,                   -- correlation key
    actor         TEXT,                   -- "user" or "ai:{model_id}"
    payload       TEXT DEFAULT '{}',      -- JSON, flexible per event type
    content_hash  TEXT                    -- SHA-256(timestamp + event_type + payload)
)
```

Indexes: `timestamp`, `event_type`, `project_id`.

## Rust Backend (`src-tauri/src/audit.rs`)

Follows the `usage.rs` pattern exactly: `AuditDbState` with `Mutex<Option<Connection>>`, lazy `ensure_audit_connection`, WAL mode.

### Tauri Commands

| Command | Purpose |
|---|---|
| `audit_log` | Universal write entry point. Computes timestamp + content_hash internally. |
| `audit_query` | Filtered reads (project, event types, date range, limit). Returns newest-first. Default limit 200. |
| `audit_query_summary` | Aggregate counts by event_type for dashboard hero. |
| `audit_export_csv` | CSV dump of events, ordered by timestamp ASC. |

### Internal Function

`audit_log_internal()` is a non-command function for Rust-side instrumentation (used by `ai_proxy.rs`). Same logic as the Tauri command but takes `&AuditDbState` directly.

## JS Service (`src/services/audit.js`)

| Export | Purpose |
|---|---|
| `logAudit(eventType, details)` | Fire-and-forget wrapper around `invoke('audit_log')`. No-op in browser mode. |
| `queryAudit(options)` | Wrapper for `audit_query`. Returns `[]` on failure. |
| `queryAuditSummary(options)` | Wrapper for `audit_query_summary`. |
| `exportAuditCsv(options)` | Wrapper for `audit_export_csv`. |
| `groupIntoEpisodes(events)` | Groups flat events into display episodes (AI-related events within 60s in same session are grouped). |
| `relativeTime(isoString)` | Human-readable relative time ("2m ago", "yesterday"). |
| `getTimeGroup(isoString)` | Buckets into "Today", "Yesterday", "This Week", "Earlier". |

## UI

### Project Home Activity Section (`ProjectHome.vue`)

Added between Stats and Danger Zone. Shows:
- **Compliance indicators**: two pills — "X% reviewed" (green/amber based on approval rate) and "N models" (green if 1, amber if >1).
- **Episode timeline**: events grouped into human-readable episodes with expandable detail. Time-grouped ("Today", "Yesterday", etc.).
- **Export Compliance Report** button: generates a DOCX via `generateComplianceReport()`.

### Settings Audit Section (`AuditSection.vue`)

Global cross-project view in Settings dialog. Shows:
- **Hero**: event count for selected period (This Week / This Month / All Time) with type breakdown.
- **Filters**: project dropdown + event type dropdown.
- **Event stream**: scrollable list of grouped episodes.
- **Identity**: analyst name input (persisted as `auditIdentity` in settings store).
- **Export**: CSV download via Tauri save dialog.

### Compliance Report (`complianceReport.js`)

One-click DOCX generator using the `docx` npm package (lazy-loaded). Sections: Cover, Summary table, AI Models, Activity Timeline (up to 200 episodes), Attestation. Uses `auditIdentity` setting for the analyst name.

## Instrumentation Guide

When adding new tool types or AI features, add a `logAudit()` call at the execution point:

```javascript
import { logAudit } from '../../services/audit.js'

logAudit('new_domain.action', {
  sessionId: context.sessionId,
  projectId: project.id,
  relevantField: value,
})
```

For Rust-side events, use `audit_log_internal()`:

```rust
let audit_state = app.state::<crate::audit::AuditDbState>();
let _ = crate::audit::audit_log_internal(
    &audit_state,
    "new_domain.action",
    None,
    None,
    Some("user".to_string()),
    Some(serde_json::json!({ "key": "value" }).to_string()),
);
```

Event type naming: `domain.action` (e.g., `tool.execute`, `ai.request`). The JSON payload is freeform.

## Tests

- `src/services/audit.test.js` — 17 tests covering `groupIntoEpisodes`, `relativeTime`, `getTimeGroup`.
- `src/test/smoke.test.js` — AuditSection mount smoke test.
