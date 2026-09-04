# Business graph

The Graph stores projects, companies, people, tasks, meetings, and reusable
knowledge as Markdown. The Rust `GraphStore` is a rebuildable read model with
indexes, backlinks, revision checks, diagnostics, and filesystem watchers.

## Storage and scope

- Private: `~/.mimir/private/graph/`.
- Workspace: `<workspace>/graph/`, used only when graph data must travel with
  that folder. Native code calls this scope `project` for file compatibility.
- Team: `~/.mimir/team-graph/`, the normal shared scope.
- A scope is a storage location. A semantic Project is a graph node.
- Graph writes are revision-aware atomic replacements. Delete uses system
  Trash; malformed Markdown stays untouched and becomes a diagnostic.

The managed Team repository has one fixed layout:

```text
~/.mimir/team-graph/
├── .git/
├── mimir-team.toml
├── graph/
├── resources/
├── skills/       # optional
└── agents/       # optional
```

Setup accepts an existing GitHub repository URL. An existing non-empty
repository must already have this layout and a GitHub `origin`; an empty
repository is initialized by Mimir. Setup is installed atomically after a
successful first sync. Old Team-folder settings are ignored: there is no
backward-compatible folder mode. Repository creation, organization, visibility,
and collaborators remain on GitHub.

## Workspaces, projects, and files

`<workspace>/.mimir/workspace.toml` stores a stable workspace id, an optional
Project id, and the default `team` or `workspace` graph scope. One Project can
resolve to several local workspaces; absolute local paths never enter Team.

- Project deliverables resolve relative to a linked workspace and reject `..`.
- Team `files` entries resolve only inside the Team checkout. They never fall
  back to a same-named Project file.
- Shared files live under `resources/` and are normally linked from a Team
  `resource` node through structured `files` entries.
- Focus on a Team Resource node can attach an unlinked file. Files above
  100 MB are rejected before import.

## Managed synchronization and history

- Mimir uses installed `git` and the active GitHub CLI login. It stores no
  GitHub token and exposes no routine commit, pull, or push UI.
- Sync runs at startup, on focus and network recovery, and every five active
  minutes. A local batch closes after five quiet minutes, thirty continuous
  minutes, or application close.
- Offline edits amend one unpublished commit. Published history is never
  squashed or force-pushed; bounded local recovery refs protect rewrites.
- Different-file changes merge. For a same-file conflict, the later recorded
  complete file wins and the losing version remains in History.
- Unpublished work is branch-bound, mutating operations are serialized per
  repository, and a manual ahead commit joins the next push.
- Team stays mounted while offline. Only actionable failures appear in UI.
- **Change repository** first publishes pending work to the old repository,
  then moves the complete history to a pasted empty repository URL.

## Data model

Primary kinds are `project`, `company`, `person`, `issue`, `meeting`, `note`,
`resource`, `journal`, `decision`, and `record`. Legacy kinds remain readable,
but new public writes accept only the bounded ontology. Unknown metadata is
preserved.

- Client is a Company role, not a separate kind.
- Tasks are `issue` nodes. Project and assignee use `part_of` and `assigned_to`.
- Backlinks provide inverse relations; write only the forward edge.
- `record` and `sensitive: true` content is redacted from automatic context,
  but remains directly readable.
- A filed Scribe meeting stores its summary and stable Scribe id. The transcript
  remains in Scribe.

## Product surface

Work, Projects, Knowledge, Journal, All, and Changes are projections of the
same nodes. Peek and Focus edit one revision-aware draft; navigation commits
that draft first. Graph search filters the active projection. The dispatch bar
supports lookup, deterministic commands, and agent work with a bounded,
source-aware context pack. Raw ids and source revisions stay out of normal UI.

Work rows share one grammar (`business-graph/workRow.js`) across Board, List,
and Attention. A Board card has a fixed height and fixed slots: title with
the owner at its right, the project beneath, then the due date with the
waiting reason after it, and the priority control at the bottom right. Only
the title and the waiting reason truncate. Due dates are words relative
to today (`due today`, `due tomorrow`, `due 3d`, `due 22 Sep`, `4d overdue`);
a missing date is a quiet calendar control. The waiting slot reads
`waiting for <reason>`, and `me`, `human`, or `owner` reads as `you`. The
owner slot shows the assignee's initials, or `you` for the configured person;
the last editor stays in Changes. Board columns share the width and scroll
when there is no room. Cards are `chrome-high` plates with a 2 px radius
and a 4 px gap on a `chrome` column. The List is single-line
rows under sticky group headers and follows the Board grouping (status or
project). Attention groups open issues by reason, in order: Overdue,
Waiting, Urgent, Due this week. Project and Owner selectors sit beside the
view tabs because they scope the visible work; each has a one-click reset,
and a scoped project drops the project slot from rows. The Owner list offers
You, active team members, and Unassigned.

Settings > Graph > You selects the reader's Person node
(`businessGraphSelfPersonId`). It drives the `you` token and the Owner
list's You entry; without it, rows show initials for every assignee.

Public Graph commands are defined only in [agent-interface.md](agent-interface.md).
Native ownership is under `src-tauri/src/business_graph/`; renderer ownership
is the Graph service, store, and components under
`src/mimir/apps/business-graph/`.
