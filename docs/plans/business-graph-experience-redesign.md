# Business Graph experience redesign

Status: implementation contract

## Outcome

The Business Graph is a precision developer tool for operating a consultancy's
collective intelligence. It combines the immediacy and interaction quality of
Linear, a restrained measure of Bloomberg Terminal's persistent operational
density, graph-native context, and explicit AI handoff.

This is not a visual reskin. It replaces the current dense form-and-panel model
with a single coherent interaction architecture:

1. **Scan** — projections show only the information needed to recognize,
   compare, and act.
2. **Peek** — selection opens a read-first, low-friction context surface without
   losing the originating projection.
3. **Focus** — deliberate editing opens a spacious object workspace with one
   primary scroll and a syntax-aware Markdown editor.

No graph field is removed. Infrequent fields move behind progressive
disclosure; long text moves to Focus; quick properties remain directly
editable.

## Visual contract

### Character

- internal operational instrument used all day
- restrained, sharp, and information-dense
- software-native, not editorial or academic
- usefulness before decoration or client-facing polish
- quiet by default; color only encodes state, scope, or action
- readable density, never miniature forms
- never use a colored left edge or left-border classification device
- never reveal decision-critical information by changing geometry on hover

### Theme-native palette

The application inherits Mimir's light and dark themes. These reference colors
describe the intended relationships rather than introducing hard-coded theme
values:

| Name | Light reference | Purpose |
| --- | --- | --- |
| Porcelain | `#F7F8FA` | projection canvas |
| Paper White | `#FFFFFF` | elevated working surfaces |
| Graphite | `#171A21` | primary ink |
| Slate | `#697180` | secondary ink |
| Signal | `#5B67F1` | selection, focus, and primary action |
| Semantic | theme tokens | success, attention, danger only |

Borders are neutral separators, not classification accents or boxes around
every field. Shadows are limited to functional overlays. Accent is scarce.

### Type and geometry

- Mimir's sans is the interface and reading face.
- Mimir's mono is reserved for IDs, scope paths, revisions, metadata, and
  keyboard hints.
- Body text does not drop below 11px; core labels and controls target 12–13px.
- Working surfaces use 0–3px corners; ordinary controls may use up to 5px.
  Semantic values normally remain plain text rather than pills.
- Primary controls are at least 30px high; icon-only targets are at least 28px
  and always have an accessible name.
- Spacing follows a 4px base rhythm with 8/12/16/24/32px structural steps.

### Signature interaction: the relationship sentence

Every Peek and Focus view turns relevant edges into a readable sentence:

> This issue belongs to **Project Atlas**, is assigned to **Alex**, and blocks
> **Evidence synthesis**.

Entity fragments are navigable. The sentence is the graph's everyday identity:
it makes relationships understandable without forcing users into a global
hairball. A dedicated map remains available for exploration.

## Interaction contract

### Global

- `/` focuses graph search.
- `N` opens quick creation outside a text editor.
- `Escape` closes the topmost menu, dialog, Peek, or Focus layer.
- `Enter` opens the selected scan item.
- `F` promotes Peek to Focus when an object is selected.
- `Cmd/Ctrl+S` explicitly saves in Focus; autosave remains a safety net.
- All menus are polished Vue listboxes or menus. Native `select` and `datalist`
  are forbidden.
- Search, scope, section, view, sort, filter, and selection state preserve
  context across Peek and Focus.

### Scan

- Lists and portfolios are operational rows. Boards use fixed-height cards.
  CRM and project overviews use tables and data strips rather than presentation
  tiles.
- A scan object exposes at most one direct property control by default.
- Decision-critical card properties and actions are always visible. Hover may
  change only a neutral background, border, or text color; it never reveals
  content, changes size, lifts a surface, scales it, or adds a shadow.
- Empty, loading, searching, filtered-empty, error, and no-workspace states
  explain the next useful action.

### Peek

- Read-first surface; no permanent wall of inputs.
- Shows identity, status, summary/working-note preview, relationship sentence,
  relevant activity, deliverables, and provenance.
- Quick status/priority changes are allowed for issues.
- The primary actions are Focus and Start work.
- Destructive and infrequent actions live in a clearly labelled overflow area.

### Focus

- Replaces the projection area rather than nesting a form inside a narrow rail.
- One page scroll; no nested three-row text scroll areas.
- Title is large and auto-growing.
- Markdown is edited in CodeMirror with syntax highlighting, line wrapping,
  history, and accessible keyboard behavior.
- Common properties are visible in a calm property row.
- Dates, reminders, waiting/snooze state, tags, labels, deliverables, and
  provenance are grouped into purposeful sections.
- The relationship sentence and related objects remain visible without opening
  another mode.
- Save state is explicit: Saving, Saved, Unsaved, Conflict, or Error.

## Exhaustive surface and control inventory

Every interactive element receives a stable `data-graph-control` identifier.
The UI contract test validates the required identifiers and bans native
dropdowns.

### Application shell

