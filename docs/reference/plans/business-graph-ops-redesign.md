# Business Graph OPS redesign

Status: direction approved, ready for implementation

Supersedes the visual and interaction direction of
[business-graph-experience-redesign.md](business-graph-experience-redesign.md)
where they conflict. The Scan → Peek → Focus rhythm, the bounded ontology,
GraphStore, scopes, and all tool surfaces are unchanged — this plan reshapes
how the app looks, reads, and routes work.

## Why this plan exists

Three iterations of graph UI drifted into the same attractor: a calm,
editorial "precision instrument" — tasteful, quiet, and wrong for the job.
Symptoms in the current build:

- board cards disappear on hover (hover background equals column background);
- priority — the primary triage signal — is a dropdown pinned to the card's
  bottom edge;
- every card renders its machine id, which carries zero information;
- AI collaboration is a sparkle button with suggestion chips, consumer-SaaS
  chrome on top of what is actually a CLI-agent architecture;
- the whole surface feels like a dashboard for looking at, not a workhorse
  for working in.

The graph app is used every day, all day, by a small AI-native HEOR
consultancy. Functionality outranks form, decisively. The goal is not calm;
the goal is **legible under load**.

### Banned vocabulary

These words describe the failed direction. Do not use them in specs, code
comments, class names, or copy for this surface, and treat their appearance
in a proposal as a drift signal:

`calm` · `precision` · `instrument` · `editorial` · `elevated` · `hero` ·
`clean` · `minimal` · `delight`

### What this is not

- Not a unix shell. Fixed-row TUI cosplay wastes the modern UI toolkit.
- Not a cockpit. No lit lamps, no bezel theater, no semaphore color.
- Not a spreadsheet. Gridlines-everywhere brutality was considered and cut.
- Not a chat product. No AI chat surface anywhere, ever. CLI agents running
  as Activities are the intelligence; the app renders the blackboard both
  humans and agents write to.

## Stance: a dispatch desk

The working metaphor is a **dispatch desk**: agents file work around the
clock, the human keeps overview, contributes, monitors, and intervenes.
Bloomberg's real lesson is not "looks like a terminal" — it is *one desk,
many tools*: one command grammar routing to several purpose-built surfaces,
each shaped like its job. Consistency comes from shared material, not from
forcing every surface into the same shape.

Agents are trusted by default. Their work is **not** gated behind
accept/reject review. The human's posture is awareness with the ability to
drill in and correct — not adjudication of a merge queue.

## Journeys

These six jobs drive every decision. Frequency and time budget are part of
the spec.

| # | Journey | Budget | Frequency |
|---|---|---|---|
| J1 | Catch up: what changed since I last looked | ~5 min | 2–3×/day |
| J2 | Work an issue: context → act or delegate | minutes | ~20×/day |
| J3 | Client on the phone: where does project X stand | 30 s | ~3×/week |
| J4 | Capture mid-flow, richer than I'd bother to type | 10 s | often |
| J5 | Monitor agent output, correct when needed | ambient | all day |
| J6 | Portfolio pulse: which engagements are at risk | 15 min | weekly |

## Architecture: four postures, one material

The app has four primary postures. Each existing section maps onto one;
nothing is removed, but the frame changes from "sections of a database" to
"jobs of a desk".

| Surface | Posture | Reading rhythm | Job |
|---|---|---|---|
| **Now** | read | wire | what changed, time-ordered, FYI |
| **Work** | operate | board | track and move issues spatially |
| **Projects** | compare | ledger | where engagements stand, aligned columns |
| **Lookup** | pit stop | spotlight | find a fact, gone in 3 seconds |

People, Companies, Knowledge, and All remain as directories and projections;
they inherit the material language and the list row grammar. Lookup's front
door is the dispatch bar, not a section.

## Now (home surface)

Now is the landing surface and answers J1/J5: *what happened, and does
anything wait on me.*

- A time-ordered stream of graph events: agent filings, status flips,
  decisions recorded, evidence captured, deliverables added, items that went
  overdue, waiting that cleared. Both agent and human authorship appear;
  provenance is a visible property of every line.
- **FYI by default.** One line per event; expand if curious; drill to Peek
  or Focus to correct. No accept/reject machinery, no unread-count
  obligation. A "seen" cursor (e.g., a divider at "since 08:40") replaces
  inbox-zero.
- **Waiting on you** pins at top: items blocked until the human answers or
  decides (agent flagged needs-detail, blocked_by you, waiting-on-you).
  This is information, not a gate.
