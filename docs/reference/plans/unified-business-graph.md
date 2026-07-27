# Unified business graph

Status: shipped implementation record; final desktop visual audit pending

## Goal

Build Mim's durable operating graph for a five-to-ten-person AI-native HEOR
research consultancy.

The finished system combines the Knowledge Graph and Issue Board into one
built-in instrument backed by a Rust graph engine. It preserves Markdown as
durable, reviewable source data; keeps private, project, and team information
physically scoped; exposes continuously available tools to agents; and turns
projects and business workflows into exceptional interactive maps.

## Product decisions

1. An issue is a typed graph node.
2. The Issue Board is a first-class projection with specialized interaction
   behavior, not a generic graph query rendered as columns.
3. Rust owns parsing, validation, indexing, traversal, conflict detection,
   source-aware writes, and change events.
4. Vue owns the high-quality interactive UI inside an ordinary Mim Activity.
5. Markdown remains source of truth. Every cache and index is disposable.
6. The initial ontology is deliberately bounded and business-specific.
7. Private, project, and team scopes use physical source separation. This
   product does not require an enterprise identity or policy system.
8. Existing `knowledge.*` and `issues.*` tool behavior remains available
   through compatibility facades while the shared graph API becomes canonical.
9. Existing files are dual-read before any optional physical migration.
10. Project maps are polished first-party instruments. Mim will not begin with
    a generic no-code dashboard builder.

## Non-goals

- Enterprise role administration, row-level policy editors, or approval flows.
- A networked multi-tenant graph server in the initial implementation.
- SQLite as canonical storage.
- Arbitrary user-defined entity types in ontology v1.
- Rendering the desktop UI in Rust.
- A universal dashboard/plugin framework before the core maps are excellent.

## Information scopes

GraphStore composes three simple source classes:

| Scope | Intended contents | Sharing |
|---|---|---|
| Private | personal notes, reminders, annotations, drafts | local machine only |
| Project | issues, decisions, deliverables, research, project contacts | project repository/team |
| Team | companies, shared people, business projects, methods, shared knowledge | shared business graph repository |

Every loaded node and edge retains `scope`, `source_path`, and
`source_revision`. Queries receive an explicit scope set. Search, backlinks,
counts, suggestions, and projections operate only over that set.

Initial storage convention:

```text
~/.mim/graph/private/                 private local source
<workspace>/knowledge/                legacy/current project knowledge source
<workspace>/issues/                   legacy/current project issue source
<configured-team-graph>/knowledge/    shared team source
```

The exact team root is a user setting. Project data continues to travel with
the project. A private edge to a shared node lives in the private source and
does not modify the shared node.

## Ontology v1

### Core entity kinds

| Kind | Purpose |
|---|---|
| `issue` | operational work, review, follow-up, or blocker |
| `person` | a teammate, client contact, collaborator, or stakeholder |
| `company` | client, prospect, partner, supplier, or other organization |
| `project` | engagement, internal initiative, research project, or product |
| `note` | durable knowledge, analysis, working knowledge, or source summary |
| `decision` | an explicit choice with rationale and consequences |
| `record` | structured or sensitive administrative information |

Legacy `org` is read as `company`. Existing identifiers remain stable.

### Common node fields

```text
id
kind
title
summary
body
tags
created_at
updated_at
scope
source_path
source_revision
custom
```

`custom` preserves unknown legacy frontmatter. New public APIs accept only
known kinds and validated first-class fields.

### Issue fields

```text
status: backlog | plan | in-progress | waiting | review | done | cancelled
priority: low | normal | high | urgent
due_date
remind_at
snooze_until
waiting_for_text
deliverables
rank
```

Project and assignee are graph relationships, not authoritative strings.
Compatibility reads and writes retain the legacy fields during migration.

### Initial relation vocabulary

| Relation | From | To |
|---|---|---|
| `works_at` | person | company |
| `for_company` | project | company |
| `has_contact` | project | person |
| `part_of` | issue | project |
| `assigned_to` | issue | person |
| `blocked_by` | issue | issue |
| `depends_on` | issue/project | issue/project |
| `introduced_by` | person/project | person |
| `references` | any | any |
| `related_to` | any | any |

