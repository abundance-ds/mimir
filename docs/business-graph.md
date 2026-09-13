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

## Inline links and backlinks

In a Graph working note, type `@` and part of an entry title, or use **Link**.
The same lookup works in the body of a Graph source in the Editor. Ordinary
Markdown and frontmatter do not enable Graph completion or reference checks.
The menu shows the title, kind, and scope. Arrow keys select a result;
Enter inserts it; Escape closes the menu. Lookup ignores case and accents,
prefers title and word prefixes, and searches every entry in the selected
scopes. Work filters and the renderer's first list page do not limit lookup.
Code, existing links, escaped text, email addresses, and IME composition do not
start the menu. Create supports insertion; links open after the entry is saved.

Links are ordinary Markdown with a Mimir target:
`[Jon Minton](mimir://graph/jon-minton)`. Mimir generates the target ID; users
select titles. The Graph editor shows the target's current title and exposes
the Markdown when the cursor enters the link. Alt-click also permits source
editing. The stored label remains fallback text. No alias system is used.

Click a resolved link to open its entry in an Editor tab. Details shows
**Links** and **Backlinks**. A backlink opens the referring entry and selects
the reference in its current view. The previous draft stays in its own tab.
If the source changed, Mimir finds a current occurrence of that target. If
none remains, it opens the body without selecting unrelated text.

The suggestion menu has a 320 px preferred width, bounded by the pane and
viewport. Each row separates the title from its kind and scope. The popup
sits outside clipping containers, stays keyboard-accessible, and follows
pane resizing.

Rust derives `references` connections from the saved body. Repeated links keep
their separate locations but produce one connection. Removing the last link
removes that connection; undo restores it on save. Explicit relations such as
Assigned to remain independent. Derived references never enter YAML `links`
or editable relation drafts. Native and editor parsers share a syntax fixture
for inline, reference-style, and automatic links, Unicode, and exclusions.
Code, images, and HTML comments do not create body references.

Title changes and scope moves preserve the generated filename and ID. New
generated IDs include a full UUID, so creating a new entry with a deleted
entry's title does not reuse its identity. Existing IDs remain unchanged;
explicit IDs supplied by agents or source files remain deliberate identities.
Deleting an entry preserves referring text and marks links **Unavailable**.
Restoring the same ID resolves them again. Hidden or unmounted targets also
show Unavailable; this state does not claim permanent deletion. Native graph
diagnostics report unresolved body targets. Restore rejects an unmounted
source before writing. Renaming source files outside Mimir changes their IDs.

GraphStore owns the title and reference indexes in memory. Lookup and target
resolution read those indexes without reading files. A saved body reparses
only that entry; a title edit reuses its parsed references. Watcher events
reconcile only affected direct `graph/*.md` files across mounted roots, with
the same duplicate-ID precedence as startup. Unchanged events do not change
the graph revision or reload the UI. The existing worker checks file metadata
every six hours to catch missed events; it sleeps between events and checks.
Startup and manual Refresh perform a full reconciliation. Scans run outside
the store lock; a mutation gate orders publication, writes, and scope changes.
Native mutation commands run on background workers. No separate database or
persistent index format is required.

Verification covers 10,000 entries and 10,000 Markdown files, indexed lookup
during scans and writes, single-file updates, syntax, deletion/restoration,
scope restrictions, stale requests, undo, and tool/context consistency. Native
benchmarks print measured costs with `cargo test --manifest-path
src-tauri/Cargo.toml --lib business_graph -- --nocapture`. These debug tests do
not establish native webview geometry, input-to-display latency, fan behavior,
or energy use. Computer and browser interaction were excluded from this
feature's verification. On the reference Mac, a debug run with 10,000 files
measured lookup p95 at 35.2 ms during full scans and writes, one-file
reconciliation at 1.5 ms, and full reconciliation at 1.81 s. These are measured
native costs, not input-to-display guarantees.

## Product surface

