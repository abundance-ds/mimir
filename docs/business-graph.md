# Business graph

Issues, clients, people, projects, evidence, decisions, and deliverables live
in one source-aware graph. Work board, Changes, portfolio, timeline, and All
are projections over that graph. The interface is a **dispatch desk**: agents
file work; the human monitors, contributes, and corrects. No chat surface.

## GraphStore contract

Markdown is the durable source of truth. `GraphStore` is a rebuildable Rust
read model: normalized indexes over `knowledge/*.md` and `issues/*.md`,
revision-aware atomic writes, backlinks, diagnostics, and filesystem watchers
that emit `mimir://graph-changed`.

## Physical scopes

| Scope | Root | Intended use |
|---|---|---|
| Private | `~/.mimir/graph/private/` | local notes, drafts, sensitive records |
| Project | current workspace | engagement issues, decisions, evidence, deliverables |
| Team | Settings > Graph configured folder | shared companies, people, projects, methods, knowledge |

Each root contains flat `knowledge/*.md` and `issues/*.md` directories.
Scope ids filter queries, context packs, and projections; private nodes never
leak into team-only views. This is a storage boundary, not a permission
system. External collaborators share the project root without the team root.

The workbench mounts `private:local`, `project:<root-hash>`, and optional
`team:main`. Provenance carries `scopeId`, `scopeKind`, `sourcePath`,
`sourceRevision`, and legacy format.

## Bounded ontology

The ontology is intentionally business-specific:

| Family | Kinds |
|---|---|
| Business | `issue`, `person`, `company`, `project`, `note`, `decision`, `record` |
| HEOR | `study`, `evidence`, `dataset`, `analysis`, `model`, `endpoint`, `publication`, `submission`, `research-question`, `method`, `client-request` |

Legacy `org` sources normalize to `company`. Unknown frontmatter is preserved
through parse and serialization, but new public writes accept only known kinds.

Every node has a stable id, kind, title, summary, Markdown body, tags,
relations, properties, timestamps, and provenance. Issue properties include:

```text
status: backlog | plan | in-progress | waiting | review | done | cancelled
priority: low | normal | high | urgent
dueDate, remindAt, snoozeUntil, waitingFor, labels, deliverables, rank
```

Project and assignee are real `part_of` and `assigned_to` relations. The main
relation vocabulary also includes `works_at`, `for_company`, `has_contact`,
`blocked_by`, `depends_on`, `introduced_by`, `references`, and `related_to`.
Backlinks provide inverse navigation; writers do not need redundant inverse
edges.

`redactFromContext: true` writes the compatibility property `sensitive: true`.
Those nodes and all `record` nodes remain directly readable and searchable, but
their human content is redacted from automatic graph context packs.

## Built-in app

`src/mimir/apps/BusinessGraphApp.vue` — a Rust-helper App Activity. Graph
stays in the Activity pane; files open in the persistent Editor.

| Section | Projections |
|---|---|
| Work | Board, List, Attention |
| Projects | Portfolio, List, Timeline |
| Knowledge | List, Timeline |
| All | List, Timeline (kind filter) |
| Changes | History |

Work is the startup surface. Changes is a paginated (50-event pages)
time-ordered history of graph events with action, type, title, field changes,
actor, and project context. Waiting-on-you pins at top; seen cursor +
Mark caught up replaces unread counts.

**Summarise** launcher: select CLI agent, Since date, optional instructions.
Mimir fetches retained events from selected scopes, attaches a compact
human-readable ledger (time, actor, action, kind, title, field changes —
no raw ids). Prompt hard-capped at 80 KB. Starts a durable interactive
Activity. Routines can call `graph_events` directly but read only the
currently mounted workspace.

### Change history

Events: creates, updates, deletes, restores, due-date crossings, external
file changes. Paginated via `graph.events` with RFC 3339 `since` bound;
runtime retains 2,000 events at
`~/.mimir/graph/events/<project-hash>.json`. Local per installation — not
a distributed audit log.

### Interaction modes

- **Board**: two-line rows (priority control, title, metadata in mono). Drag reorder, keyboard movement, grouping, filter strip, settings-backed view state.
- **Portfolio**: tabular ledger (open/waiting/done/completion, health as marker + word). Project Focus: standing summary with blocked-on, decisions, deliverables.
- **Scan / Peek / Focus**: keyboard focus lands in projection on open. Peek: editable side surface beside the projection — title, status, priority, project, owner, due date, waiting-for, and the working note, all autosaving. Focus: full object workspace adding reminder, snooze, tags, deliverables, connections, connected work, and provenance.
- **Inspector**: edit-first and revision-aware; autosaves the draft and commits it before navigation; a rejected save keeps the surface open with its error and releases the next explicit exit. Bounded relation vocabulary via two-step connection composer. Delete to OS Trash with in-session undo.
- **Context trail**: preserves navigation path from projection through inspected nodes.

## Search

A persistent graph search field filters the active projection across indexed
titles, ids, tags, summaries, and body text. Input is debounced, ranked results
replace the projection in place, and the visible result count updates without
opening a separate search surface. Cmd/Ctrl+F focuses the field; Escape or the
clear control restores the projection immediately.

## Dispatch bar

Permanent bottom bar (`DispatchBar.vue`). Four modes:

- **Lookup**: live Spotlight-style results; Tab/click opens Peek.
- **Dispatch**: Enter queues a background CLI-agent Activity with user context; results land as filed events. Unresolvable refs flagged `needsDetail`.
- **Delegate**: `!` or `work <target>` shows assembled context pack, second Enter launches durable work Activity.
- **Power lane**: `/` prefix runs deterministic commands (`/board`, `/open <id>`, `/section`, `/find`, `/clear`, `/help`).

