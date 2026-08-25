# Design system

This document defines the current visual and interaction rules for Mimir.
[workbench-design.md](workbench-design.md) defines the shell-specific layout.

## Design stance

Mimir is the visual form of ASD-STE100: direct, controlled, and unambiguous.
Each element has one job. Position, spacing, type, and restrained signals make
the interface clear before decoration does. Familiar words state what happened
and what the user can do next.

The intended response is: “Wow, that is working surprisingly great.” This
response must come from speed, predictability, and useful details that appear at
the correct time. It must not come from cuteness, novelty, ornamental motion, or
extra interface language.

- Remove an element before adding another explanation.
- Group controls by the thing they affect, and separate groups with structure.
- Keep inactive information quiet; make selected, changed, or actionable state
  clear without making it loud.
- Prefer one precise word, value, or hairline over an illustrative icon when the
  icon adds no meaning.
- Make advanced behavior feel obvious after one use and dependable thereafter.

## Principles

- Every property change has an on-surface control; chords accelerate, never gate.
- No hidden/sticky filters; every active filter named, announced, one-click cleared.
- Spell states out (`overdue`, `waiting`, `due 7d`) except in the learned,
  fixed-position Activity meta instrument. Type floor: 9px UI, 10px row data.
- Color is paired with a glyph, word, or stable instrument position. Accent =
  selection/active agents; `rem` = overdue/diagnostics; rest is ink hierarchy.
- Hover: full-width `chrome-mid` band, full-ink text. Never reveals content, moves geometry, or erases surface separation. Selection: `accent-soft` band.
- Native desktop behavior: fast hover, visible keyboard focus, stable geometry.

## Business graph material

See [business-graph.md](business-graph.md) for the dispatch-desk model and
graph ontology.

- Titles: system UI ~12px. Inspector metadata labels and values use the same
  system UI face; dates use tabular numerals without changing typeface. Reserve
  monospace for paths, code, and other technical values. Micro labels outside
  the inspector can use uppercase letterspaced mono at 9px or larger.
- Rows on projection canvas separated by 1px hairlines — no wells, no raised plates.
- Radius 0-2px; no shadows except functional overlays; no gradients.
- Inspector (Peek/Focus) property controls are ghost fields: borderless and
  transparent at rest, `chrome-mid` wash on hover, accent ring on focus,
  radius 0-2px. Primary metadata uses one label/value grammar in both modes:
  sentence-case labels, aligned values, one font family, and one spacing scale.
  Do not rely on a current value to explain an editable control. Keep accessible
  names in addition to visible labels. No character counters, duplicate state
  banners, raw object ids, or source revisions. The working note is unframed
  document text, not a boxed textarea. Boxed fields remain correct inside
  dialogs (create, summarise).
- **Banned**: colored left borders, left-edge classification devices, ALL-CAPS kicker mastheads, lit lamps, blinking flags, meter bars, reverse video, ASCII ornament, sparkles, suggestion chips, hover transforms, AI chat surfaces. Agents appear as authors/processes (initials, active count, events in Changes) — never personas.

## Tokens

Tailwind tokens are defined in `src/shared/styles/app.css`. Theme overrides live
in `src/shared/styles/themes.css`.

### Surfaces

| Token | Role |
|---|---|
| `bg-chrome` | outer window frame and darkest shell chrome |
| `bg-chrome-mid` | intermediate controls, tab areas, hover layers |
| `bg-chrome-high` | pane chrome and instrument surfaces |
| `bg-surface` | editor, terminal/app canvas, dialogs, inputs |

### Text

`text-ink` through `text-ink-4` form a contrast hierarchy from authored or
primary text to quiet metadata. Do not invent ad-hoc gray values.

### Signals

- `accent` and `accent-soft`: selection, current state, focus, primary action
- `add`: successful state and inserted diff content
- `rem`: failure state and removed diff content
- `attn`: orange intervention marker
- `info`: blue unread/new-information marker
- `rule` and `rule-light`: major and row-level structure

