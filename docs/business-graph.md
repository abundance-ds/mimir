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

Work and Graph are the two primary projections. Work is the default issue
projection with Board and List views. Graph is the complete node surface; its
List and Timeline views can filter by kind. Startup and selecting Graph reset
the kind filter to All kinds, including for old saved projections.
Changes shows the event stream. [Scribe](meetings.md) owns meeting preparation
and filing. Peek and Focus edit one revision-aware draft;
navigation commits that draft first. In Work, search filters the loaded issues
immediately by title, summary, tags, project, owner, and work details. Terms
combine and ignore case and accents. Board keeps its columns, and List keeps
its groups and sort order. Empty search columns remain visible; clearing the
query restores the work. Graph uses debounced content search.
The dispatch bar supports lookup, deterministic commands, and agent work with a
bounded, source-aware context pack. Raw ids and source revisions stay out of
normal UI. Projection navigation stays direct at every width.

Work rows share one grammar (`business-graph/workRow.js`) across Board and
List. A Board card has a fixed height and fixed slots: a two-line title with
the owner at its right, the project beneath, then the due date with the
waiting reason after it, and the priority control at the bottom right. Only
the title and the waiting reason truncate. Due dates are words relative
to today (`due today`, `due tomorrow`, `due 3d`, `due 22 Sep`, `4d overdue`);
a missing date is a quiet calendar control. The waiting slot reads
`waiting for <reason>`, and `me`, `human`, or `owner` reads as `you`. The
owner slot shows the assignee's initials, or `you` for the configured person;
the last editor stays in Changes. Board columns share the width and scroll
when there is no room. Column sizing is independent of card text and search
results. Cards are `chrome-high` plates with a 2 px radius
and a 4 px gap on a `chrome` column. The List is single-line
rows under sticky group headers and follows the Board grouping (status or
project). The second header keeps frequent task filters beside the views:
Project, an Owner icon until a person is selected, and Filter for Priority.
Selected values have adjacent clear actions. In narrow panes, these controls
move into Filter, with named, clearable active-filter chips. The available pane
width determines the layout, including when Peek is open. The smallest panes
show the active filter count; open Filter to read or clear each selected value.
Display stays separate at the right and contains Group by, Sort, Columns, and
Show closed issues. Work hides Done and Cancelled issues by default. This setting
applies to both groupings, Board, List, and Work search, and persists across
restarts. Graph is not affected. Done stays on the status Board as a drop target;
Cancelled has its own column when closed issues are shown. Closing issues from
the UI offers Undo for the last action, including bulk status changes. Undo
restores the prior status (and rank after a drag) only at the saved revision;
it does not overwrite later edits. Failed restores remain available to retry.
Columns appears only on a status-grouped Board; collapsed columns do not count
as task filters. A project-grouped Board hides empty project columns by default.
Display offers Show empty projects for that Board only and saves the choice
across restarts. Column visibility follows the project, owner, priority, and
closed-issue filters, but ignores search so typing does not move columns.
All projects remain available in project selectors, including hidden projects.
Showing empty projects provides empty columns for creating or moving work;
it does not add empty groups to List or change status columns. A
scoped project drops the project slot from rows. The Owner list offers You,
active team members, and Unassigned.

Work treats missing project assignments, old labels, and references without a
matching loaded Project as No project. Board grouping, List grouping, and the
Project filter share this rule; stored references are preserved. Old project
labels do not get their own columns or filter options. The No project column
appears only when needed by issues that match the task filters, even with Show
empty projects enabled. It remains in place while search filters its cards.
Drag ordering uses the same project-resolution rule as column grouping. With
Manual order selected, a drag within a column changes rank only and preserves
stored project references. A drag from a project into No project clears the
moved issue's project assignment and places it at the drop position. Status,
owner, and other relations stay unchanged; other cards receive rank changes only.
Missing status continues to use Backlog.

Settings > Graph > You selects the reader's Person node
(`businessGraphSelfPersonId`). It drives the `you` token and the Owner
list's You entry; without it, rows show initials for every assignee.

Public Graph commands are defined only in [agent-interface.md](agent-interface.md).
Native ownership is under `src-tauri/src/business_graph/`; renderer ownership
is the Graph service, store, and components under
`src/mimir/apps/business-graph/`.