GUI mutations echo their `mimir call` equivalent in scrollback.

## AI-native workflow

`graph.context` builds a compact, agent-ready snapshot around an optional focus:

- breadth-first traversal through visible relationships;
- at most 40 nodes, 2,400 body characters per node, and 12,000 body characters
  across the pack;
- exact scope, source path, source revision, and graph revision;
- filtered relationships that cannot reveal a node outside selected scopes;
- default redaction for sensitive records.

Delegated work launches from the dispatch bar's `!`/`work <target>` flow (or
programmatically from app surfaces). The assembled graph snapshot is marked
as untrusted reference data and shown before launch. The Activity records its
focus node, kind, scope ids, and graph revision, so it appears later in that
node's inspector. Background dispatch Activities are durable but do not steal
focus. An agent can then open a deliverable in the Editor and leave durable
evidence, a decision, an issue update, or a next action instead of losing the
result in chat history.

## Tool surface

Public graph tools — registry and transport details in [mcp.md](mcp.md):

```bash
mimir call graph_find '{"query":"cost effectiveness evidence"}'
mimir call graph_get '{"id":"project-alpha"}'
mimir call graph_create '{"kind":"issue","title":"Extract evidence"}'
mimir call graph_update '{"id":"project-alpha","expectedRevision":"...","title":"Atlas"}'
mimir call graph_delete '{"id":"obsolete-note"}'
mimir call graph_restore '{"undoToken":"<token returned by graph_delete>"}'
mimir call graph_context '{"focusId":"project-alpha"}'
mimir call graph_events '{"scopeIds":["project:alpha"],"since":"2026-07-20T00:00:00Z","offset":0,"limit":50}'
```

Issues are `kind: "issue"` graph nodes. Internal compatibility and semantic
handlers are not public tool families.

## Migration and compatibility

Opening a graph dual-reads existing `<root>/knowledge/*.md` and
`<root>/issues/*.md` without first rewriting them. Internal compatibility
translation preserves legacy shapes. Unknown metadata and stable ids survive
read/write round trips.

`graph.migration_report` is a read-only inventory. It reports source and scope
counts, kinds and aliases, id collisions, diagnostics, and every legacy
project/assignee reference as exact-id, unique-title, ambiguous, or unresolved.
It sets `readyForCutover` only when the mounted data is unambiguous enough.

`graph.resolve_reference` performs an explicit, kind-checked project or
assignee repair. No fuzzy identity choice is written automatically. Existing
paths remain in place; any future physical reorganization is a separate
migration.

Mutation recovery is source-based:

- update conflicts include the expected and actual revision for reload;
- create/update uses same-directory atomic replacement;
- delete uses system Trash and returns an undo token;
- malformed files stay untouched and appear as diagnostics;
- the in-memory index can always be rebuilt from Markdown.

## Architecture and change map

Native ownership is under `src-tauri/src/business_graph/`:

| Module | Responsibility |
|---|---|
| `model.rs` | DTOs, ontology, scopes, revisions, diagnostics |
| `markdown.rs` | legacy normalization and loss-preserving serialization |
| `store.rs` | loading, indexes, queries, traversal, search, mutations |
| `runtime.rs` | mounted roots, watchers, change events, Trash/restore |
| `context.rs` | bounded source-aware agent context and redaction |
| `migration.rs` | read-only inventory and identity-resolution report |
| `performance.rs` | debug-build performance tests and regression budgets |
| `tools/` | native registry definitions, compatibility, semantic commands (mod.rs, support.rs, graph.rs, knowledge.rs, issues.rs, projects.rs, research.rs, tests.rs) |

Renderer ownership is split between `src/services/businessGraph.js`,
`src/stores/businessGraph.js`, the built-in app, and its components under
`src/mimir/apps/business-graph/` — including `WorkBoard.vue`, `NowView.vue`,
`DispatchBar.vue`, `PortfolioView.vue`, `ProjectStanding.vue`,
`EntityList.vue`, `TimelineView.vue`, `GraphInspector.vue`, and
`GraphFilterBanner.vue`. `WorkbenchApp.vue` mounts roots and owns the
work-Activity handoff (foreground delegate or background dispatch);
`AppActivity.vue` only routes the built-in surface.

When changing the graph contract, update Rust module tests, the golden sources
under `src-tauri/tests/fixtures/business-graph/`, tool/runtime tests, the
relevant Vue projection or inspector tests, and this document.

## Verification

Golden fixtures cover every supported ontology kind and the complete legacy
Issue field shape. Rust tests cover scope isolation, parsing and lossless
round trips, conflicts, migration without writes, semantic actions, context
redaction, and a realistic HEOR workflow. Frontend tests cover services,
store, shell, board, dispatch bar, inspector, projections, Activity handoff,
and `mimir`.

Debug-build regression budgets:

| Operation | Budget |
|---|---:|
| build 5,000-node index | 2,000 ms |
| bounded query | 100 ms |
| ranked search | 500 ms |
| one-hop traversal | 100 ms |
| load 600 Markdown sources | 3,000 ms |
| revision-aware board mutation | 250 ms |
| refresh 600 sources | 3,000 ms |

Run `cargo test --manifest-path src-tauri/Cargo.toml business_graph` after
native changes. Full release matrix in [testing.md](testing.md).
