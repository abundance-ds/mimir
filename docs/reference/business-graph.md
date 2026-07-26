# Business graph

The Business graph is Mim's built-in operating system for a small AI-native
HEOR consultancy. Issues, clients, people, projects, evidence, decisions, and
deliverables are one source-aware graph. The Issue Board, CRM, portfolio,
timeline, directories, and relationship maps are polished projections over
that graph rather than separate applications or databases.

## Why GraphStore exists

Markdown remains the durable, reviewable source of truth. `GraphStore` is a
rebuildable Rust read model that makes those files behave like an application:

- one normalized model spans legacy Knowledge and Issue files;
- indexes make kind, scope, tag, status, priority, search, and adjacency queries
  fast without reparsing every file for every projection;
- incoming and outgoing relations support backlinks and traversal;
- source paths and revisions remain attached to every result;
- revision-aware atomic writes prevent a stale inspector or agent from silently
  overwriting an external edit;
- diagnostics expose malformed sources, duplicate ids, dangling links, and
  migration ambiguity;
- filesystem watchers rebuild the disposable index and emit
  `mim://graph-changed`.

This gives Mim graph-database interaction speed without introducing another
canonical store, synchronization protocol, or opaque export format.

## Physical scopes

Scope is deliberately simple and concrete for a five-to-ten-person team:

| Scope | Root | Intended use |
|---|---|---|
| Private | `~/.mim/graph/private/` | local notes, reminders, annotations, drafts, sensitive records |
| Project | current workspace | engagement issues, decisions, evidence, analyses, and deliverables |
| Team | Settings > Graph configured folder | shared companies, people, projects, methods, and reusable knowledge |

Each root contains flat `knowledge/*.md` and `issues/*.md` source directories.
Private data is not copied into a project or team root. A private relationship
to a shared node is stored in the private source. Queries, search, neighbors,
counts, context packs, and UI projections accept physical scope ids, so a
team-only projection cannot include a private node.

This is a storage boundary, not an enterprise permission system. Sharing a
project or team root uses the repository, synced folder, or filesystem access
the team already trusts. Mim binds its agent capability endpoint to loopback
and does not add roles or policy administration.

The workbench mounts `private:local`, the current `project:<root-hash>`, and
optional `team:main` roots. Node provenance carries the exact `scopeId`,
`scopeKind`, `sourcePath`, `sourceRevision`, and legacy source format.

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

`record` nodes and nodes with `sensitive: true` remain queryable in explicitly
selected scopes, but their human content is redacted from default agent context
packs.

## Built-in app

Business graph is a stable built-in Rust-helper App Activity implemented by
`src/mim/apps/BusinessGraphApp.vue`. It keeps the graph context open in the
Activity pane while files and deliverables open in the persistent Editor.

Its primary sections and projections are:

| Section | Projections |
|---|---|
| Work | Board, grouped List, Attention |
| Projects | Portfolio, List, Timeline, Graph |
| People | Directory, Relationships |
| Companies | CRM, Directory, Relationships |
| Knowledge | List, Timeline, Graph |
| All | List, Graph, Timeline |

The Work Board retains specialized issue interaction: status or project
grouping, drag-and-drop movement, keyboard-equivalent movement, column
visibility, priority and status filtering, sorting, due-soon and overdue
states, and settings-backed view state. It is a projection over `issue` nodes,
not an independent Issue database.

The inspector uses expected source revisions, reports conflicts instead of
overwriting, and supports deliberate Markdown read/edit mode. It exposes
project, assignee, reminders, waiting, snooze, labels, deliverables, related
entities, and graph-associated Activities. Delete moves the source to the
operating-system Trash and offers an in-session undo.

The context trail preserves the path from the originating projection through
inspected issues, projects, people, companies, decisions, and evidence.
Graph nodes are keyboard-focusable, and graph pan/zoom has explicit controls.

## AI-native workflow