| Control/state | Required redesign behavior |
| --- | --- |
| product identity | simple graph mark, “Business graph”; no “Field atlas” |
| section switcher ×6 | readable labels and counts; active state without icon noise |
| command/search input | primary global control; clear, searching, empty-result states |
| scope trigger | shows active visibility in plain language |
| scope option ×N | custom checkbox menu; scope kind, path, count, selected state |
| refresh | icon-only with tooltip, disabled and busy states |
| create | primary labelled action with shortcut |
| view switcher ×section | compact segmented navigation with active state |
| result count | human-readable count, filtered distinction |
| error/retry | persistent, non-destructive recovery |
| loading | restrained skeleton/progress state |
| no workspace/choose folder | clear single action |
| diagnostics | visible when non-zero, navigable |
| undo deletion | status announcement, Undo, timeout |
| footer health | node count, scopes, revision without visual dominance |

### Work projection

| Control/state | Required redesign behavior |
| --- | --- |
| group menu | custom menu; Status/Project |
| sort menu | custom menu; Priority/Due/Updated/Title |
| priority filter | custom menu; All/Urgent/High/Normal/Low |
| visible columns menu | custom checklist; only for status grouping |
| column header ×N | status/project, count, quiet add action |
| card ×N | fixed height; title, project, ID, summary, tags, due/attention, assignee, and persistent controls |
| card open | mouse, Enter, and accessible name |
| card move | drag/drop plus Left/Right keyboard equivalent |
| quick priority | explicit menu/action, not unexplained cycling |
| quick status | custom menu when board is grouped by project |
| quick due date | normal readable action/popover, never a 22px invisible date input |
| empty column add | one calm action |
| empty board | explain filters/scopes and offer New |

### Other scan projections

| Projection | Required content and controls |
| --- | --- |
| entity list | selected row, type, title, useful summary, scope, meaningful state |
| portfolio | project identity, health explanation, open/waiting/done, company, scope |
| CRM | company identity, people/projects/open work, next contact, empty state |
| timeline | readable month rail, object type/title/state, unknown-date group |
| relationship map | purpose label, nodes/edges, pan, zoom in/out/reset, empty state |

### Quick creation

| Control/state | Required redesign behavior |
| --- | --- |
| kind | searchable custom listbox with known ontology |
| scope | custom listbox with private/project/team meaning |
| title | first focus, strong readable input |
| issue status | custom listbox |
| issue priority | custom listbox |
| summary | progressive context area for non-issues |
| tags | progressive context area with clear parsing |
| working note | progressive, spacious syntax-aware Markdown editor |
| create another | custom checkbox treatment |
| cancel/close/Escape/backdrop | predictable dismissal |
| submit | entity-aware label, disabled, saving, and error states |

### Peek

| Control/state | Required redesign behavior |
| --- | --- |
| close | returns exactly to scan origin |
| source | opens Markdown source |
| Focus | promotes to full object workspace |
| Start work | assembles bounded scoped graph context |
| quick status/priority | issue-only, quiet custom controls |
| relationship entity ×N | navigates while extending context trail |
| related Activity ×N | opens Activity |
| deliverable ×N | opens file |
| next action | issue-only related creation |
| record decision | project-only related creation |
| delete | explicit danger zone/overflow |
| conflict | readable recovery guidance |
| source metadata | scope, updated, revision, path |

### Focus

| Control/state | Required redesign behavior |
| --- | --- |
| back to projection | restores Peek/scan context |
| close object | returns to originating projection |
| title | auto-growing input; no two-row scroll |
| status/priority | issue-only custom controls |
| project/assignee | searchable custom controls |
| due/reminder | readable date/datetime controls |
| waiting/snooze | grouped attention controls |
| summary | spacious for non-issues |
| tags/labels | readable, labelled inputs |
| deliverables | structured rows or spacious multiline source |
| working note | large CodeMirror Markdown editor |
| relationship sentence | navigable relation fragments |
| Activities | navigable list |
| source/provenance | low-noise details |
| Save | disabled/saving/saved/dirty/error states |
| delete/start/next/decision | same semantics as Peek |

## Verification gates

### Build gate

- targeted Business Graph unit/component tests
- complete frontend test suite
- production build
- Rust Business Graph tests and complete Rust test suite
- documentation checks

### Review round 1 — exhaustive coverage

Check every inventory row in every applicable state. Search the source for
native selects, datalists, undersized controls, fixed low-row textareas,
unlabelled icon buttons, stale “Field atlas” language, and legacy inspector
styles. Fix every omission before proceeding.

### Review round 2 — holistic product quality

Run representative journeys:

1. find an issue → Peek → change status → Focus → edit Markdown → save
2. inspect a project → understand company, work, and evidence context → record a
   decision
3. create private knowledge → relate it to a project → start scoped AI work
4. scan CRM → open contact → traverse relationship sentence → return to origin
5. filter/reorder the board → move work by mouse and keyboard → undo deletion
6. explore a purposeful map → zoom/pan/open → return with context preserved

