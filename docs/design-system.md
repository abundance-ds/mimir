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
- Do not add colored edge bars, gradients, meter decoration, suggestion chips,
  personas, chat-like AI surfaces, or hover transforms.

Vendor DOM from CodeMirror and xterm is styled through shared bridge CSS or
component `:deep()` rules. Terminal colors derive from theme tokens.
