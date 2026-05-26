# Board System (Kanban + Knowledge Base)

Audience: coding agents. Purpose: understand, locate, and extend the project board.

## What It Is

A per-project hub with five tabs: **Chat**, **Board** (kanban), **Knowledge** (agent-maintained entries), **History** (session timeline), and **Settings**. The hub replaces the chat view when a user navigates to a project home. Board entries are markdown files with YAML frontmatter, stored on disk and accessible to AI via `@issues/` and `@knowledge/` path routing on generic file tools.

Two entity types:

- **Issue** — kanban task with status, priority, deliverables, links. Strict validation; moves through five columns.
- **Knowledge** — agent-maintained knowledge base entry. Fault-tolerant normalization; no status field.

## Architecture

```
UI layer                              State                Service layer         Storage
────────                              ─────                ─────────────         ───────
ProjectBoard.vue (5-tab hub)    ┐
  BoardHeader.vue (pill nav)    │
  KanbanView.vue + Column/Card │
  KnowledgeView.vue + Card     ├──▸ board.js store ──▸ loader.js (I/O) ──▸ ~/.shoulders-v3/
  HistoryView.vue              │    (Pinia)              board.js (AI)      projects/{id}/issues/
  EntryDetail.vue (full-page)  ┘                                            or knowledge/
                                                                            {entryId}.md
```

Board context is injected into AI system prompts via `buildBoardContext()` in the store, picked up by `chat.js` and appended in `systemPrompt.js`.

## File Map

### Components (`src/panel/components/board/`)

| File | Purpose |
|---|---|
| `ProjectBoard.vue` | 5-tab hub. Shows `EntryDetail` full-page when entry selected, otherwise pill nav + tabbed content. |
| `BoardHeader.vue` | Centered segmented-control pill: Chat / Board / Knowledge / History / Settings. 150ms transitions. |
| `KanbanView.vue` | 5 columns with drag ghost, search bar, "+ Add issue" per column. Collapsible columns. |
| `KanbanColumn.vue` | Single column: status dot, label, count badge, hide action, drop-line indicators. `data-kanban-column` for drag hit-testing. |
| `PriorityIcon.vue` | Custom SVG priority indicator: 3 graduated bars (low/normal/high) with ghost bars for unfilled levels; urgent = accent-colored rounded square with exclamation mark. |
| `KanbanCard.vue` | Card: title, PriorityIcon, due date (with urgency coloring: overdue/today=accent, this week=ink-2), deliverable count. Ghost mode for drag overlay. |
| `KnowledgeView.vue` | Search-only discovery, responsive card grid (`auto-fill, minmax(220px, 1fr)`). |
| `KnowledgeCard.vue` | Title, body excerpt, timestamp. Click opens detail. |
| `EntryDetail.vue` | Full-page Linear-style detail. Section order: Back > Title > Property pills > Body > Sessions > Sources > Deliverables > Delete. Rendered markdown body (`marked`, click-to-edit). Compact horizontal property pills (status/priority/due) for issues. Sources section (file picker, reveal in Finder). Deliverables (read-only). Linked sessions + "Start session" button. Tags editing removed from detail view (tags remain in data model, managed by AI). |
| `HistoryView.vue` | Session timeline: active + archived with "show more" collapse, search, restore action. |

### Composable

| File | Purpose |
|---|---|
| `src/panel/composables/useKanbanDrag.js` | Pointer-event drag with 5px dead zone, `data-kanban-column` / `data-kanban-card` hit-testing, ghost position tracking, Escape to cancel. |

### Store (`src/stores/panel/board.js`)

Pinia store `panelBoard`. Key state and computed:

| Export | Kind | Description |
|---|---|---|
| `entries` | ref | All loaded entries for active project |
| `viewMode` | ref | Active tab: `chat`, `board`, `knowledge`, `history`, `settings` |
| `selectedEntryId` | ref | Entry shown in full-page detail |
| `issueSearch` | ref | Text filter for kanban cards (title + body) |
| `hiddenStatuses` | ref | Set of collapsed kanban column statuses (persisted on project as `hiddenColumns`) |
| `issues` / `knowledge` | computed | Entries filtered by type |
| `columns` | computed | Kanban columns: status, label, sorted entries (priority-weighted, search-filtered) |
| `filteredKnowledge` | computed | Knowledge entries filtered by tag + search, sorted by updated date |
| `allTags` | computed | Union of all entry tags |
| `boardSummary` | computed | Counts by status for AI context |
| `buildBoardContext()` | method | Renders `<board-context>` block for system prompt injection |
| `loadBoard(projectId)` | action | Discovers and loads all entries from disk |
| `createEntry` / `updateEntry` / `removeEntry` / `moveIssue` | actions | CRUD with optimistic status update on move |

### Service layer (`src/services/board/loader.js`)

Markdown + YAML frontmatter I/O via Tauri invokes.

| Export | Description |
|---|---|
| `COLUMN_STATUSES` | `['backlog', 'plan', 'in-progress', 'review', 'done']` |
| `PRIORITIES` | `['low', 'normal', 'high', 'urgent']` |
| `parseBoardEntry(raw)` | Splits frontmatter from body; falls back to heading extraction for bare markdown |
| `serializeEntry(meta, body)` | Produces `---\nyaml\n---\n\nbody` |
| `validateIssueMeta(meta)` | Strict: requires title, normalizes status/priority/dueDate, ensures arrays for tags/links/deliverables |
| `normalizeKnowledgeMeta(meta)` | Fault-tolerant: fills defaults, always sets `type: 'knowledge'` |
| `generateEntryId(type)` | `{type}-{unix_seconds}-{rand4}` |
| `discoverEntries(projectId)` | Lists `issues/` and `knowledge/` dirs, parses each `.md`, returns sorted array |
| `readEntry` / `writeEntry` / `deleteEntry(projectId, entryId, type)` / `moveEntry` | File-level CRUD via Tauri `read_text_file` / `write_text_file` / `delete_path`. `deleteEntry` takes a `type` parameter to resolve the correct directory. |

