# Design system

Mimir is direct, dense, and quiet. Structure, spacing, type, and stable signals
must explain the interface without decorative copy or motion.

## Rules

- Remove an element before adding an explanation.
- Every state change has a visible control; shortcuts only accelerate it.
- Active filters are named and clearable in one action.
- Hover never reveals required content or moves geometry. Selection uses
  `accent-soft`, not a filled card.
- Color never carries state alone. Pair it with a word, glyph, or stable
  instrument position.
- Keep normal UI at 9 px or larger and row data at 10 px or larger.
- Use the system UI font for interface and prose, system mono for technical
  values, and Commit Mono for Editor content.
- Editor bold and italic pair weight or slant with ink tinted by the theme
  syntax colour (`--ink-strong`, `--ink-emphasis`); the accent stays reserved
  for links.
- Each theme defines `--editor-heading` and five `--syntax-*` colours in
  `themes.css`. Derived palettes keep OKLCH lightness within 0.05 and chroma
  within 0.09 to 0.12 for light themes; canonical dark ports keep their own
  values. Every one of these colours reaches 5:1 against `surface`
  (`themes.test.js`). Markdown markers use `ink-4`; the heading colour is
  the only hue on heading marks. Judge changes in
  `harness/editor-themes.html`, which mounts the real editor on one sample
  document across all eight themes.
- Workbench surfaces are square with one-pixel rules. Shadows and rounded
  corners are reserved for functional overlays.
- Raw ids, revisions, counters, and technical state do not belong in normal UI.

## Tokens

Tokens live in `src/shared/styles/app.css`; theme overrides live in
`themes.css`. Use semantic utilities instead of raw CSS variables.

| Family | Purpose |
|---|---|
| `bg-chrome`, `bg-chrome-mid`, `bg-chrome-high`, `bg-surface` | Shell depth |
| `text-ink` through `text-ink-4` | Text hierarchy |
| `accent`, `accent-soft` | Selection, focus, primary action |
| `add`, `rem`, `attn`, `info` | Success, failure, intervention, new information |
| `rule`, `rule-light` | Pane and row separation |

Do not invent ad-hoc gray values. Every theme must preserve these roles and
readable contrast.

## Controls

- Controls have visible hover, `focus-visible` rings, accessible names, and
  legible disabled states.
- Use a filled accent button only for the primary action in a local flow.
- Inputs use surface background, rule border, and accent focus.
- Disable autocorrect and autocapitalization for non-prose fields; disable
  spellcheck too when appropriate.
- Do not use native `<select>`. Use the shared accessible combobox/listbox with
  Arrow, Home/End, Enter/Space, Escape, and Tab behavior.
- Keep the base button reset inside `@layer base`.
- Native UI is non-selectable; authored text, code, terminal output, and input
  fields opt back into selection.
- Use live/status roles for asynchronous feedback.

## Graph and rows

- Projection rows use hairlines, full-width hover, and stable geometry.
- Sidebar rows are 32 px; dense file rows are 28 px.
- Graph property controls are borderless at rest and gain a quiet hover wash
  and focus ring. Visible labels explain editable values.
- Graph notes are unframed document text. Dialog fields can remain boxed.
- Work rows: Board cards are 66 px `chrome-high` plates on a `chrome`
  column with a 1 px `rule-light` edge, a 2 px radius, and a 4 px gap; hover
  is `chrome-mid`. This stack is raised in every theme; `surface` is not,
  because it is the darkest layer in dracula, zenith, and synthwave. The
  cards are the one rounded workbench surface. Slots are fixed: title 13 px/600 on
  one line with the owner at its right, project beneath, then the due date
  and waiting reason at 11 px, and the priority control at the bottom right.
  List rows are one 12 px line in aligned columns. Due dates are words
  relative to today; overdue pairs `rem` with the word. Column and group
  headers are 12 px/700 ink on `chrome-high` over a `rule`.
- Priority glyphs: urgent is an exclamation in `rem`, high is full bars in
  ink, normal and low stay quiet in `ink-4`. No state is color-only.
- Do not add colored edge bars, gradients, meter decoration, suggestion chips,
  personas, chat-like AI surfaces, or hover transforms.

Vendor DOM from CodeMirror and xterm is styled through shared bridge CSS or
component `:deep()` rules. Terminal colors derive from theme tokens.
