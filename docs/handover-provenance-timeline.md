# Handover: Provenance Timeline Visualization

## What This Is

A visual, interactive timeline that lets a user trace any AI-assisted change back through the chain of events that produced it. Click a file edit, see the AI turn that proposed it, the tools that ran, the sources that were loaded, and the human approval that authorized it.

This is the "killer feature" of the audit layer for CRO teams. Every other AI tool is a black box. The provenance timeline makes Dyad the only product that can answer: "Where did this sentence come from?"

## Why It Matters

A 20-person CRO doing HEOR work for pharma clients faces three recurring questions:

1. **Client audit**: "Show me the chain of evidence from data extraction to the final report."
2. **Regulatory inquiry**: "Was AI used? What model? Who approved each change?"
3. **Internal QA**: "This number looks wrong. What produced it?"

Today these questions require manual reconstruction from chat logs and memory. The provenance timeline makes it one click.

## What Already Exists

The audit layer (built 2026-05-18) provides the data foundation. See `docs/audit-system.md`.

### Data available now

Every event in `~/.shoulders-v3/audit.db` has:
- `id`, `timestamp`, `event_type`, `project_id`, `session_id`, `actor`
- `payload` (JSON) with event-specific fields
- `content_hash` (SHA-256 for tamper evidence)

### Events that form a provenance chain

A typical document edit has this chain, already captured:

```
ai.request       → AI turn starts (correlationId, model, provider)
tool.execute     → read (auto-approved, source file loaded)
tool.execute     → search (auto-approved, citations queried)
tool.execute     → edit (user-approved, target file + edit content)
ai.complete      → AI turn ends
export.run       → Document exported as DOCX
```

The `correlationId` in AI events ties request→complete. The `sessionId` ties everything within a chat turn. The `approvalDecision` field on tool events records human oversight.

### UI foundations already in place

- `ProjectHome.vue` has an Activity section with episode-grouped timeline (expandable)
- `groupIntoEpisodes()` in `audit.js` already clusters related events
- `relativeTime()` and `getTimeGroup()` handle display formatting
- The episode detail view shows individual events with type, actor, and timestamp

### What's missing

The current timeline is a flat list of episodes. The provenance view needs:
1. A connected graph showing causal chains, not just time proximity
2. Clickable nodes that reveal full context (prompt content, tool args, file diffs)
3. A way to start from a document and trace backward ("What produced this paragraph?")

## Design Direction

### Entry points

Two ways in:

1. **From ProjectHome Activity section** — click an episode, then "View provenance" to see the full chain. This is the compliance officer's path.
2. **From the Editor** — right-click a paragraph or selection, "Show provenance". This traces backward from content to the AI interaction that produced it. This is the analyst's path.

The Editor entry point is harder because it requires matching document content to `edit` tool call payloads (the `replacement` field). The matching logic in `textMatch.js` already does fuzzy text matching for proposals — it could be reused.

### Visualization

Not a complex node graph. A vertical chain — think git log, not a DAG:

```
┌─────────────────────────────────────────────┐
│ Mar 3, 14:22                                │
│                                             │
│ ● AI request                                │
│ │ claude-sonnet-4-6 · chat turn #4          │
│ │                                           │
│ ├── ◆ read                                  │
│ │   Chen2024-extraction.docx · auto         │
│ │                                           │
│ ├── ◆ search                                │
│ │   query: "cost-effectiveness QALY" · auto │
│ │                                           │
│ ├── ◆ edit                           ✓ user │
│ │   discussion.md · +47 words               │
│ │   [View diff]                             │
│ │                                           │
│ ● AI complete                               │
│   2.3s · 1,247 tokens                       │
└─────────────────────────────────────────────┘
```

Each node is clickable. Expanding a tool node shows the full args and result. Expanding an edit node shows the diff. The approval badge (auto / user-approved) is inline.

### Data requirements

The current audit payload captures enough metadata for the chain view. However, two gaps:

1. **Tool call arguments are not in audit events.** The `tool.execute` event payload has `toolName`, `category`, `risk`, `approvalDecision`, but not the tool's input args (e.g., the search query, the file path, the edit content). Adding `argsSummary` (a truncated/redacted version of args) to the `logAudit` call in `gate.js` would solve this. Full args are too large and may contain sensitive content — a summary (first 200 chars, or key fields only) is enough.