### AI tools (`src/services/ai/tools/pathHandlers.js`)

Board entries are managed via standard file tools with `@issues/` and `@knowledge/` path routing:

| Operation | Tool call | Mutating |
|---|---|---|
| Create issue | `create("@issues/my-issue.md", content)` | yes |
| Create knowledge | `create("@knowledge/my-entry.md", content)` | yes |
| Edit entry | `edit("@issues/my-issue.md", ...)` or `edit("@knowledge/my-entry.md", ...)` | yes |
| Read entry | `read("@issues/my-issue.md")` or `read("@knowledge/my-entry.md")` | no |
| List issues | `list("@issues/")` | no |
| List knowledge | `list("@knowledge/")` | no |
| Render in chat | `show("@issues/ISSUE-1")` or `show("@knowledge/ENTRY-1")` | no |

The `@issues/` and `@knowledge/` path handlers validate YAML frontmatter (enforces `status` and `priority` enums for issues), set `origin.session` for provenance, bypass the proposal bridge, and reload the board store after writes.

## Data Model

Storage paths:
- Issues: `~/.shoulders-v3/projects/{projectId}/issues/{entryId}.md`
- Knowledge: `~/.shoulders-v3/projects/{projectId}/knowledge/{entryId}.md`

Each file is markdown with YAML frontmatter:

```yaml
---
type: issue          # or "knowledge"
title: "Fix the thing"
status: in-progress  # issues only: backlog | plan | in-progress | review | done
priority: high       # issues only: low | normal | high | urgent
dueDate: "2025-06-15" # issues only, optional, YYYY-MM-DD
tags: [bug, v2]
sources:             # input file references, settable by AI via @issues/@knowledge/ file tools or manually via file picker
  - path: /abs/path/to/input.md
    label: optional label
deliverables:        # issues only
  - path: src/foo.js
    label: main fix
links: []            # issues only
origin:
  session: "abc123"  # session that created/last touched this entry
created: "2025-01-01T00:00:00.000Z"
updated: "2025-01-02T00:00:00.000Z"
---

Free-form markdown body here.
```

Knowledge entries omit `status`, `priority`, `deliverables`, and `links`. Bare markdown files without frontmatter are auto-classified as knowledge entries (title extracted from first heading).

`entry.meta.sources: [{ path, label? }]` — input file references, settable by AI via `@issues/` or `@knowledge/` file tools or manually via file picker in EntryDetail.

Date format across board components: `en-GB` locale, "21 May 2026" style (`{ day: 'numeric', month: 'short', year: 'numeric' }`).

## Key Behaviors

**Drag and drop** — `useKanbanDrag` composable uses raw pointer events (no drag API). A 5px dead zone prevents accidental drags. During drag, a ghost card follows the cursor and drop-line indicators appear between cards. The store's `moveIssue` does an optimistic status update then persists via `loader.moveEntry`.

**AI context injection** — When a project has board entries, `buildBoardContext()` generates a `<board-context>` block summarizing issue counts, overdue issues (with due dates), active issues with priority and due dates (up to 10), knowledge entry titles (up to 5), and available tags. This is appended to the system prompt in `systemPrompt.js`.

**Composer integration** — Board entries appear in the composer's `@` autocomplete and `+` attachment menu. Attaching an entry adds a `board-entry` chip. When a message references board entries, the session records them in `session.linkedEntries` for provenance tracking.

**Navigation** — `panelUI` store tracks browser-style back/forward history. Session entries are `{ type: 'session', id }`. Project entries are `{ type: 'project', id, viewMode, entryId }` — tab switches and entry detail views each push a history entry, so back/forward walks through the full navigation path (session → project chat tab → board tab → entry detail → …). `BoardHeader` pushes history on tab switch. `board.selectEntry()` pushes history on entry open. Entry detail is a full-page overlay that replaces the hub (no modal). Dead entries (archived sessions, removed projects) are skipped during navigation.

**Column visibility** — Kanban columns can be soft-hidden via `toggleColumnHidden`. Hidden columns collapse to a vertical pill showing status dot, count, and label. Collapsed columns accept drag-and-drop (cards can be moved to a hidden column). Visibility state is persisted on the project object as `hiddenColumns` array.

**Editor integration** — Board files opened in the editor get their YAML frontmatter parsed and stripped; CodeMirror shows only the markdown body. An `IssueContextBar` (`src/editor/components/IssueContextBar.vue`) renders above the editor with inline-editable title, status dropdown, priority dropdown, and a "Send to Agent" button. Metadata changes go through `fileStore.updateMeta()`, which marks the file dirty. On save, `serializeEntry(meta, body)` reconstructs the full YAML+markdown file and emits `shoulders://board-changed` for kanban refresh. "Send to Agent" uses the shared `useSubmitReview` composable (`src/editor/composables/useSubmitReview.js`) to bundle comments + document content to the Panel chat via the `comments_submit` bridge.