Work and Graph are the two primary projections. Work is the default issue
projection with Board and List views. Graph is the complete node surface; its
List and Timeline views can filter by kind. Startup and selecting Graph reset
the kind filter to All kinds, including for old saved projections.
Changes shows the event stream. [Scribe](meetings.md) owns meeting preparation
and filing. Entry details open in Editor tabs, leaving the Graph projection
in Main. Preview, pinning, close, and session restore use the Editor tab
lifecycle. Reopening an entry or its source selects the same tab and keeps
its current view and draft. Working-note undo, caret, and scroll stay with the
open tab; an external body replacement starts a fresh undo history.
Title, summary, and file fields resize with their text and the Editor width.
Sizing skips hidden rail content and runs again when the pane opens.
Changed fields resize in one batch, with height reads before final height
writes. Mounting and text changes share one watcher to avoid repeated sizing.
**Details** and **Source** share one save queue.
Changing views waits for pending writes and saves; a conflict keeps the draft
and view intact. Details saves after a short pause; Source follows the Editor
auto-save setting. Native source writes check the mounted path and revision.
Malformed Graph YAML stays editable in Source; Details becomes available when
it parses. Deleted or unmounted entries keep unsaved drafts without recreating
the source. **Save As** exports the current draft, including a deleted or
unmounted entry, as a separate Markdown copy. Rust formats rich recovery
exports with the existing serializer; export does not write the original
source. Confirmed scope moves retain the tab and update its path.

Workspace startup owns Graph mounting and event listening, even when its Main
app is closed. Refresh updates clean open Graph documents and retains dirty
drafts with their original revision. Session restore keeps both the saved
baseline and the current draft; remount checks source identity before writing.

Entry-open requests pass from `BusinessGraphApp` through `AppActivity` to the
Workbench's mounted Editor. Workbench integration tests click Board, List,
and Timeline entries through this route, including when the Editor is a rail.
The full-component test also checks draft editing, close cancellation, and
focus return to the Board row. Escape closes Details through the normal tab
close check; open menus and link suggestions consume Escape first.

Details puts the title, essential work fields, and working note first.
Issues show status, priority, project, owner, and due date; a waiting reason
appears when set or when status is Waiting. Project and owner fields include
direct entry links. Existing files and explicit relations use compact rows.
Incoming explicit relations appear under **Related**; body links appear only
under **Links** and **Backlinks**. Those groups start collapsed, show counts
and unavailable-link warnings, and disappear when empty. **More properties**
holds reminders, snooze, tags, output/file path editors, and timestamps.
Set reminders, snooze dates, and tags remain visible beside its toggle.
Project overview also starts collapsed. These disclosures change presentation;
the Graph schema and saved properties stay the same.

Opening a listed entry uses its mounted scope to locate the source. Rust
validates that source and its entry id; a stale path falls back to native
lookup. This removes the separate full-entry read on the common opening path.
Reopening the exact open tab reuses its snapshot and draft without a source
read or a wait for its pending save. Git History availability runs when More
actions opens; Team file discovery runs when More properties opens. References
and neighbors load separately and do not block the initial document.
Details retains the last Source editor state without updating its hidden
document or extensions. Selecting Source applies the latest saved content and
retains each open text tab’s undo, selection, and scroll state. Pending reviews
activate after the Source buffer has caught up.
Working-note theme and highlighting rules are shared across editor instances,
so repeated opens do not add a new set for each entry.

A WebKit check on 2026-09-14 compared four entry opens in each recording.
With the [shared stylesheet fix](editor-system.md#codemirror-surface), the
largest style calculation fell from 33.3 ms to 1.9 ms, and the largest forced
layout fell from 53.1 ms to 1.9 ms. The repeated 77–84 ms style/layout pauses
were absent from the final recording. These are recorded event durations,
not complete click-to-display timings.

In Work, search filters the loaded issues
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
width determines the layout. The smallest panes
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