2. **Correlation between AI turns and tool calls.** Currently both share `sessionId` and are time-clustered, but there's no explicit `turnId` or `correlationId` linking them. The `ai.request` event has a `correlationId` from `ai_proxy.rs`, but tool calls don't carry it. Options:
   - Pass the `correlationId` through the tool context in `chatTransport.js` → `gate.js`. This is the clean solution.
   - Infer from time proximity (current episode grouping). Works but fragile.

### Where it lives in the UI

**Option A: Inline in ProjectHome.** Expand the existing episode timeline into a richer view. Pro: no new navigation. Con: ProjectHome is already long.

**Option B: Dedicated panel view.** A new full-panel view (like ProjectHome or WorkflowRun) accessed from the Activity section. Pro: more room for the chain visualization. Con: new navigation concept.

**Option C: Slide-out drawer.** Click an episode in ProjectHome, a drawer slides in from the right showing the chain. Pro: context preserved, no navigation. Con: limited width.

Recommendation: **Option B** — a dedicated `ProvenanceView.vue` opened from ProjectHome. The chain visualization needs vertical space and room for expandable detail. It follows the existing pattern of full-panel views (ProjectHome, WorkflowRun).

## Implementation Sketch

### New files

| File | Purpose |
|---|---|
| `src/panel/components/ProvenanceView.vue` | Full-panel chain visualization |
| `src/services/audit.js` (extend) | `buildProvenanceChain(events)` — groups events by correlationId/turn |

### Modified files

| File | Change |
|---|---|
| `src/services/ai/tools/gate.js` | Add `argsSummary` to logAudit payload (truncated key fields from args) |
| `src/services/ai/chatTransport.js` | Pass `correlationId` into tool context |
| `src/panel/components/ProjectHome.vue` | Add "View chain" button on episode rows → opens ProvenanceView |
| `src/stores/panel/ui.js` | Add `provenanceSessionId` state for navigation |

### Data enrichment (prerequisite)

Before building the UI, enrich the existing instrumentation:

1. **In `gate.js`**: Add `argsSummary` to the `logAudit('tool.execute', ...)` call. Extract key fields per tool:
   - `edit` → `{ path, wordCount: replacement.split(' ').length }`
   - `read` → `{ path }`
   - `search` → `{ query }`
   - `shell` → `{ command: cmd.slice(0, 100) }`
   - Default → `{ argKeys: Object.keys(args).join(', ') }`

2. **In `chatTransport.js`**: Thread the `correlationId` from the AI SDK transport into the tool execution context, so `gate.js` can include it in audit events.

### Chain-building logic

```
buildProvenanceChain(events, correlationId?):
  1. Find the ai.request event (by correlationId or latest in session)
  2. Find all tool.execute events within 60s with same sessionId
  3. Find the ai.complete/ai.abort/ai.error event
  4. Order: request → tools (by timestamp) → complete
  5. Return structured chain with expandable metadata
```

### Editor reverse-lookup (future)

The "right-click paragraph → show provenance" flow:

1. Extract text at cursor position (paragraph or selection)
2. Search audit events for `tool.execute` where `toolName === 'edit'`
3. Match payload against document text using `textMatch.js`
4. If found, open ProvenanceView for that event's session/turn

This is the hardest part and could ship as a follow-up phase.

## Phasing

**Phase 1: Data enrichment.** Add `argsSummary` to tool audit events. Thread `correlationId` into tool context. No UI changes. ~1 hour.

**Phase 2: Chain visualization.** Build `ProvenanceView.vue` with the vertical chain layout. Accessible from ProjectHome episode rows. ~3-4 hours.

**Phase 3: Editor reverse-lookup.** Right-click context menu entry in EditorContextMenu, backward search through audit events. ~2-3 hours.

## Design References

- The episode timeline in ProjectHome (existing) — extend, don't replace
- Git log graph (conceptual model — linear chain, not DAG)
- Linear's activity feed (compact, scannable, expandable)
- The `.ph-episode` CSS patterns already in ProjectHome — reuse for consistency
