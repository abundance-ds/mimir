# Business Graph OPS redesign

Status: **implemented and corrected by owner review.** Read the addendum
first — it overrides §7/§8 and parts of §11/§12.

## Owner correction pass (verdicts, absolute)

After the full build order landed, the owner reviewed and issued these
verdicts. They supersede the plan wherever they conflict:

1. **The status rail is permanently dead.** It was built exactly to the §8
   corrections and the owner rejected it again on sight: counts without a
   surface are furniture. The autopsy's "rail feels useless" was never an
   implementation problem — the *concept* is dead. **Do not rebuild a rail,
   counts strip, or status sidebar in any form, ever.** Now pins
   waiting-on-you; the board shows work state; that is enough.
2. **The graph/relationship map view is dead** ("3 columns and rounded
   edges — why?"). `GraphMap.vue` is deleted; do not resurrect node-edge
   canvases as a projection.
3. **People and Companies are not sections.** They merged into **All** with
   a visible kind filter (announced by the loud filter banner). Sections are
   Now / Work / Projects / Knowledge / All. `CrmView.vue` is deleted.
4. **Board readability outranks density targets.** Columns are 340px and
   priority icons 16px because titles must read in full. The §11 row anatomy
   stands; the §14 density budgets yield to "can I read it".
5. **Priority is an icon control**, per owner: antenna bars
   (`IconAntennaBars2/3/4` for low/normal/high) and a red `!`
   (`IconExclamationMark`) for urgent. The menu still spells all four out.
6. **Work is the startup surface.** Now shipped properly, but the day
   starts on the board (J2 ~20×/day beats J1 2–3×/day). Now stays section
   1 and one key away.

What survived review unchanged: the Now stream with seen cursor, the
dispatch bar (lookup / dispatch / delegate / power lane / echo), the loud
filter banners, the portfolio ledger, the project standing view, the §11 row
grammar, and every hard rule in §2.

---

Status: direction approved by owner; execution protocol defined; ready for
step 1 (Work board). **Read this whole file before writing any code.** It is
the single source of truth for taste, hard rules, and build order. It exists
because three previous attempts failed in instructive ways — the failures are
documented here so they are not repeated a fourth time.

Supersedes the visual and interaction direction of
[business-graph-experience-redesign.md](business-graph-experience-redesign.md)
where they conflict. Scan → Peek → Focus, the bounded ontology, GraphStore,
scopes, and all tool surfaces (`graph.*`, `knowledge.*`, `issues.*`,
`projects.*`, `research.*`, `mimx`) are unchanged.

Safety references:

- `cc41071` — full snapshot of the working state before this rebuild.
- `ba213c84` — the rejected OPS sprint (see autopsy below). Its
  `DispatchBar.vue` survives only in stash parent `ec970aa`.

---

## 1. Session lineage: three failures and what they taught

### Failure 1 — the "editorial precision instrument" drift (3 iterations)

Every design iteration converged to the same rejected aesthetic: calm,
typographic, "precision instrument" minimalism. Diagnosed causes, in order
of fixability:

1. **The repo primed it.** `design-system.md` said "Instrument, not
   dashboard", "Typography over decoration", "stays calm"; `business-graph.md`
   said "internal operational instrument". Agents echoed the docs back.
2. **Reference laundering.** "Bloomberg terminal" got interpreted as its
   tasteful mood-board subset (mono + tabular numerals), not the real thing
   (dense, loud, purpose-built panels). Same for TE/Braun.
3. **Tasteful-mean regression.** "Calm precision" is the lowest-risk way for
   an agent to signal competence; character gets optimized away iteration
   over iteration.
4. **"Functional" mistranslated as "minimalist".** Real workhorse density is
   visually loud (trading desks, Excel, radar). The goal was never calm —
   it is **legible under load**.

### Failure 2 — the TUI overcorrection

The corrective swung to all-in terminal cosplay (fixed rows, all-mono,
minibuffer, reverse video). Owner's correction, verbatim in spirit:
*Bloomberg is a terminal but doesn't try to work like a unix shell with
fixed rows.* The lesson extracted: Bloomberg's real architecture is **one
command grammar routing to many purpose-built panels, each shaped like its
job** — not a uniform text grid. Design must start from user journeys, not
from an aesthetic.

### Failure 3 — the rejected OPS sprint (`ba213c84`)

A coding agent implemented the first version of this plan. The owner
rejected it as "totally shit" and rolled it back. The five complaints and
their confirmed code causes are the most valuable taste data we have —
see §10 autopsy. Headline lessons:

- **Invisible filters are the one unforgivable sin.** A sticky, silent
  `statusFilter` made the owner's issues "disappear" from the board.
- **Keyboard chords without visible controls are hostile.** Priority became
  click-to-cycle glyphs; date hid behind the `d` chord; the owner had to
  "go deep into the content" to change anything.
- **Cryptic is not dense.** Bare `W`/`S`/`?` flags and 8px dates read as
  noise. A tooltip is not UI.
- **Novelty-first sequencing kills trust.** The sprint built the shiny new
  surfaces and left the daily surface (the board) broken in its original
  ways.

## 2. Banned vocabulary and banned patterns

Words that signal drift into the rejected direction — never use in specs,
code, class names, or copy for this surface:

`calm` · `precision` · `instrument` · `editorial` · `elevated` · `hero` ·
`clean` · `minimal` · `delight`

Patterns that are banned outright:

- ALL-CAPS "kicker" labels (`NOW / GRAPH WIRE`) and theme-park mastheads.
- Code alphabets on first-contact surfaces (`NEW/UPD/STA`, `STR/RUN/YOU`,
  bare `W`/`S`/`?` flags). See rule 8 in §8.
- Type below 9px anywhere; row data below 10px.
- Lit lamps, blinking flags, bezel-button theater, htop meter bars, reverse
  video, ASCII ornament.
- Sparkles, suggestion chips, "assistant" personas, any AI chat surface.
- Colored left borders or left-edge classification devices (house rule,
  absolute).
- Hover that reveals content, moves geometry, or erases surface separation.

## 3. Stance: a dispatch desk

The working metaphor is a **dispatch desk**. Agents file work around the
clock; the human keeps overview, contributes, monitors, and intervenes.
One desk, many tools — consistency comes from shared material (type, rules,
color discipline), never from forcing every surface into the same shape.

AI posture for 2028, per owner:

- **We trust agents.** Their work is *not* gated behind accept/reject
  review. The human's posture is awareness with the ability to drill in and
  correct — FYI, not a merge queue.
- **CLI agents are the workhorse intelligence.** There is no chat bubble in
  this app, ever. Codex/Claude/Pi run as Activities; the app renders the
  blackboard (the Markdown graph) that humans and agents both write to.
- **Agents appear as authors and processes** — initials on rows, an active
  count, events in the stream — never as a persona.

Owner-endorsed summaries to hold onto: the app is "living state"; humans
need to keep overview, understand what is going on, contribute, monitor,
review. Functional requirements outrank form, decisively. The app is used
every day, all day. It should look best at hour six of a workday.

## 4. The feel test (apply before calling any step done)

1. A screenshot looks like **work in progress**, not a marketing shot and
   not a themed skin.
2. Everything on first contact is **self-explanatory without tooltips**.
3. Type is legible at arm's length at 100% zoom on a laptop display.
4. Color is rare enough that when it appears, it means something.
5. Nothing moved, hid, or demanded attention without a real event.
6. Check all eight themes; nothing in this design depends on darkness.

## 5. Journeys (the spec's backbone)

| # | Journey | Budget | Frequency |
|---|---|---|---|
| J1 | Catch up: what changed since I last looked | ~5 min | 2–3×/day |
| J2 | Work an issue: context → act or delegate | minutes | ~20×/day |
| J3 | Client on the phone: where does project X stand | 30 s | ~3×/week |
| J4 | Capture mid-flow, richer than I'd bother to type | 10 s | often |
| J5 | Monitor agent output, correct when needed | ambient | all day |
| J6 | Portfolio pulse: which engagements are at risk | 15 min | weekly |

## 6. Architecture: four postures, one material

Each surface gets the reading rhythm its job demands. The rhythm differs;
the material (§9) never does.

| Surface | Posture | Rhythm | Job |
|---|---|---|---|
| **Now** | read | wire | what changed, time-ordered, FYI |
| **Work** | operate | board | track and move issues spatially |
| **Projects** | compare | ledger | where engagements stand |
| **Lookup** | pit stop | spotlight | find a fact, gone in 3 s |

People, Companies, Knowledge, All remain as directories/projections sharing
the material language and the list row grammar.

### Now (home, J1/J5)

- Time-ordered stream of graph events: filings, status flips, decisions,
  evidence, deliverables, overdue crossings, waiting cleared. Agent and
  human authorship both visible; provenance is a property of every line.
- FYI by default: one line per event, expand if curious, drill to correct.
  **No accept/reject machinery, no unread-count obligation.** A seen cursor
  ("since 08:40"), not inbox-zero.
- **Waiting on you** pins at top: items blocked until the human answers or
  decides. Information, not a gate.
- Grouping granularity, seen-cursor presentation: implementation decision,
  optimize for "catch up in one screen".
- Needs the graph event log. The rejected sprint built a scope-filtered,
  redaction-tested events API in `src-tauri/src/business_graph/runtime.rs`
  (see `git show ba213c84:src-tauri/src/business_graph/runtime.rs`) —
  salvage the *approach*, review line by line; do not restore wholesale.

### Work (board) — step 1, spec in §11

### Projects (portfolio, J6/J3)

- Ledger posture: strict column grid, right-aligned tabular numerals;
  project, company/scope, open/waiting/done, completion, knowledge, health.
- Health is computed state expressed with marker + word, never hue alone.
- Project Focus is the J3 surface: one screen answering "where does this
  engagement stand" in 30 s — open/waiting/done, blocked on whom, recent
  decisions, deliverables. Give it deliberate design attention.

### Lookup (J4-adjacent)

- The dispatch bar doubles as the front door: typing without Enter shows
  live results under the bar (Spotlight-style); selecting opens Peek with
  facts at the very top — person: email, phone, role, company — each
  one-click copyable. No scrolling, no Focus.

## 7. Dispatch bar (build in step 3)

A permanent single-line bar at the bottom of the graph app. The only
terminal-shaped element; it earns its place as the spine.

- **Default: natural-language dispatch.** Enter hands the line to a
  background CLI-agent Activity as a job. Never blocks; jobs queue; the
  user keeps typing. This is capture (J4): the agent files *richly* —
  summary, relations, labels, due dates, resolved references ("Jana" →
  person node) — richer than anyone would type in a hurry.
- Each job carries the user's **current context**: active section, scopes,
  focused project/node. Terse input resolves against what is on screen.
- Results land in **Now** as filed events. If the agent cannot resolve
  something it does not guess: item arrives flagged *needs detail*; the fix
  is one Peek edit. No chat loop, no conversational UI.
- **Power lane:** leading `/` runs a deterministic mimx command
  (`/board waiting`) with plain unix-style errors. Never required.
- **Echo:** GUI mutations print their mimx equivalent into the bar
  scrollback, dimmed. The UI teaches the CLI grammar.
- **Delegate flow** (replaces Start Work / `GraphWorkDialog`, which is
  retired): `!` or `work <node>` expands with scopes and context budget,
  shows the context pack ("what the agent will see") in Peek, launches on
  Enter. No sparkle, no suggestion chips.
- The rejected sprint's `DispatchBar.vue` (556 lines) survives at
  `git show ec970aa:src/mim/apps/business-graph/DispatchBar.vue`. Mine it
  for ideas only; its visual language (mode codes, `ERR`, `GUI` badges) is
  the rejected costume.

## 8. Status rail (build in step 2, with these corrections)

A narrow fixed rail at the left edge: always-on system state. The sprint
version failed (§10); these are the corrected requirements:

- Readouts (indicative set): **waiting on you**, overdue, waiting, due
  within 7 days, agents active, diagnostics. Each a button.
- Labels must be legible: full words or unambiguous short forms
  (`overdue`, `waiting`, `due 7d`, `agents`, `diag`) — never cryptic codes
  (`YOU/OVER/AGNT`).
- Clicking a readout filters the corresponding surface **and announces it**:
  a named, dismissible banner on the filtered surface ("Showing: waiting ·
  ✕ clear"). No silent filters. No sticky state that survives invisibly
  across sections. Clicking the same readout again clears in place —
  never teleports the user to another section.
- Agents/diagnostics readouts open their content *as ordinary lists in the
  current surface*, never a modal hijack of the whole main area.
- Color: `overdue` numeral takes `rem` when > 0; `agents` takes accent when
  > 0; everything else ink.

## 9. Material language (shared, never varies per surface)

- **Type:** IBM Plex. Titles Sans ~12px; metadata Mono 10–11px; micro
  labels uppercase letterspaced Mono ≥ 9px. Tabular numerals for data.
  Floor: 9px UI, 10px row data. The current build's 8px micro-type was a
  named complaint.
- **Geometry:** hairline rules; 0–2px radius; no shadows except functional
  overlays. Rows sit directly on the projection canvas separated by 1px
  hairlines — no wells, no raised plates, so a row can never merge into its
  column (the original disappearing-card bug dies structurally).
- **Color:** rare and purposeful. Accent = current selection and active
  agents. `rem` = overdue and diagnostics. Everything else ink hierarchy.
  Never the sole carrier of meaning — always paired with glyph, word, or
  position. Tasteful additional hues are acceptable *only* with a clear
  job (owner's words).
- **Themes:** all eight first-class and equal.
- **Hover:** full-width `chrome-mid` band + full-ink text. Selected:
  `accent-soft` band. Hover signals state only.
- **Mouse first-class.** Every action also has a keyboard chord; every
  chord has a visible on-row control. Chords accelerate, never gate.

## 10. Autopsy of the rejected sprint (`ba213c84`)

Keep this section. These are the owner's five verbatim complaints mapped to
their confirmed causes. Do not reintroduce any of these patterns.

1. **"I need to go deep into the content to change a date, priority, or
   status."** Priority became a click-to-cycle glyph (`priorityGlyph`,
   "P to cycle") with no visible options; date hid behind the `d` chord;
   status only via drag/arrows. → Rule: *visible controls first; chords
   accelerate, never gate.*
2. **"ALL my issues are gone from work Board — 5 wait, 1 over, the
   rest???"** Clicking a rail readout set a sticky `statusFilter` and
   force-navigated (`applyStatusFilter` → `setSection('work');
   setView('list')`); the filter persisted invisibly on the board with no
   indicator and no obvious way to clear. → Rule: *no hidden or sticky
   filters; active filters are named, loud, one-click dismissible on the
   filtered surface. Data visibility is sacred.*
3. **"Date is super small, what does 'w' mean?"** 8–9px dates; flags as
   bare `<b>W</b>`/`<b>S</b>`/`<b>?</b>` with explanations only in `title`
   tooltips. → Rule: *cryptic is not dense; spell it out; a tooltip is not
   UI. 9px floor.*
4. **"The left rail feels totally useless."** 48px of cryptic codes whose
   click either hijacked the main surface (`SystemList` for
   agents/diagnostics) or silently filtered and teleported. → Rail
   corrected per §8.
5. **"SHIT FUCK… it is a shit app now!"** The aggregate of the above,
   shipped as one uncommitted 32-file ±1,680-line big-bang stash blob
   (its own backup lost `DispatchBar.vue`), while the board — the daily
   surface — kept its original flaws. → Rule: *one surface per commit;
   build order is enforced; nothing new until the board is fixed.*

Also recorded from the autopsy: dead CSS shipped
(`.event-row:has(.event-code:nth-child(2))`); three stacked micro-grids with
misaligned column templates in one view; old topbar + new rail + old cards
= three visual languages on one screen. Ship each surface *complete* in the
new material, or not at all.

What was right (salvage list): the Rust event-wire approach (scope-filtered,
redaction-tested); retiring `GraphWorkDialog`; `EntityList`'s row-grammar
*direction* (priority first, due state visible, author initials) — its
cryptic flags were the wrong part, not the grammar.

## 11. Step 1 spec: Work board rows (build this first, alone)

Current state of `src/mim/apps/business-graph/WorkBoard.vue` (715 lines):
already row-based (`board-row`) with glyph-only priority cycle, row date
picker (`GraphDatePicker variant="row"`, placeholder `—`), `!`/`W`/`S`/`?`
flags, author initials, bulk selection, drag with drop-before reorder,
`p`/`d`/arrow chords. It was judged "totally unusable" — do not reskin it;
rebuild the row to the spec below.

Row anatomy (two lines, ~40px, target ≥15 rows per column at 100% zoom):

- **Line 1 — priority control + title.**
  - Priority is a *visible control*, not a bare glyph: current priority
    rendered legibly (glyph or short word — implementation decision, but it
    must be self-explanatory on first contact; `normal` renders neutral,
    never a cryptic mark). Activating it opens a small menu listing all
    four priorities **spelled out** (Urgent / High / Normal / Low) with the
    current one marked. `p` cycles as an accelerator for the same action.
  - Title: Sans ~12px, one line, truncated not wrapped. No id, no summary,
    no tags on the row — they live in Peek and provenance.
- **Line 2 — metadata, Mono 10px, left to right:**
  - Project slug (spelled as the project's own title/slug; fine — it's the
    user's own vocabulary).
  - Status: only when grouped by project (on a status-grouped board,
    position *is* the status). Rendered as a spelled word or an established
    short form with an on-surface legend — no orphan codes.
  - Due date as `DD.MM`, opening the existing date picker on click (keep
    `GraphDatePicker`; make it legible, no `—` placeholder crypticism — an
    empty date shows nothing or a quiet "set date" affordance). Overdue =
    `rem` color **plus** the word `overdue` or a `!` suffix; due soon may
    get a quiet marker. Never color alone.
  - `waiting` spelled as the word (with the `waitingFor` target in Peek);
    drop the bare `S`/`?` flags from the row entirely — snooze and
    needs-detail live in Peek.
  - Author initials (human and agent) with the full name one click away in
    Peek.
- **Selection and hover** per §9. Bulk selection, drag-and-drop with
  drop-before reordering, and full keyboard parity (arrows move, `p`
  priority, `d` date, Enter open) stay — but every chord maps to a visible
  control.
- **Column chrome** ships in the same commit, same material: spelled column
  label, count, add button. No meter bars, no dots-only semantics.
- **Filters:** any active board filter (priority filter, column visibility)
  renders as a named, dismissible strip above the board. Hidden issues must
  always be explainable at a glance ("12 hidden by filter: priority ≥
  high · ✕").

Do **not** touch any other surface in step 1. No rail, no Now, no dispatch
bar, no shell restyle.

## 12. File map (current state, verified)

Renderer:

- `src/mim/apps/BusinessGraphApp.vue` (~1987 lines) — shell: topbar
  (brand, sections, search, scope menu, refresh, New), viewbar with board
  controls (group/sort/priority filter/columns), projection routing,
  Peek/Focus mount (`GraphInspector`), status bar, dialogs
  (`GraphCreateDialog`, `GraphWorkDialog` — to be retired in step 5,
  `GraphConfirmDialog`), undo toast. Sections come from
  `BUSINESS_SECTIONS` in the store.
- `src/mim/apps/business-graph/WorkBoard.vue` (715) — step 1 target; see §11.
- `src/mim/apps/business-graph/EntityList.vue` — list rows; row-grammar
  reference, same cryptic-flag disease; fix when its section comes.
- `src/mim/apps/business-graph/PortfolioView.vue` — ledger bones are good;
  step 4.
- `src/mim/apps/business-graph/GraphInspector.vue` (~2400) — Peek + Focus;
  hosts quick properties, relationship line, activities, Start Work button
  (retire in step 5). Peek must surface lookup facts (email/phone) at top.
- `src/mim/apps/business-graph/GraphSelect.vue`, `GraphDatePicker.vue` —
  existing custom controls; reuse for the priority menu and due control.
- `src/mim/apps/business-graph/NowView.vue`, `StatusRail.vue` — **orphans
  from the rejected sprint, unwired. Reference only; do not resurrect
  as-is.**
- `src/stores/businessGraph.js` — section/view state (currently defaults
  `section='now'`, `view='stream'` — reset default to `work`/`board` until
  Now ships properly), `BUSINESS_SECTIONS`, projection state.
- `src/services/businessGraph.js` — IPC/service layer to Rust tools.
- `src/mim/WorkbenchApp.vue` — mounts roots, owns the Start Work handoff.
- `src/shared/styles/themes.css` (8 themes), `app.css` (tokens),
  `src/shared/styles/fonts.css`.

Native:

- `src-tauri/src/business_graph/` — `model.rs` (ontology, DTOs),
  `markdown.rs` (loss-preserving serialization), `store.rs` (indexes,
  queries, mutations), `runtime.rs` (mounted roots, watchers,
  `mim://graph-changed`), `context.rs` (bounded agent context, redaction),
  `tools/` (registry). The rejected sprint's event log lived in
  `runtime.rs` — see §6 Now for salvage guidance.
- Golden fixtures: `src-tauri/tests/fixtures/business-graph/`.

Docs to reconcile when this lands: `docs/reference/business-graph.md`
(interaction sections), `docs/reference/design-system.md` (the "calm
instrument" language that primed failure 1 — revise to this plan's
principles).

## 13. Execution protocol (enforce strictly)

1. **One surface per commit, in the build order below.** Each commit must
   leave the app fully working and each surface *complete* in the new
   material — no half-styled grafts onto old chrome.
2. **Before calling a step done:** run it, look at it, apply the feel test
   (§4) on light and dark themes at minimum; run `npm test` and, if native
   code changed, `cargo test --manifest-path src-tauri/Cargo.toml`.
3. **Commit early, commit per step.** Never deliver a stash blob.
4. Build order:
   1. **Work board rows** (§11) — alone.
   2. **Status rail** (§8) + loud-filter banner infrastructure.
   3. **Dispatch bar** (§7): lookup first, then agent dispatch, then `/`
      lane + echo.
   4. **Portfolio ledger polish + project Focus (J3 view).**
   5. **Now stream** (§6) with the salvaged event-wire approach; retire
      `GraphWorkDialog` into the bar's delegate flow.
   6. Directories, Timeline, GraphMap inherit the material language;
      `EntityList` gets the §11 row grammar.
5. Hard rules from §2/§8/§9 are acceptance criteria, not guidelines:
   - no colored left borders; no ids on rows; priority leads and is a
     visible control; color never alone; 9px type floor; no code alphabets
     on first contact; no hidden filters; no AI chat or sparkle chrome;
     hover never erases separation.

## 14. Invariants (acceptance budgets)

- ≥15 issues visible per board column; ≥25 rows per list view
- Any property change ≤2 keys **with a visible control for the same action**
- Any active filter explainable at a glance and cleared in 1 click
- Any rail alert → its (announced) filtered list in 1 click or key
- Capture never blocks and never opens a dialog
- J3 answerable in ≤30 s from anywhere
- Zero AI chat surfaces; zero sparkle/chip chrome

## 15. Open decisions (for implementers)

Intent is fixed; settle these in component work, reviewed against the
invariants and the feel test:

- priority rendering (icon set vs short words) — must be self-explanatory
  on first contact; `normal` neutral;
- exact row metrics, truncation points, metadata column spacing;
- Now grouping granularity and seen-cursor presentation;
- rail readout set/order/width (labels per §8);
- the chord map (must mirror visible controls);
- dispatch job concurrency — start simple: one durable background runner;
- bulk-selection composition with board drag;
- per-theme tuning of the two functional colors (accent, rem).
