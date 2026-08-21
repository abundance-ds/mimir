# Mimir graph

## Fast path

- Use graph tools, never the backing Markdown files.
- Find before get. Never guess an id.
- `graph_find.query` searches ids, titles, tags, summaries, and bodies. `kinds`
  filters node kinds. All filters combine. The maximum `limit` is 100.
- After finding an exact node, use `graph_context` for its related context.

## Common reads

Latest matching entry:

```bash
mimir call graph_find '{"query":"FDE","limit":100}' \
  | jq '.items | max_by(.updatedAt) | {id,title,updatedAt}'
mimir call graph_get '{"id":"<returned id>"}'
```

Exact person and direct context:

```bash
mimir call graph_find '{"query":"Rob Smith","kinds":["person"],"limit":20}'
mimir call graph_context '{"focusId":"<exact returned id>","maxNodes":12}'
```

A text match does not make that node the requested entity. Require an exact
title or id.

Open high/urgent issues, newest first (`open` is not a status):

```bash
mimir call graph_find '{"kinds":["issue"],"limit":100}' \
  | jq '[.items[] | select(
      (.status != "done" and .status != "cancelled")
      and (.priority == "high" or .priority == "urgent")
    )] | sort_by(.updatedAt) | reverse'
```

## Ontology

Primary kinds:

```text
project company person issue meeting note resource journal decision record
```

Older HEOR kinds remain readable:

```text
study evidence dataset analysis model endpoint publication submission
research-question method client-request
```

Companies use `roles: [own|client|prospect|partner|vendor]`. Assignable People
use `teamMember: true` and `status: active`. Projects use `projectType` and
`projectStatus`. Use tags for loose topics. Do not create Client, Opportunity,
Technology, Topic, Question, or Answer nodes.

Issue statuses:

```text
backlog plan in-progress waiting review done cancelled
```

Issue priorities:

```text
low normal high urgent
```

Preferred relations:

```text
person  --works_at-----> company
project --for_company--> company
project --has_contact--> person
issue   --part_of------> project
issue   --assigned_to--> person
issue   --blocked_by---> issue
issue/project --depends_on--> issue/project
person/project --introduced_by--> person
any --references/related_to--> any
```

Store only the forward relation. Backlinks provide the inverse.

## Writes and scopes

- `private:local` is private, `project:*` is Workspace storage, and `team:*`
  is shared. With no `scopeId`, normal kinds prefer Team and Journal prefers
  Private. An explicit `scopeId` wins.
- `graph_status` lists the mounted scope ids. Call it before you write with an
  explicit `scopeId`.
- The runtime maps a scope id to its storage directory. Never write a file
  into a `graph/` directory yourself.
- Omitted read `scopeIds` means every mounted scope, including Private.
- Do not put private data in another scope unless the user asked.
- Issue `status` and `priority` are properties. Project and assignee are
  `part_of` and `assigned_to` relations.
- Agent calls read `.mimir/workspace.toml`. New tasks use its Project link. A
  Project result can include machine-local `localWorkspaces` paths. The link
  does not restrict graph reads.
- Use `graph_get.sourceRevision` as `graph_update.expectedRevision` or
  `graph_delete.expectedRevision`. Delete returns the `graph_restore` token.
- Sensitive nodes stay directly findable but are omitted from automatic
  `graph_context` output.