- Wire rhythm: timestamps lead, events read like bulletins, thin time
  dividers. Exact grouping (per hour vs per day vs continuous) is an
  implementation decision — optimize for "catch up in one screen."
- Agent-produced content (a deliverable, a diff) is inspectable behind
  expand for spot checks. It is context, not a merge request.

## Work (board)

The board keeps kanban geometry — triage is spatial, and position carries
meaning (which column, where in it). Everything else about the card changes.

- **Rows, not cards.** Board items are fixed-geometry rows, two lines,
  roughly 40px (implementer tunes ±6px). List projections use the same
  anatomy at one line. Target ≥15 issues per column on a typical viewport.
- **Row anatomy** (applies to every list-like surface):
  - Priority in column zero as a glyph run (e.g., `!!!` `!!` `!`, blank for
    normal). Never a dropdown, never at the bottom. Settable by keyboard
    (e.g., `p` cycles).
  - Title, one line, Sans, truncated not wrapped. No summary, no tags, no id
    on the row — those live in Peek and provenance.
  - Metadata line in Mono: status as a fixed-width 3-letter code
    (`BCK PLN PRG WAT REV DON`) in list views (redundant on the board, which
    groups by status), project slug, due date as tabular `DD.MM`, flags
    (`W` waiting, `S` snoozed), author initials (humans and agents alike,
    e.g., `WK`, `CX`, `CL`).
  - Overdue dates take the theme's `rem` color **plus** a visible marker
    (e.g., a `!` suffix). Color never carries meaning alone.
- Rows sit directly on the projection canvas separated by 1px hairlines.
  There are no wells and no raised plates, so a row can never merge into its
  column. (The current disappearing-card bug dies structurally, not via a
  different hover color.)
- Hover: full-width band (chrome-mid) with full-ink text. Selected:
  accent-soft band. Hover signals state only — it never reveals content and
  never moves geometry.
- Mouse is first-class: drag between columns, shift-select for bulk
  property edits, inline date popover on the due field. Every action has
  keyboard parity (e.g., ←/→ to move a row between columns).

## Projects (portfolio)

Portfolio keeps its table bones and leans into the ledger posture: its job
is comparison.

- Strict column grid; numbers right-aligned in tabular Mono; project,
  company/scope, open/waiting/done, completion, connected knowledge, health.
- Health is computed state (overdue present, waiting stack, idle project),
  expressed with marker + word, not hue alone.
- Row height and padding serve scan speed, not touch targets; this is a
  desktop surface.
- Row → Peek; project Focus is the J3 surface: one screen that answers
  "where does this engagement stand" in 30 seconds — open/waiting/done,
  what is blocked and on whom, recent decisions, deliverables. This view is
  worth deliberate design attention; it is the client-on-the-phone view.

## Lookup

Lookup is a pit stop, not a journey: find an email, a role, a name.

- The dispatch bar doubles as the lookup front door. Typing without
  dispatching shows live results beneath the bar (Spotlight-style).
- Selecting a result opens Peek with the facts at the very top — for a
  person: email, phone, role, company — each one-click copyable. No
  scrolling, no Focus required.
- Directories remain for browsing; the bar is for finding.

## Dispatch bar

A permanent single-line bar at the bottom of the app. It is the only
terminal-shaped element, and it earns its place as the spine.

- **Default behavior: natural language dispatch.** Enter hands the line to
  a background CLI-agent Activity as a job. Dispatch never blocks; jobs
  queue; the user keeps typing. This is how capture works (J4): the agent
  files richly — summary, relations, labels, due dates, resolved references
  ("Jana" → person node) — producing issues richer than anyone would type.
- Each job carries the user's **current context**: active section, selected
  scopes, focused project or node. Terse input resolves against what the
  user is looking at.
- Results land in **Now** as filed events. If the agent cannot resolve
  something it does not guess: the item arrives flagged *needs detail* and
  the fix is one Peek edit. No chat loop, no conversational UI.
- **Power lane:** a leading `/` runs a deterministic mimx command
  (e.g., `/board waiting`) with instant, unambiguous execution and plain
  unix-style errors. Never required, always available.
- **Echo:** GUI mutations print their mimx equivalent into the bar's
  scrollback, dimmed. The UI continuously teaches the CLI grammar.