Backlinks supply inverse navigation. New writes should not create redundant
inverse edges. Legacy inverse relations remain readable until migrated.

### HEOR extensions

The initial design must leave clear first-party extension points for:

```text
study
evidence
dataset
analysis
model
endpoint
publication
submission
research-question
method
client-request
```

These are implemented only with concrete workflows and acceptance fixtures,
not as speculative generic ontology machinery.

## Rust GraphStore contract

GraphStore is a rebuildable in-memory read model over one or more Markdown
sources.

It owns:

- frontmatter/body parsing and lossless preservation of unknown metadata;
- normalization of legacy Knowledge and Issue files;
- stable node and edge identity;
- indexes by kind, scope, tag, issue status, priority, and relation endpoint;
- ranked text search;
- outgoing and incoming adjacency;
- bounded filtered queries and pagination;
- ontology and relation validation;
- expected-revision checks and atomic writes;
- external source refresh and graph revision events;
- diagnostics for malformed files, dangling links, ambiguous identity, and
  legacy fields awaiting migration.

It does not own:

- canonical data separate from Markdown;
- UI layout state;
- arbitrary plugin execution;
- enterprise authorization.

## Command model

Generic reads are appropriate. User-visible writes should increasingly use
semantic commands:

```text
graph.list
graph.get
graph.search
graph.neighbors
graph.query
graph.create
graph.update
graph.delete

issues.create
issues.update
issues.assign
issues.move
issues.complete

projects.link_company
projects.add_contact
```

All mutations include an optional expected source revision. Conflict results
identify the changed entity and return enough current metadata for the UI to
reload or reconcile.

The legacy `knowledge.*` and `issues.*` names remain registered and translate
to the same engine. Typed facades are retained because they are easier and
safer for agents than unconstrained graph patches.

## Combined app

The built-in app appears as one stable App Activity. It uses the native Mim
theme and interaction grammar rather than an iframe-local design system.

Primary scopes:

```text
Work | Projects | People | Companies | Knowledge | All
```

Contextual views:

| Scope | Initial views |
|---|---|
| Work | Board, List, Attention |
| Projects | Portfolio, Overview, Timeline, Graph |
| People | Directory, Relationships, Attention |
| Companies | Directory, CRM, Relationships |
| Knowledge | List, Timeline, Graph |
| All | Search, List, Graph |

The implemented visual direction is an all-day operational developer tool:
source-aware, relational, precise, and calm, with Linear-like interaction
speed and a restrained measure of Bloomberg Terminal's persistent data
density. It rejects academic/editorial identity, enterprise form walls, and
consumer-dashboard polish. The full interaction and review contract lives in
[Business Graph experience redesign](business-graph-experience-redesign.md).

- **Scan** keeps fixed boards, operational tables, lists, timelines, CRM, and
  maps dense and immediately readable.
- **Peek** is a read-first side surface with quick properties and a
  plain-language relationship sentence.
- **Focus** is a spacious object workspace with one scroll, auto-growing
  fields, syntax-aware Markdown, and bounded relation authoring.
- The context trail remains the navigation signature and restores the exact
  originating projection when stepped backward.
- Mim theme tokens, visible focus, keyboard parity, and reduced-motion
  behavior apply across every custom listbox, calendar, dialog, and action.
- Source/scope/revision metadata stays restrained; primary content never
  collapses into tiny, repeated bordered forms.
- Colored left edges, lifting cards, hidden-on-hover controls, geometry-changing
  hover effects, decorative gradients, and presentation tiles are forbidden.

Foundation wireframes:

```text
┌ Graph / Work ─────────── [search…………] [scope ▾] [+] ┐
├ Work  Projects  People  Companies  Knowledge  All ──┤
├ Alpha engagement › Evidence map › Extraction issue ─┤
│                                                      │
│ projection toolbar                                   │
│ ┌ Backlog ┐ ┌ Plan ┐ ┌ In progress ┐ ┌ Review ┐     │
│ │ cards   │ │      │ │ cards       │ │        │     │
│ └─────────┘ └──────┘ └─────────────┘ └────────┘     │
└──────────────────────────────────────────────────────┘
```