### Themes

The `data-theme` values are `parchment`, `studio`, `glacier`, `slate`,
`monokai`, `dracula`, `zenith`, and `synthwave`. Display labels are defined in
`src/shared/ui/settings/AppearanceSection.vue`.

Every theme must preserve token roles and contrast relationships.
Against every theme surface, `ink-3` has a minimum 5:1 contrast ratio and
`ink-4` has a minimum 4.5:1 ratio. Small metadata must remain readable at the
default interface zoom; quiet means subordinate, not faint.

## Type

Active stacks are defined in `src/shared/styles/app.css` and
`src/shared/fonts.js`:

| Role | Family |
|---|---|
| UI, status, and prose | native system UI |
| paths, code, terminal, flags, metadata | native system monospace |
| Editor authoring and diff text | bundled Commit Mono variable font |

There is no serif choice. Editor font choices are the single source in
`src/shared/fonts.js`; an old saved `serif` preference migrates to system Sans.
System Mono and Sans remain selectable alternatives. Unused IBM Plex Sans and
Mono faces remain in `fonts.css` only as reversible experiment assets and are
not selected by active tokens. UI type is usually 9–13px. Metadata may be
uppercase only when short; sentences remain normal case. See
[editor-system.md](editor-system.md#codemirror-surface) for Editor typography.

## Components

### Pane chrome

Pane headers use consistent height, alignment, navigation, restore/collapse
controls, and one-pixel dividers. Resize targets are wider than their visible
hairline and lift to accent on hover.

### Rows

Sidebar, Files, Apps, and Routines rows use full-width hover backgrounds.
Selection uses `accent-soft`, not an accent-filled card. Primary labels use
Sans at 12px; paths, time, schedule, and status detail use Mono at 9px or
larger. Sidebar rows are 32px high; denser Files rows are 28px high.
Activity rows reserve the right meta position for the working grid or one
signal dot plus compact relative time. Activity identity icons have no status
overlays.

### Buttons and inputs

- Every clickable control has a visible hover change.
- Focus rings use `focus-visible:ring-1 focus-visible:ring-accent`.
- Disabled controls remain legible and do not respond to hover.
- Filled accent buttons are reserved for the primary action in a local flow.
- Inputs use surface background, a rule border, and accent focus.
- Every `<input>`/`<textarea>` sets `autocorrect="off" autocapitalize="off"`;
  add `spellcheck="false"` too unless the field holds prose.
- Never use a native/system `<select>`. Selection controls use a Mimir-owned
  combobox and listbox popover styled with theme tokens. They expose an
  accessible name and selected state, and support Arrow keys, Home/End,
  Enter/Space, Escape, and Tab without trapping focus.
- Dialogs and popovers may be rounded; workbench panes remain square.

### CodeMirror and xterm

Their DOM sits outside ordinary Vue utility styling. Shared bridge styles belong
in `src/shared/styles/editor-content.css` and component `:deep()` rules.
Terminal colors derive from current theme tokens.

## Styling rules

Use semantic utilities such as:

```html
class="border border-rule bg-chrome-high text-ink-2 hover:bg-chrome"
```

Do not use raw `var(--color-*)` values in templates when a Tailwind token
exists. Component CSS is appropriate for vendor prefixes, dynamically rendered
content, complex widget states, and keyframes.

The base button reset must remain inside `@layer base`; otherwise it overrides
Tailwind utilities.

## Interaction and accessibility

- Native UI is non-selectable; text inputs, CodeMirror, terminal content, code,
  and preformatted content opt back into selection.
- Controls have accessible names; tooltips may reinforce but never carry
  meaning alone.
- Keyboard collections expose selection and Enter activation.
- Use `aria-live` or status roles for asynchronous feedback.
- Reduced-motion variants are optional, not a product requirement.
- Never encode status by color alone; pair it with label, shape, title, or
  position.
