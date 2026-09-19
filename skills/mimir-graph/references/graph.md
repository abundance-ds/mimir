# Mimir graph

## Fast path

- Use graph tools, never backing Markdown files.
- Find before get. Never guess an id. A text match identifies an entity only
  when its title or id is exact.
- Graph links: `[Title](mimir://graph/<id>)`, using an ID from `graph_find`.
- `graph_find.query` searches ids, titles, tags, summaries, and bodies. `kinds`
  filters kinds; all filters combine; maximum `limit` is 100.
- Use `graph_context` for an exact node's related context.

```bash
mimir call graph_find '{"query":"FDE","limit":100}'
mimir call graph_get '{"id":"<exact returned id>"}'
```

For open work, select issues whose status is not `done` or `cancelled`; `open`
is not a status.

## Ontology

Kinds:

```text
project company person issue meeting note resource journal decision record timesheet
```

HEOR kinds:

```text
study evidence dataset analysis model endpoint publication submission
research-question method client-request
```

Companies use `roles` from
`own|client|prospect|partner|vendor`. Assignable People use
`teamMember: true` and `status: active`. Projects use `projectType` and
`projectStatus`. Use tags for loose topics.

Issue statuses: `backlog plan in-progress waiting review done cancelled`.
Priorities: `low normal high urgent`.

`timesheet`: any date span; user and AI choose. Project: `part_of`; person: `assigned_to`.
See `graph_create` and `graph_update` for row rules.

Preferred relations:

```text
person --works_at--> company
project --for_company--> company
project --has_contact--> person
issue --part_of--> project
issue --assigned_to--> person
issue --blocked_by--> issue
issue/project --depends_on--> issue/project
person/project --introduced_by--> person
any --references/related_to--> any
```

Store only the forward relation; backlinks provide the inverse.
Opportunity, Technology, Topic, Question, and Answer are not standard kinds.

## Writes and scopes

- `private:local` is private, `project:*` is Workspace, and `team:*` is shared.
  Without `scopeId`, workspace configuration applies first; otherwise normal
  kinds prefer Team and Journal prefers Private.
  `graph_status` lists mounted ids.
- Agent calls read `.mimir/workspace.toml`; new tasks use its Project link.
  This link does not restrict reads.
- Workspace file references are relative, never absolute. Mimir resolves them
  through the node's Project workspaces, then the open workspace.
- Use `graph_get`'s `provenance.sourceRevision` as `expectedRevision`
  for update or delete.
  Delete returns a `graph_restore` token.
- Private data stays Private. `graph_context` hides sensitive content.

## Team resources

- Mimir owns and synchronizes `~/.mimir/team-graph/`; do not run Git commands
  there during normal work.
- `graph/*.md` contains nodes. `resources/` contains shared templates,
  documents, CSV files, and brand assets.
- Reusable files normally belong to a `resource` node. Store paths in `files`,
  for example `{ "path": "resources/proposal.html", "label": "Template" }`.
  Connect other nodes to that Resource with `references`.
- `deliverables` remain Project-workspace paths, not Team resources.
- Import bytes with `graph_resource_add` or the Graph inspector's **Add Team
  file** action; do not write into the checkout. For an existing Resource, pass
  `resourceId` and its `sourceRevision` as `expectedRevision`. Mimir batches
  synchronization. The later recorded edit wins a same-file conflict; older
  versions remain in History.