```text
focused object / narrow activity
┌ Graph / Project Alpha ─────────────── [×] ┐
├ Project Alpha › Evidence map › Issue 42 ──┤
├ status · priority · assignee · due ───────┤
│ Issue title                                │
│ Markdown body                              │
│                                           │
├ Related ──────────────────────────────────┤
│ company · contacts · decisions · evidence │
└───────────────────────────────────────────┘
```

## Issue Board parity contract

The replacement is not complete until it preserves or improves:

- Board and grouped List views.
- Grouping by status and project.
- Dragging cards between status/project columns.
- Column visibility and horizontal board navigation.
- Inline status, priority, label, assignee, project, due-date, and reminder
  controls.
- Searchable/creatable label and project pickers.
- Stable label colors without rewriting every issue.
- Priority/project filters and useful sorts.
- Focused create flow and create-another flow.
- Markdown detail view with deliberate edit mode and autosave.
- One owning Focus scroll, with portaled menus and calendars that do not create
  nested content scroll traps.
- Reminders, waiting, snooze, deliverables, overdue state, and due-soon state.
- Keyboard-first create, search, view switching, menus, navigation, and Escape
  behavior.
- Safe deletion and undo/recovery behavior.
- Optimistic updates with visible rollback/conflict handling.

## Graph-native improvements

1. Project and assignee pickers resolve real nodes and show useful context.
2. Issue detail shows project, company, contacts, blockers, decisions,
   deliverables, related knowledge, and associated Activities.
3. `Start work` launches an agent Activity with compact graph-grounded context
   and associates the run with the issue.
4. Project Overview combines health, current work, decisions, milestones,
   deliverables, contacts, and recent Activity.
5. CRM maps companies, people, engagements, opportunities, recent contact, and
   next actions.
6. Attention combines overdue/waiting issues, stale projects, dangling
   relationships, unresolved migration diagnostics, and HEOR work needing
   review.
7. Files and deliverables open in the persistent right-hand Editor while graph
   context remains in the Activity pane.

## Migration

Migration is staged and reversible:

1. Parse existing Knowledge and Issue fixtures without writing.
2. Produce a report of node counts, aliases, dangling relations, project
   strings, assignee strings, and collisions.
3. Dual-read legacy directories into one graph.
4. Keep legacy tool contracts working.
5. Resolve exact project IDs automatically in the read model.
6. Resolve people only when an identity match is unambiguous.
7. Offer explicit fixes for unresolved identity.
8. Cut new writes over only after UI/tool parity.
9. Preserve original paths by default.
10. Make any later physical reorganization a separate dry-run migration.

## AI-native HEOR workflow contract

The graph is successful when an agent can:

1. Start from a client, project, issue, or research question.
2. Retrieve a compact catalog before reading large bodies.
3. Traverse relevant people, decisions, methods, evidence, analyses, and
   deliverables.
4. distinguish private, project, and team sources in its context.
5. Update the exact operational node as work advances.
6. Open or create reviewable files in the Editor.
7. Leave a durable decision, issue update, evidence link, and next action.
8. Resume later without reconstructing project context from chat history.

## Delivery backlog

### 0. Contract and fixtures

- [x] Reconcile this plan with the current repository architecture.
- [x] Inventory every legacy Knowledge/Board behavior and test.
- [x] Build sanitized golden Markdown fixtures for all entity kinds and legacy
      issue fields.
- [x] Define Rust DTOs, error categories, revisions, and event payloads.
- [x] Define measurable acceptance and performance budgets.

### 1. Rust core

- [x] Add the graph module and state lifecycle.
- [x] Implement frontmatter/body parsing and serialization.
- [x] Implement Knowledge and Issue source adapters.
- [x] Implement ontology validation and diagnostics.
- [x] Implement indexes, adjacency, ranked search, and bounded queries.
- [x] Implement atomic revision-aware mutations.
- [x] Implement refresh/change events and workspace switching.
- [x] Cover parsing, indexing, validation, mutation, and conflict behavior with
      Rust tests.