- The delegate flow (today's Start Work) lives here: `!` or `work <node>`
  expands the command with scopes and context budget, shows the context
  pack ("what the agent will see") in Peek, launches on Enter. The existing
  preparation dialog and its suggestion chips are retired.

## Status rail

A narrow fixed rail at the left edge of the graph app: the always-on
system-state column. Five to seven numerals with micro labels, stacked —
indicatively: **waiting on you**, overdue, waiting, due within 7d, agents
active, diagnostics.

- Each numeral is a button: click (or its chord) filters the main field to
  exactly that set. Any alert → its list in one action.
- Color is purposeful and rare: `overdue` numeral takes `rem` when > 0,
  `agents` takes accent when > 0; everything else stays ink. Exact set and
  order of readouts is an implementation decision.

## Material language

Shared across every surface; this is what makes one desk of many tools.

- **Type:** IBM Plex everywhere. Titles Sans (~12px), metadata Mono
  (~10px), micro labels uppercase letterspaced Mono. Tabular numerals for
  all data columns.
- **Geometry:** hairline rules, 0–2px radius, no shadows except functional
  overlays. Square belongs to work surfaces; dialogs may keep their
  rounding.
- **Color:** rare and purposeful. Accent = current selection and active
  agents. `rem` = overdue and diagnostics. Everything else uses the ink
  hierarchy. Never color as the sole carrier of meaning. No colored left
  borders anywhere, ever (house rule).
- **Themes:** all eight themes are first-class. Nothing in this design
  depends on darkness; every rule above is token-driven.
- **Feel test:** a screenshot should look like work in progress, not a
  marketing shot. The app should look best at hour six of a workday.

## Interaction grammar

- Mouse first-class; every action has keyboard parity. Chords are
  implementation decisions, but the set must cover: row navigation,
  open/peek/focus, move between columns, cycle priority, set due, dispatch,
  jump to each rail filter.
- Scan → Peek → Focus is unchanged as a rhythm. Peek stays read-first with
  quick properties; Focus is the deep-work surface (J2) and hosts the
  delegate flow's context-pack preview.
- Context trail, GraphMap, Timeline, and directories remain; they adopt the
  row grammar and material language where they render lists.

## Invariants

Budgets the design must hold; treat as acceptance criteria.

- ≥15 issues visible per board column; ≥25 rows per list view
- Any rail alert → its filtered list in ≤1 click or key
- Any property change ≤2 keys, no dialog required
- Capture never blocks and never opens a dialog
- Project status (J3) answerable in ≤30 s from anywhere in the app
- Hover never erases surface separation; no geometry shifts on hover
- Zero AI chat surfaces; zero sparkle/chip AI chrome

## Hard rules

1. No colored left borders or left-edge classification devices, anywhere.
2. No node ids on rows or cards; ids live in Peek and provenance.
3. Priority leads (column zero); never buried, never only a dropdown.
4. Color always paired with glyph, label, or position.
5. Agents appear as authors and processes (initials, rail count, Now
   events) — never as an assistant persona.

## Open decisions (for implementers)

Intent is fixed; these specifics are deliberately left to the coding
agents, to be settled in the component work and reviewed against the
invariants:

- exact row metrics, truncation points, and metadata column widths;
- the priority glyph run and status code set (keep fixed-width and
  theme-proof);
- Now grouping granularity and seen-cursor presentation;
- rail readout set, order, and width;
- the full chord map;
- dispatch job concurrency model (single queued runner vs parallel
  Activities) — start simple, one durable runner;
- how bulk selection composes with board drag;
- per-theme tuning of the two functional colors.

## Relationship to existing docs

- [business-graph.md](../business-graph.md): ontology, scopes, projections,
  and tool surfaces unchanged. Interaction-design sections describing card
  layout, the Start Work dialog, and hover behavior are superseded by this
  plan.
- [design-system.md](../design-system.md): its "instrument, not dashboard"
  and "stays calm" language describes the rejected direction and should be
  revised when this lands — the principles here (legible under load, color
  as rare signal, material over skin) are the successor.
- [business-graph-experience-redesign.md](business-graph-experience-redesign.md):
  superseded as visual direction; its Scan → Peek → Focus architecture is
  retained.

## Suggested build order

1. **Work board rows** — row anatomy, hover fix, priority col-0, id removal.
   Highest daily impact, self-contained.
2. **Status rail + Now skeleton** — rail filters over existing projections;
   Now fed by graph change events (both agent and human authored).
3. **Dispatch bar** — lookup first (live results, Peek facts), then agent
   dispatch with current-context jobs, then `/` power lane and mimx echo.
4. **Portfolio ledger polish + project Focus (J3 view).**
5. **Delegate flow in the bar**, retiring the sparkle dialog.
6. Directories, Timeline, GraphMap inherit the material language.

Each step must hold the invariants and pass the feel test on all eight
themes.