Critique hierarchy, reading sizes, click count, keyboard speed, spatial
continuity, scroll ownership, theme behavior, motion, empty/error states, and
cross-projection consistency. The round is complete only after its fixes are
retested.

## Review log

### Round 1 — exhaustive coverage

Completed 2026-07-26.

The source inventory and state-by-state component review found and corrected:

- missing next actions in empty board, portfolio, CRM, timeline, and map states;
- errors that previously escaped to a global diagnostic instead of remaining in
  Create, Focus/Peek, or Start work;
- a missing Knowledge section count;
- native date and datetime pickers in board and issue workflows;
- missing outside-click dismissal for scope and column menus;
- missing dialog focus containment and focus restoration;
- core field and section labels that remained smaller than the redesign
  contract;
- an autosave race that could lose the last edit when closing, traversing a
  relation, changing section, following a breadcrumb, or opening another card;
- interactive elements without a mechanically auditable control family.

Verification after the fixes:

- UI inventory and dense-control regression contract passes;
- Business Graph component, dialog, date, keyboard, store, service, CLI, and
  Workbench integration tests pass;
- complete frontend suite passes: 116 files, 1,047 tests;
- production frontend build passes.

Round 2 remains intentionally separate and evaluates complete journeys and
holistic product quality rather than element presence.

### Round 2 — holistic product quality

Completed 2026-07-26.

The six representative journeys were reviewed as complete interaction chains,
including the state changes between their individual surfaces. This review did
not use the live desktop window because concurrent coding agents continuously
reload it; it used deterministic component journeys, store behavior, source
inspection, and production builds instead.

The journey review found and corrected:

- the remaining browser-native delete confirmation, replacing it with a
  focused, keyboard-contained, recoverable in-product action;
- save-before-transition gaps for refresh, physical-scope changes, projection
  changes, numeric section shortcuts, source/deliverable navigation, Activity
  navigation, AI work, quick creation, and deletion;
- a post-save revision edge case in deletion, which now resolves the current
  selected revision at commit time;
- the missing authoring half of the relationship experience: Focus now offers
  a small ontology-bounded connection composer for `works_at`, `for_company`,
  `has_contact`, `blocked_by`, `depends_on`, `introduced_by`, `references`, and
  `related_to`, while issue Project and Owner remain purpose-built fields;
- weak project-dashboard knowledge context: portfolio rows now show connected
  evidence, decisions, and other knowledge alongside company, work, health,
  and completion;
- a Peek action menu that did not dismiss on outside interaction;
- undo failures that escaped the action surface instead of offering a local
  retry;
- remaining seven- and eight-pixel interface text, establishing nine pixels as
  the absolute metadata floor and keeping primary reading text larger;
- the browser-default disclosure marker on source provenance, replacing it
  with a themed, focus-visible control;
- view changes that could appear to succeed behind Peek and then revert to the
  original projection when the inspector closed.

The journey suite now covers scan → Peek → Focus, Markdown save, revision-safe
refresh and scope composition, private-object relationship authoring,
project-to-decision creation, bounded AI context launch, CRM relations,
mouse/keyboard board movement, recoverable deletion, map keyboard opening, and
projection-origin restoration.

Verification after the round-two fixes:

- Business Graph UI contract and focused frontend journeys pass: 8 files,
  38 tests;
- the production frontend build passes;
- no native select, datalist, date/datetime input, browser confirmation,
  fixed two-to-four-row textarea, or sub-nine-pixel text remains in the audited
  Business Graph surfaces.

### Operational-instrument correction

Completed 2026-07-26 after direct product-owner critique.

The first implementation still carried consumer-dashboard habits. This
correction removed them at the contract level:

- every colored left edge was removed from cards, selected rows, object
  identity, map nodes, and Markdown quotes; the automated contract now forbids
  `border-left` and `border-inline-start` across the Business Graph;
- Kanban cards use fixed geometry, keep priority/status/due controls visible,
  and never expand or reveal controls on hover;
- hover feedback is limited to useful background, border, or text-color
  changes; hover transforms, scaling, filters, and shadows are forbidden;
- Portfolio changed from lifting presentation tiles to a dense operational
  table with persistent company, work, completion, knowledge, and health data;
- decorative empty-state diagrams, background gradients, glass blur, large
  radii, chips, and card-lift shadows were removed;
- the map, CRM, lists, timeline, inspector, menus, calendars, and dialogs were
  flattened into the same disciplined workbench geometry;
- regression tests forbid the rejected primitives so later agents cannot
  silently reintroduce them.

### Final verification

Completed 2026-07-26 after both review rounds and the operational-instrument
correction:

- complete frontend suite: 126 files, 1,131 tests;
- complete Rust suite: 299 library tests and 3 wire-contract integration
  tests;
- production frontend build;
- Business Graph stability contract covering fixed Kanban geometry, persistent
  controls, operational Portfolio rows, and rejected consumer primitives;
- Rust formatting check;
- documentation check across 30 Markdown files;
- Tauri command drift check;
- whitespace/error-marker diff check across the redesigned and documented
  surfaces.