### 2. Scopes

- [x] Add local private graph-root resolution.
- [x] Add current-project sources.
- [x] Add configured team graph-root setting.
- [x] Compose selected scopes without losing provenance.
- [x] Enforce cross-scope edge storage rules.
- [x] Test that private data never appears in team-only queries or aggregates.

### 3. Tools

- [x] Register always-on `graph.*` tools.
- [x] Implement `knowledge.*` compatibility.
- [x] Implement `issues.*` compatibility.
- [x] Add semantic issue/project commands.
- [x] Add concise agent context and sensitive-record handling.
- [x] Add MCP, `mimx`, and app-caller integration tests.

### 4. Built-in app foundation

- [x] Register the built-in graph app and Activity surface.
- [x] Create the Vue graph store/service bridge.
- [x] Implement responsive shell, scope navigation, view navigation, context
      trail, loading, empty, diagnostic, and conflict states.
- [x] Establish the app's token, typography, density, and motion rules.
- [x] Add component and shell tests.

### 5. Work projection

- [x] Port Board and List parity behavior.
- [x] Implement graph-backed project and assignee controls.
- [x] Implement issue detail, reminders, waiting, snooze, and deliverables.
- [x] Implement drag/drop and keyboard-equivalent movement.
- [x] Implement filtering, sorting, display properties, and saved local view
      state.
- [x] Implement safe optimistic mutation and recovery.

### 6. Knowledge and project maps

- [x] Implement cross-scope search and Knowledge list.
- [x] Implement Project Portfolio and Project Overview.
- [x] Implement People and Company directories/details.
- [x] Implement Timeline and Attention maps.
- [x] Implement interactive graph traversal and context preservation.
- [x] Implement a focused CRM map.

### 7. AI-native workflows

- [x] Assemble bounded issue/project/HEOR context for agents.
- [x] Implement `Start work` Activity handoff.
- [x] Associate Activities and deliverables with graph nodes.
- [x] Add durable decision and next-action flows.
- [x] Restore the Knowledge terminal workflow as a client of the shared tools.
- [x] Test realistic HEOR research-consultancy scenarios end to end.

### 8. Migration and cutover

- [x] Implement dry-run inventory and diagnostics.
- [x] Test against copies of representative existing Knowledge and Issue data.
- [x] Provide explicit identity-resolution actions.
- [x] Verify lossless round trips and rollback.
- [x] Cut the combined app over to native writes.
- [x] Retire duplicate runtime code only after compatibility gates pass.

### 9. Verification and polish

- [x] Run frontend, Rust, build, and documentation checks.
- [ ] Verify narrow, default, wide, railed, expanded, and reduced-motion states.
- [x] Verify complete keyboard and visible-focus behavior.
- [x] Replace every native Business graph `select`/`datalist` with the polished,
      searchable, keyboard-operable Vue listbox.
- [x] Benchmark startup, search, graph query, board mutation, and refresh.
- [ ] Conduct visual screenshot critique and refinement.
- [x] Review copy, empty states, diagnostics, conflicts, and recovery.
- [x] Review security boundaries proportionately for a trusted small team.

### 10. Documentation and completion

- [x] Update README product description.
- [x] Add the graph system to the codebase map and runtime architecture.
- [x] Document ontology, scopes, storage, tools, app UX, migration, and recovery.
- [x] Update acceptance criteria, testing guidance, and known issues.
- [ ] Perform final code, UX, architecture, and documentation review.
- [x] Confirm no legacy capability was lost unintentionally.

## Completion standard

The goal is complete only when the combined built-in app is the preferred daily
surface; private/project/team data compose correctly; legacy Knowledge and
Issue files migrate without loss; agents can use the graph continuously;
project and CRM maps are genuinely useful for HEOR consultancy work; tests and
builds pass; performance is measured; visual and keyboard polish is complete;
and current documentation describes the shipped system rather than the plan.
