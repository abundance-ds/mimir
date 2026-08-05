# Mimir graph

## Fast path

- Use `mimir tools graph` once for every graph tool signature. Use
  `mimir tool <name>` only when that and the examples below are insufficient.
- Use graph tools, never the backing Markdown files.
- Find before get. Never guess an id. `graph_find` returns compact nodes;
  `graph_get` returns one full node.
- `graph_find.query` searches ids, titles, tags, summaries, and bodies.
  `kinds` filters the returned node's kind, not entities mentioned in its text.
  All filters combine.
- With `query`, results rank by relevance, then recency. Without `query`, they
  are newest first. The maximum `limit` is 100.
- After finding an exact node, `graph_context` returns bounded incoming and
  outgoing context. Use it instead of separately opening every related node.

## Common reads

Latest matching entry (two Mimir calls):

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

A text match inside a person node does not make the query subject a person
node. If no returned title/id is the requested entity, report that no exact
node exists.

Open high/urgent issues, newest first (`open` is not a status):

```bash
mimir call graph_find '{"kinds":["issue"],"limit":100}' \
  | jq '[.items[] | select(
      (.status != "done" and .status != "cancelled")
      and (.priority == "high" or .priority == "urgent")
    )] | sort_by(.updatedAt) | reverse'
```

## Ontology

Kinds:

```text
issue person company project note decision record
study evidence dataset analysis model endpoint publication submission
research-question method client-request
```

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

Store only the forward relation; backlinks provide the inverse. Existing
legacy nodes may contain other relation names.

## Writes and scopes

- `private:local` is local; `project:*` travels with the repo; `team:*` uses
  the configured shared graph. Omitted `scopeId` on create means the current
  project.
- Omitted `scopeIds` on reads (`graph_find`, `graph_search`, `graph_list`)
  means every mounted scope, including `private:local`.
- Do not put private data in another scope unless the user asked.
- Issue `status` and `priority` are properties. Project and assignee are
  `part_of` and `assigned_to` relations.
- Use `graph_get.sourceRevision` as `graph_update.expectedRevision` or
  `graph_delete.expectedRevision`. Delete returns the `graph_restore` token.
- `record` nodes and nodes with `properties.sensitive: true` are redacted from
  `graph_context`, but remain directly findable and readable.
