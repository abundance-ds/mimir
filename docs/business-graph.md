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

Setup accepts a GitHub repository URL. A non-empty repository must already have
this layout and a GitHub `origin`; an empty one is initialized by Mimir. Setup
installs atomically after a successful first sync. Repository creation,
visibility, and collaborators remain on GitHub. There is no folder mode; old
Team-folder settings are ignored.

## Workspaces, projects, and files

`<workspace>/.mimir/workspace.toml` stores a stable workspace id, an optional
Project id, and the default `team` or `workspace` graph scope. One Project can
resolve to several local workspaces; absolute local paths never enter Team.

- Project deliverables resolve relative to a linked workspace and reject `..`.
- Team `files` entries resolve only inside the Team checkout. They never fall
  back to a same-named Project file.
- Shared files live under `resources/` and are normally linked from a Team
  `resource` node through structured `files` entries.
- Details on a Team Resource entry can attach an unlinked file. Files above
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
  complete file wins and the losing version remains in History. Project Home
  is the exception: its canvas merges separately from the rest of the Project.
  When both canvases changed, the later canvas timestamp wins, with commit
  time as fallback. Both parent versions remain in History.
- Unpublished work is branch-bound, mutating operations are serialized per
  repository, and a manual ahead commit joins the next push.
- Team stays mounted while offline. Only actionable failures appear in UI.
- **Change repository** first publishes pending work to the old repository,
  then moves the complete history to a pasted empty repository URL.

## Data model

Accepted kinds (`ENTITY_KINDS`): `issue`, `person`, `company`, `project`,
`note`, `journal`, `decision`, `record`, `meeting`, `resource`, `timesheet`,
`study`, `evidence`, `dataset`, `analysis`, `model`, `endpoint`, `publication`,
`submission`, `research-question`, `method`, `client-request`. Writes with any
other kind are rejected. Existing files with unknown kinds remain readable and
produce a diagnostic. Unknown metadata fields are preserved.

- Client is a Company role, not a separate kind.
- Tasks are `issue` nodes. Project and assignee use `part_of` and `assigned_to`.
- Backlinks provide inverse relations; write only the forward edge.
- `record` and `sensitive: true` content is redacted from automatic context,
  but remains directly readable.
- A filed Scribe meeting stores its summary and stable Scribe id. The transcript
  remains in Scribe.

## Time sheets

A `timesheet` stores one person's project work across any dates.
Use `part_of` for the Project and `assigned_to` for the Person (both optional).

The Markdown header stores `entries` as a YAML list. Each row requires:
- `id`: permanent, unique within the sheet. Alphanumeric first char, then
  letters/digits/underscores/hyphens. Max 128 chars.
- `date`: valid `YYYY-MM-DD`.
- `minutes`: whole number, 1--1440.
- `description`: non-empty string.
- `invoice` (optional): absent = Open; non-empty string = Invoiced. Boolean
  and empty values are invalid. The reference records inclusion on an invoice,
  not payment. Invoiced rows remain editable.

Max 10,000 rows per sheet. Unknown fields stay intact; old `period` does not
restrict dates. Totals are calculated at read time and never written into the
header. Structured saves reject invalid data; malformed source stays intact and
produces diagnostics. Sync resolves conflicts at complete-file level.
Native validation and agent writes share tests with renderer validation.

CSV export uses the current draft and freezes its data before the file dialog
opens. Authored text cannot become a spreadsheet formula. Invalid sheets cannot
export; **Save As** exports an invalid draft as a recovery copy. Hidden rows
never receive selection actions. Tracker import and invoice generation are out
of scope. Fixture preview: `harness/timesheet.html`.

## Inline links and backlinks

