# Design system

This document defines the current visual and interaction rules for Mimir.
[workbench-design.md](workbench-design.md) defines the shell-specific layout.

## Principles

- Every property change has an on-surface control; chords accelerate, never gate.
- No hidden/sticky filters; every active filter named, announced, one-click cleared.
- Spell states out (`overdue`, `waiting`, `due 7d`). Type floor: 9px UI, 10px row data.
- Color never sole meaning carrier — always paired with glyph, word, or position. Accent = selection/active agents; `rem` = overdue/diagnostics; rest is ink hierarchy.
- Hover: full-width `chrome-mid` band, full-ink text. Never reveals content, moves geometry, or erases surface separation. Selection: `accent-soft` band.
- Native desktop behavior: fast hover, visible keyboard focus, stable geometry.

## Business graph material

See [business-graph.md](business-graph.md) for the dispatch-desk model and
graph ontology.

- Titles: system UI ~12px. Metadata: system mono 10-11px, tabular numerals. Micro labels: uppercase letterspaced mono >= 9px.
- Rows on projection canvas separated by 1px hairlines — no wells, no raised plates.
- Radius 0-2px; no shadows except functional overlays; no gradients.
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
- `rule` and `rule-light`: major and row-level structure

### Themes

The `data-theme` values are `parchment`, `studio`, `glacier`, `slate`,
`monokai`, `dracula`, `zenith`, and `synthwave`. Display labels are defined in
`src/shared/ui/settings/AppearanceSection.vue`.

Every theme must preserve token roles and contrast relationships.

## Type

Active stacks are defined in `src/shared/styles/app.css` and
`src/shared/fonts.js`:

| Role | Family |
|---|---|
| UI, status, and prose | native system UI |
| paths, code, terminal, flags, metadata | native system monospace |

There is no serif choice. Editor font choices are the single source in
`src/shared/fonts.js`; an old saved `serif` preference migrates to system Sans.
Unused IBM Plex Sans and Mono faces remain in `fonts.css` only as reversible
experiment assets and are not selected by active tokens. UI type is usually
9–13px. Metadata may be uppercase only when short; sentences remain normal
case.

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

### Buttons and inputs

- Every clickable control has a visible hover change.
- Focus rings use `focus-visible:ring-1 focus-visible:ring-accent`.
- Disabled controls remain legible and do not respond to hover.
- Filled accent buttons are reserved for the primary action in a local flow.
- Inputs use surface background, a rule border, and accent focus.
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
- Reduced-motion users receive state changes without decorative animation.
- Never encode status by color alone; pair it with label, shape, title, or
  position.