`graph.context` builds a compact, agent-ready snapshot around an optional focus:

- breadth-first traversal through visible relationships;
- at most 40 nodes, 2,400 body characters per node, and 12,000 body characters
  across the pack;
- exact scope, source path, source revision, and graph revision;
- filtered relationships that cannot reveal a node outside selected scopes;
- default redaction for sensitive records.

The app's **Start Work** action selects the first available agent launcher,
creates a durable Activity, and supplies the bounded graph snapshot as
untrusted reference data. The Activity records its focus node, kind, scope ids,
and graph revision, so it appears later in that node's inspector. An agent can
then open a deliverable in the Editor and leave durable evidence, a decision,
an issue update, or a next action instead of losing the result in chat history.

HEOR-specific semantic actions include `research.capture_evidence`,
`projects.record_decision`, `issues.add_deliverable`, and
`issues.create_next_action`.

## Tool surface

The native graph tools are registered directly in the canonical registry and
remain available while the visual app is closed.

| Domain | Important operations |
|---|---|
| `graph.*` | status, list/query/get/search/neighbors, diagnostics, context, dry-run migration report, reference resolution, create/update/delete/restore |
| `knowledge.*` | legacy-compatible list/catalog/get/search/neighbors/graph and create/update/delete |
| `issues.*` | legacy-compatible list/get/create/update/delete plus move, assign, complete, add deliverable, and create next action |
| `projects.*` | link company, add contact, record decision |
| `research.*` | capture evidence |

All 37 definitions use the same schema validation, structured errors, and
canonical/MCP aliases as other Mim tools. Generic writes exist for complete
coverage; semantic commands are preferred because they validate target kinds
and create the right relations.

Terminal shortcuts use that same registry:

```bash
mimx graph
mimx graph cost effectiveness evidence
mimx board
mimx board in-progress
mimx context project-alpha
mimx call projects.record_decision '{"id":"project-alpha","title":"Use matched cohort"}'
```

## Migration and compatibility

Opening a graph dual-reads existing `<root>/knowledge/*.md` and
`<root>/issues/*.md` without first rewriting them. `knowledge.*` and `issues.*`
compatibility calls translate to the shared model and preserve legacy shapes.
Unknown metadata and stable ids survive read/write round trips.

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
| `tools.rs` | native registry definitions, compatibility, semantic commands |

Renderer ownership is split between `src/services/businessGraph.js`,
`src/stores/businessGraph.js`, the built-in app, and its components under
`src/mim/apps/business-graph/`. `WorkbenchApp.vue` mounts roots and owns the
Start Work handoff; `AppActivity.vue` only routes the built-in surface.

When changing the graph contract, update Rust module tests, the golden sources
under `src-tauri/tests/fixtures/business-graph/`, tool/runtime tests, the
relevant Vue projection or inspector tests, and this document.

## Verification

Golden fixtures cover every supported ontology kind and the complete legacy
Issue field shape. Rust tests cover scope isolation, parsing and lossless
round trips, conflicts, migration without writes, semantic actions, context
redaction, and a realistic HEOR workflow. Frontend tests cover services, store,
shell, board, inspector, maps, projections, Activity handoff, and `mimx`.

Debug-test performance budgets and the latest measured run are:

| Operation | Budget | Measured |
|---|---:|---:|
| build 5,000-node index | 2,000 ms | 48.7 ms |
| bounded query | 100 ms | 5.7 ms |
| ranked search | 500 ms | 12.3 ms |
| one-hop traversal | 100 ms | 0.08 ms |
| load 600 Markdown sources | 3,000 ms | 43.3 ms |
| revision-aware board mutation | 250 ms | 17.2 ms |
| refresh 600 sources | 3,000 ms | 42.4 ms |

These measurements are debug-build regression guards, not production
benchmarks. Run `cargo test --manifest-path src-tauri/Cargo.toml
business_graph` after native changes and follow the full release matrix in
[testing.md](testing.md).