Links use Markdown with a Mimir target:
`[Jon Minton](mimir://graph/jon-minton)`. Mimir generates the target ID; users
select titles. The stored label remains fallback text. No alias system is used.
`@` lookup and **Link** work in working notes, the [Home canvas](#project-home),
and Graph source in the Editor. Lookup ignores case and accents, prefers title
and word prefixes, and searches every entry in the selected scopes. Code,
existing links, escaped text, email addresses, and IME composition do not
start the menu. Ordinary Markdown files do not enable Graph completion or
reference checks.

Rust derives `references` connections from the saved body and Project canvas.
Repeated links keep separate locations but produce one connection. Removing the
last link removes that connection. Explicit relations (e.g. Assigned to) remain
independent. Derived references never enter YAML `links` or editable relation
drafts. Code, images, and HTML comments do not create body references. Native
and editor parsers share one syntax fixture; change both together.

Title changes and scope moves preserve the generated filename and ID. New
generated IDs include a UUID v4 suffix, so creating an entry with a deleted
entry's title does not reuse its identity. Existing and explicitly supplied IDs
remain unchanged. Deleting an entry preserves referring text and marks links
**Unavailable**. Restoring the same ID resolves them again. Hidden or unmounted
targets also show Unavailable. Restore rejects an unmounted source before
writing. Diagnostics report unresolved body targets. Renaming source files outside Mimir changes
their IDs.

GraphStore owns title and reference indexes in memory. Lookup and target
resolution read indexes without reading files. A saved body or canvas reparses
only that entry; a title edit reuses its parsed references. Watcher events
reconcile only affected `graph/*.md` files, with the same duplicate-ID
precedence as startup. The background worker checks file metadata every six
hours to catch missed events. Startup and manual Refresh perform full
reconciliation. Scans run outside the store lock; a mutation gate serializes
writes and scope changes. Unchanged events do not change the graph revision or
reload the UI. There is no separate database or persistent index.

## Product surface

Home, Work, Graph, and Changes share the top navigation.
[Scribe](meetings.md) owns meeting preparation and filing. Entry details open
in Editor tabs. **Details** and **Source** share one save queue. Changing views
waits for pending writes; a conflict keeps the draft and view intact. Details
saves after a short pause; Source follows the Editor auto-save setting. Native
source writes check the mounted path and revision. Malformed Graph YAML stays
editable in Source; Details becomes available when it parses. An external body
replacement starts a fresh undo history. Deleted or unmounted entries keep
unsaved drafts without recreating the source; **Save As** exports the draft as
a separate copy and never writes the original source.

- Reopening an entry or its source selects the same tab and keeps its view and
  draft, without a source read or a wait for its pending save.
- Refresh updates clean open Graph documents and keeps dirty drafts with their
  original revision. Session restore keeps the saved baseline and the draft;
  remount checks source identity before writing.
- Opening a listed entry uses its mounted scope to locate the source; Rust
  validates source and id, and a stale path falls back to native lookup.
  References, neighbors, Git History availability, and Team file discovery
  load lazily and do not block the document.
- Details keeps the last Source editor state without updating the hidden
  document. Pending reviews activate after the Source buffer catches up.
- Field auto-size batches height reads before height writes and skips hidden
  rail content.
- Incoming explicit relations show under **Related**; body links show only
  under **Links** and **Backlinks**. Raw ids and revisions stay out of normal UI.
- Escape closes Details through the normal tab close check; open menus and
  link suggestions consume Escape first.

Entry-open requests pass from `BusinessGraphApp` through `AppActivity` to the
Workbench’s mounted Editor. Workspace startup owns Graph mounting and event
listening, even when its Main app is closed.

### Issue creation

New issues use a compact dialog with title, Markdown description, project,
status, owner, priority, and due date. The initial Project comes from the
selected Project column, then the Work Project filter, then the workspace link.
A related issue starts with its source entry’s Project. The submitted selection
is the sole new Project assignment; creation never adds the old default as a
second assignment. **Save to** storage is separate from Project membership.
Repeated creation keeps Project, owner, status, priority, and storage but
clears title, description, tags, and due date. Project search uses the complete
Project catalog, not the first entry page. Cmd/Ctrl+Enter creates the issue
before an editor or menu can consume the shortcut. Outside clicks do not close
a draft; Escape and close ask before discarding text. A pending save blocks
close and repeated submission; a failed save keeps the draft. Other kinds use
the general creation form. Fixtures: `harness/issue-create.html`,
`harness/shell.html?section=work&workbench`.

### Project home

Home opens in Main using the current workspace’s linked Project. It uses the
optional `home.canvas` property in the Project’s Markdown file -- a Markdown
string separate from the stable Project body. No separate entry kind or file.
The body is never copied into the canvas. Home never opens or selects an Editor
document.

Canvas edits autosave after 600 ms. Failed and conflicting drafts stay in Home
and in the session snapshot, including on Quit; recovery never depends on an
Editor tab. A canvas conflict shows the saved text and keeps the local draft
until the user chooses a version. Home writes only its
field against a fresh source path and revision. It retries independent context
changes. Details and Source can rebase a context-only draft over a canvas-only
disk change. Team sync merges canvas separately from other Project fields; when
both canvases changed, the later canvas timestamp wins (commit time as
fallback), and both parent versions remain in History.

`home.updatedAt` and `home.updatedBy` are set only when canvas text changes.
Missing metadata produces no invented date or author. Search, agent context,
and Graph references include canvas text. Canvas backlinks open that Project's
Home in Main.

**Needs attention** shows up to five open tasks that are waiting, in review,
overdue, or due today. Closed and snoozed tasks are excluded. The query reads
all pages of explicitly assigned Project tasks; Graph and Work filters do not
restrict it. A failure shows **Retry**, not an empty result. Fixture:
`harness/project-home.html`.

### Graph table and Work

Graph has one table: Title, Kind, Project, Created, Updated. Default sort is
Updated descending. Kind and Project columns have filter buttons. Kind lists
kinds in the selected scopes independently of other filters and paging. Project
filter includes text search and **No project**.

Search uses **Best match** relevance: exact title matches, then titles
containing all terms, then content matches. Native queries apply scope,
project, and kind filters, then sorting, before pagination. **Show more**
loads the next page: 500 entries for browsing (`MAX_QUERY_LIMIT`) and 100 for
search (`MAX_SEARCH_LIMIT`). A changed order or filter rejects late pages.
Background refresh keeps the loaded entry count, the selected entry, and the
first visible row; it never opens or replaces a document. Selections within a
column match any value; filters across columns must all match. Browse order and
column filters persist; search order lasts for the current query. Missing or
invalid dates and unassigned projects sort last in both directions. Fixture:
`harness/graph.html` (`?pane=380&offset=260` for a narrow clipped pane).

Project filtering includes the Project entry and entries with explicit
`part_of` assignments. A resolved legacy project id is also accepted. Body
mentions, backlinks, and other relation types do not assign a project.
**No project** includes entries with no assignment or no resolved project in
the selected scopes. Multiple memberships use the first project by name for
sorting and match any selected project.

Work hides Done and Cancelled issues by default. Missing status uses Backlog.
Work treats missing project assignments, old labels, and references without a
matching loaded Project as No project. A named Project filter also matches
explicit secondary assignments. Board drag into No project clears project
assignment; drag within a column changes rank only and preserves stored
references. Board and List share one row grammar (`business-graph/workRow.js`).
Board column visibility follows task filters but ignores search, so typing does
not move columns. Undo of a UI close or bulk status change restores the prior
status and rank only at the saved revision; it never overwrites later edits.

Settings > Graph > You selects the reader’s Person node
(`businessGraphSelfPersonId`). It drives the `you` token in Work.

Entry Details offers **Work with agent** in More actions. It saves the entry,
then prepares bounded context for an agent Activity.

Public Graph commands are defined only in [agent-interface.md](agent-interface.md).
Native ownership is under `src-tauri/src/business_graph/`; renderer ownership
is the Graph service, store, and components under
`src/mimir/apps/business-graph/`.
