# Design System

This document defines the visual language, layout architecture, and component system for the Shoulders editor family. It is written so that a sister application with a different structure can map the same design essence — the chrome gradient, typographic hierarchy, density, and restraint — without copying layout verbatim.

---

## 0. Principles

- **Chrome gradient.** Surfaces lighten from shell to content center. Three levels: chrome, chrome-mid, surface. No shadows.
- **Dense.** Compact controls. Tight rows. 8-hour tool. Every pixel earns it.
- **Progressive disclosure.** Calm surface. Deep capabilities. One click from everything.
- **Two postures.** Writing mode is minimal. Review mode is dense.
- **One accent.** Single accent color per theme. Signal only: active states, citations, caret. Never background fill.
- **Five themes.** Light (warm light, default), Studio (cool aluminium), North (cool light), Dark (neutral dark), Monokai (dark warm).
- **Five font roles.** Sans (Inter) for chrome. Serif (Lora) for content. Mono (JetBrains Mono) for code/data. Slab (Zilla Slab) as editor option. Brand (Georgia) for product name display.
- **Discovered, not designed.** Should feel like an instrument (Teenage Engineering), not a platform.

## 1. Design Philosophy

The tool should feel discovered, not designed. Like an instrument, not a platform.

- **Monochrome + one accent.** Each theme uses a single accent color. No secondary accent colors.
- **Chrome gradient.** The outer shell is darker; surfaces lighten as you move inward toward the content. This creates depth without shadows.
- **Typography over decoration.** Weight, size, case, and spacing communicate hierarchy. Borders, fills, and icons are secondary.
- **No shadows.** Depth is communicated through surface color differences and subtle borders. The only exception is functional floating elements (popovers) which may use a border for separation.
- **Balancing density and whitespace.** Controls are compact. Rows are tight. The tool respects screen real estate. But space is left to breath, for clarity, and focus.
- **Radius is restrained.** App shell: 10px. Panel corners: 8px. Rail buttons: 6px. Tab tops: 5px. Toolbar/buttons: 3-4px. Segmented controls: 100px (pill). Nothing else rounds.

---

## 2. Color System

The entire palette maps to CSS custom properties. Every color in the UI traces back to one of these variables. Four themes are available, controlled by a `data-theme` attribute on `<html>`:

| Theme | `data-theme` | Vibe | Accent |
|---|---|---|---|
| Light | `parchment` | Warm light (default) | `#c05d3c` terracotta |
| Studio | `studio` | Cool aluminium frame, warm paper | `#E86420` TE orange |
| North | `glacier` | Cool blue-gray light | `#4a7c9b` steel blue |
| Dark | `slate` | Neutral dark | `#5a9e8f` muted teal |
| Monokai | `monokai` | Classic dark | `#f97316` warm orange |

Theme definitions live in `src/shared/styles/themes.css`. The Tailwind `@theme` block in `app.css` provides defaults (Light). Each `[data-theme]` selector overrides the full set of `--color-*` tokens and CodeMirror bridge variables. Display names differ from `data-theme` attribute values for backward compatibility.

### Styling rule

Use Tailwind utility classes for all new styling. In Vue templates, prefer `text-ink-3`, `bg-chrome-mid`, `border-rule-light` over `var()` arbitrary values. Reserve vanilla CSS (`<style>` blocks) only for things Tailwind cannot express: `@keyframes` animations, vendor-prefixed properties (`-webkit-app-region`), and `:deep()` selectors for rendered markdown or CodeMirror content.

Theme is stored in `~/.shoulders-v3/settings.json` under `editor.editorTheme`. When changed in the editor, a Tauri event (`shoulders://theme-changed`) notifies the panel window. Browser fallback uses `localStorage` `shoulders:theme` key and the `storage` event.

### 2.1 Chrome Gradient (3 levels)

The chrome system creates the outside-in depth gradient. These three colors define the app's spatial layering. Values shown are Light (parchment) defaults; each theme overrides them.

```
--chrome:     #ebe9e3    Darkest — header, rail, footer, body bg
--chrome-mid: #f3f1ec    Middle  — tab strip, sidebar body, hover states, seg-ctrl bg
--surface:    #ffffff    Lightest — editor, preview, toolbar, gutter, sidebar title bars, form controls
```

In dark themes (Dark, Monokai) the gradient inverts: chrome is near-black, surface is dark gray. The spatial relationship (outer = chrome, inner = surface) stays the same.

**Rule:** Any element that sits on the outer edge of the window uses `--chrome`. Anything that is a mid-layer (tab bar, docked sidebar body) uses `--chrome-mid`. Reading/writing surfaces use `--surface`. No additional background levels should be invented.

### 2.2 Ink (text hierarchy)

Four ink values control all text contrast:

```
--ink:   #1a1a18    Primary — headings, active labels, body text in content
--ink2:  #4a4a44    Secondary — body text in editor, hover states, rail labels (default)
--ink3:  #8a8a80    Tertiary — toolbar buttons, chip labels, footer text, panel titles
--ink4:  #b0b0a6    Quaternary — line numbers, timestamps, metadata, disabled hints
```

**Usage pattern:** `--ink` for things the user is reading. `--ink2` for supporting text. `--ink3` for UI chrome labels. `--ink4` for metadata you glance at. Hover states typically shift one level darker (ink4 -> ink3, ink3 -> ink2, ink2 -> ink).

### 2.3 Accent

One accent color. No secondary accents.

```
--accent:      #c05d3c               Terracotta — active states, citations, primary actions
--accent-soft: rgba(192,93,60,.08)   Tinted bg — active rail items, active outline row, chip-select
--accent-ink:  #ffffff               White text on accent fills (export button)
```

**Where accent appears:** Active rail icon+label. Citation keys in editor and refs panel. Primary action buttons (filled). Dirty-file dot. Caret color. Active line highlight in gutter. Resize handle on hover. Selection info in footer. Underline on active chip. Never as a large fill or background — only as a signal.

### 2.4 Lines and Borders

```
--rule:        #d8d7d2               Structural — gutter right edge, panel borders, app shell border
--rule-light:  #eae9e5               Subtle — row dividers, section separators, tab strip bottom
--line-soft:   rgba(0,0,0,.04)       Ghost — panel header/footer borders, panel left edge
--line-hl:     rgba(192,93,60,.06)   Active line — gutter highlight for cursor line
```

**Principle:** Structural borders (`--rule`) separate major regions. Row-level dividers use `--rule-light`. Borders between chrome zones (header/panel, panel/content) use `--line-soft` so the chrome gradient reads cleanly across them. Never use dark borders to separate chrome from chrome.

### 2.5 Background

```
Body behind app:  #2c2f33    Dark gray — makes the app window boundary visible
App shell border: 1px solid var(--rule), border-radius 10px
```

---

## 3. Typography

Five CSS variables, each with a strict role. Never cross roles.

### 3.1 Typeface Map

```
--font-sans:   'Inter', -apple-system, BlinkMacSystemFont, sans-serif
--font-serif:  'Lora', 'Georgia', serif
--font-mono:   'JetBrains Mono', ui-monospace, monospace
--font-slab:   'Zilla Slab', 'Georgia', serif
--font-brand:  'Georgia', serif
```

| Role | Variable | Typeface | Where |
|------|----------|----------|-------|
| UI chrome | `--font-sans` | Inter | Rail labels, panel titles, toolbar buttons, chip labels, btn labels, export labels, stats dialog |
| Content body | `--font-serif` | Lora | Chat messages, preview pane body text, preview headings, rewrite overlay |
| Code / data | `--font-mono` | JetBrains Mono | Editor source, line numbers, file paths, tab labels, footer readouts, metadata, timestamps, ref keys, zoom level, kbd hints |
| Alt body | `--font-slab` | Zilla Slab | Editor font option (user-selectable) |
| Brand display | `--font-brand` | Georgia | Product name ("Shoulders"), hero headings (NewChat, About). Shoulders' brand typeface is Crimson Text, but Georgia is used at runtime to avoid bundling a font for two headings. |

Editor font is user-selectable via Settings > Editor > Font. Four semantic options: Sans, Serif, Mono, Slab. Setting key: `editorFontFamily` stores `'sans'`/`'serif'`/`'mono'`/`'slab'`. Single source of truth: `src/shared/fonts.js`.

### 3.2 Size Scale

| Element | Size | Weight | Family | Line-height |
|---------|------|--------|--------|-------------|
| Preview H1 | 26px | 600 | serif | 1.2 |
| Preview H2 | 18px | 600 | serif | — |
| Preview H3 | 15px | 500, italic | serif | — |
| Preview body | 14px | 400 | serif | 1.75 |
| Editor body | 12px | 400 | mono | 23px (fixed) |
| Editor H2 | 13px | 600 | mono | 23px |
| Editor H3 | 12.5px | 500 | mono | 23px |
| Toolbar buttons | 11px | 400/600 active | sans | — |
| Panel row title | 11.5px | 500 | sans | — |
| Panel row body | 11px | 400 | sans | 1.5 |
| Tab labels | 10.5px | 400/600 active | mono | — |
| Btn labels | 10.5px | 500 | sans | — |
| Export btn | 10.5px | 500/600 primary | sans | — |
| Chip labels | 10px | 400/600 active | sans | — |
| Panel title | 9px | 600 | sans | uppercase, 1.8px spacing |
| Panel subtitle | 9.5px | 400 | mono | — |
| Footer text | 9px | — | mono | — |
| Footer labels | 9px | 500 | sans | 0.3px spacing |
| Rail labels | 8px | 500/700 active | sans | uppercase, 0.3px spacing |
| Rail icons | 18px | — | Tabler Icons | — |
| Line numbers | 9px | 400/500 active | mono | — |
| Metadata / time | 9px | — | mono | — |
| Kbd hints | 9px | — | mono | — |

**Important:** The editor line-height is a fixed `23px` value, not a ratio. This prevents drift between gutter and content across zoom levels. When zooming, both font-size and line-height scale proportionally.

### 3.3 OpenType Features

```css
font-feature-settings: 'kern' 1, 'liga' 1, 'onum' 1;
-webkit-font-smoothing: antialiased;
```

---

## 4. Icons

Tabler Icons webfont via CDN. No custom icon SVGs.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css"/>
```

Usage: `<i class="ti ti-{name} rail-icon"></i>`

| Location | Icon | Tabler name |
|----------|------|-------------|
| Rail: Outline | List | `ti-list` |
| Rail: Notes | Speech bubble | `ti-message` |
| Rail: Refs | Book | `ti-book` |
| Rail: History | Clock arrow | `ti-history` |
| Rail: Export | Document arrow | `ti-file-export` |
| Rail: Agents | Sparkles | `ti-sparkles` |
| Rail: Settings | Gear | `ti-settings` |
| Header: Sidebar toggle | Sidebar collapse | `ti-layout-sidebar-left-collapse` |

Rail icons render at 18px. Header icons render at 16-18px. Color follows the same ink hierarchy as text (default `--ink4`, hover `--ink2`, active `--accent`).

---

## 5. Layout Architecture

### 5.1 Shell Structure

```
+------------------------------------------------------------------+
|  HEADER (34px, chrome bg)                                         |
+------+--------+--------------------------------------------------+
|      |        |  TABSTRIP (34px, chrome-mid bg)                   |
|      |        +--------------------------------------------------+
| RAIL | PANEL  |  TOOLBAR (30px, surface bg)                       |
| 72px | 240px  +--------------------------------------------------+
|chrome|chrome |                                                    |
| bg   |mid bg |  EDITOR AREA (flex: 1)                            |
|      |        |    editor-pane  |  preview-pane                   |
|      |        |                                                    |
+------+--------+--------------------------------------------------+
|  FOOTER (26px, chrome bg)                                         |
+------------------------------------------------------------------+
```

The app sits on a dark background (`#2c2f33`) with 24px inset, 10px border-radius, and 1px `--rule` border. This creates a floating window appearance.

### 5.2 The Chrome Gradient

The key visual concept. Looking left-to-right:

```
HEADER (chrome) → RAIL (chrome) → PANEL (chrome-mid) → EDITOR (surface)
```

And top-to-bottom:

```
HEADER (chrome) → TABSTRIP (chrome-mid) → TOOLBAR (surface) → EDITOR (surface)
```

The outer frame (header, rail, footer) shares `--chrome`. The docked panel body uses `--chrome-mid` so it reads as app chrome, while sidebar title bars, editor, preview, toolbar, gutter, popovers, and form controls use `--surface`. This creates a subtle dark-to-light gradient from the edges toward the content center without explicit gradient CSS — just flat color blocks.

**When adapting to a sister app:** Map your outer frame to `--chrome`, your secondary chrome to `--chrome-mid`, and primary reading/writing areas to `--surface`. The gradient should always flow from darker edges toward lighter content.

**Navigation ownership:** the native header is window chrome only. Document identity and file switching live in the tab strip; sidebar identity lives in the docked panel title bar. Do not style the header document label as a tab in normal editor mode, or the UI reads as two competing navigation bars.

### 5.3 The Panel Corner

The panel (sidebar) has `border-top-left-radius: 8px`. This creates a distinctive visual detail where the panel "peels away" from the rail's chrome surface into the warmer mid-chrome panel body.

**When the panel collapses**, the main content area inherits this same `border-top-left-radius: 8px` via the `.panel-closed` class, so the rounding visually migrates from the panel to the main area.

The panel header (`.panel-hd`) also has `border-top-left-radius: 8px` to match, using `--surface` background and a `--rule-light` bottom border so it remains legible against both the rail and the mid-chrome sidebar body.

### 5.4 Dimension Tokens

```
Heights:
--h-header:    34px     Top bar
--h-tabstrip:  34px     Tab row
--h-toolbar:   30px     Formatting toolbar
--h-footer:    26px     Bottom status bar
--h-panel-hd:  34px     Panel header (matches h-header)
--h-panel-ft:  26px     Panel footer (matches h-footer)
--h-subrow:    26px     Chip/filter row

Widths:
--w-rail:      72px     Navigation rail
--w-panel:     240px    Sidebar panel (resizable: 180-450px)

Spacing:
--pad-bar:     14px     Header/footer horizontal padding
--pad-panel:   12px     Panel content horizontal padding
--pad-body:    24px     Editor/preview padding
--gap-sm:      4px
--gap-md:      8px
--gap-lg:      14px
```

### 5.5 The Header

```
[ native traffic-light space ]  [ Sidebar toggle 18px ]  [ optional app menus ]  [ flex spacer ]
```

- Background: `--chrome` (seamless with rail and footer)
- Height: 34px
- macOS traffic-light controls are native Tauri controls rendered through an overlay titlebar
- Header content reserves a top-left spacer so controls do not overlap the sidebar toggle; the editor uses 56px to give the sidebar toggle extra breathing room
- A dev-only calibration guide can be enabled with `?chromeCalibrate=1`; production chrome uses native controls plus invisible spacing, with no filled placeholder dots
- `data-tauri-drag-region` plus `-webkit-app-region: drag` enables native window dragging, including Windows; Tauri capabilities must allow `start_dragging`, and buttons override with `no-drag`

### 5.6 The Footer

```
[ Stats (clickable) ]  [ spacer ]  [ − 100% + ]  [ spacer ]  [ view label ]  [ raw|split|preview ]  [ | ]  [ toolbar toggle on/off ]  [ ⌘/ ]
```

- Background: `--chrome` (seamless with header and rail)
- Height: 26px
- Font: `--font-mono` 9px, color `--ink3`
- Labels ("view", "toolbar") use `--font-sans` 9px weight 500
- Stats area is clickable — opens a popover with detailed word/char/line/reading-time stats
- When text is selected, total stats hide and selection stats appear in `--accent` color
- Zoom controls (−/+) step through: 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200%
- Segmented controls use pill shape (100px radius, see component section)

---

## 6. Component Catalog

### 6.1 Buttons (`.btn`)

Text-only by default. No borders, no backgrounds, no fills. Interaction is communicated by color change on hover.

| Variant | Height | Font | Default color | Hover | Active |
|---------|--------|------|---------------|-------|--------|
| Default | 26px | sans 10.5px w500 | `--ink3` | `--ink` | — |
| `.sm` | 20px | sans 10px | `--ink3` | `--ink` | — |
| `.md` | 24px | — | — | — | — |
| `.sq` | 26px, min-w 22px | — | — | — | — |
| `.primary` | 26px | sans 10.5px w600 | `--accent` | `--ink` | — |

### 6.2 Rail Buttons (`.rail-btn`)

```
[ 46px wide, 8px vertical padding, column layout ]
    [ Icon 18px Tabler ]
    [ Label 8px sans uppercase ]
```

| State | Background | Icon color | Label color |
|-------|------------|------------|-------------|
| Default | none | `--ink4` | `--ink2` |
| Hover | `--chrome-mid` | `--ink2` | `--ink` |
| Active | `--accent-soft` | `--accent` | `--accent` w700 |

Border-radius: 6px. Gap between items: 3px.

**Rail layout:** Document-scoped items (Outline, Notes, Refs, History, Export) occupy the top. A `flex: 1` spacer pushes remaining items to the bottom. Agents sits above a 1px divider line. Settings sits below the divider, alone. The divider signals that Settings opens a dialog, not a panel.

### 6.3 Tabs (`.tab`)

Active tab background matches content below it, creating visual continuity.

| State | Background | Color | Weight | Radius |
|-------|------------|-------|--------|--------|
| Inactive | transparent, 62% opacity | `--ink4` | 400 | 1px transparent, 5px top corners |
| Hover | `--chrome` | `--ink2` | 400 | 1px transparent, 5px top corners |
| Active | `--surface` (same as editor canvas) | `--ink` | 600 | 1px `--rule`, bottom border `--surface`, 6px top corners |

Height: `calc(34px - 6px)` = 28px. Font: mono 10.5px. 12px horizontal padding.

The tab strip background is `--chrome`, darker than the active tab's `--surface`. The active tab uses the same color as the editor canvas, a clear neutral top/side border, and a bottom border matching `--surface`. Inactive tabs recede by opacity. No accent color is used on the tab outline.

The formatting toolbar is not the document tab. It sits in `--chrome-mid`, a visibly different neutral band between the selected tab and the editor canvas, so the active document tab remains the strongest navigation signal.

A dirty indicator is a 5px `--accent` circle. Close button is a `×` character in `--ink4`.

### 6.4 Toolbar Buttons (`.toolbar-btn`)

| State | Background | Color | Weight | Radius |
|-------|------------|-------|--------|--------|
| Default | none | `--ink3` | 400 | 0 |
| Hover | `--chrome-mid` | `--ink` | 400 | 3px |
| Active | `--accent-soft` | `--accent` | 600 | 3px |

Height: 22px, min-width 22px, 6px horizontal padding. Font: sans 11px.

Grouped into `.toolbar-group` containers with 2px gap. Groups separated by 16px gap.

### 6.5 Segmented Control (`.seg-ctrl`)

Pill-shaped toggle for mutually exclusive modes.

- Container: 20px height, `--chrome-mid` bg, 1px `--rule` border, `border-radius: 100px`, 1px padding
- Segments: mono 9px, `--ink3` color, 100px radius, 9px horizontal padding, 16px height
- Active segment: `--surface` bg (white pill inside), `--ink` color, weight 600
- Hover (inactive): `--ink2` color

### 6.6 Chips (`.chip`)

Two variants — filter chips and select chips.

**Filter chips** (used in panel subrows for Notes, Refs, History):
- Default: no bg, no border, `--ink3`, sans 10px
- Active: `--ink` color, weight 600, underline in `--accent` (1.5px thick, 3px offset)
- Count badge: inline `<span>` with weight 700

**Select chips** (`.chip-select`, used for export format):
- Default: 2px 8px padding, 3px radius, no bg
- Active: `--accent-soft` bg, no underline

### 6.7 Panel Structure

```
+-- Panel (surface bg, 8px top-left radius) ----+
| Panel Header (chrome-mid bg, 34px)             |
|   TITLE (9px sans uppercase 1.8px spacing)     |
|   subtitle (9.5px mono ink4)                   |
+------------------------------------------------+
| Chip Row (26px, rule-light bottom border)      |
|   filter chips with counts                     |
+------------------------------------------------+
| Panel Rows (scrollable, surface bg)            |
|   Content-specific rows...                     |
+------------------------------------------------+
| Panel Footer (chrome-mid bg, 26px) [optional]  |
|   Action buttons                               |
+------------------------------------------------+
```

The panel is resizable via a drag handle on its right edge. On hover, a 2px `--accent` line appears. Drag range: 180-450px.

Panel header title: 9px sans, weight 600, `--ink3`, uppercase, letter-spacing 1.8px.
Panel header subtitle: 9.5px mono, `--ink4`.

### 6.8 Export Buttons (`.export-btn`)

Used inline within panel content, not in a fixed footer.

| Variant | Background | Color | Border |
|---------|------------|-------|--------|
| Default | `--surface` | `--ink2` | 1px `--rule` |
| Hover | `--chrome-mid` | `--ink2` | 1px `--rule` |
| Primary | `--accent` | `--accent-ink` (white) | 1px `--accent` |
| Primary hover | `--accent` opacity .9 | white | — |

Height: 28px, border-radius 4px, sans 10.5px.

### 6.9 Export Row (`.export-row`)

Key-value row for settings-like content:
- Height: 32px, border-bottom `--rule-light`
- Label: sans 11px, `--ink2`
- Value: mono 10px, `--ink3`, right-aligned
- Hover: `--chrome-mid` bg

### 6.10 Stats Dialog (`.stats-dialog`)

Popover triggered by clicking footer stats:
- Positioned absolute, bottom 100% + 8px
- Surface bg, 1px `--rule` border, 6px radius
- Rows: sans 11px labels (`--ink2`), mono 10px values (`--ink3`)
- Row padding: 5px 12px

### 6.11 Zoom Control (`.zoom-ctrl`)

Inline in footer center between two spacers:
- Minus/plus buttons: 18x18px, mono 12px, `--ink3`, 3px radius
- Level display: mono 9px, `--ink3`, 36px min-width, center-aligned
- Hover: `--ink` color, `--chrome-mid` bg

---

## 7. Editor Surface

### 7.1 Gutter (Line Numbers)

- Width: 44px, `--surface` bg
- Right border: 1px `--rule` (structural)
- Font: mono 9px, `--ink4`
- Right-aligned with 10px right padding
- Active line: `--ink2` color, weight 500, `--line-hl` background
- Heights sync dynamically to editor line heights via ResizeObserver

### 7.2 Editor Content

- Font: mono 12px, line-height 23px (fixed px)
- Color: `--ink2`
- Padding: 24px
- Caret: `--accent` color
- Active line: gutter-only highlight (editor line itself has transparent bg)
- Raw mode: `max-width: 80ch`, left-aligned
- Split/preview mode: no max-width constraint

### 7.3 Markdown Decorations

| Element | Style |
|---------|-------|
| H2 | mono 13px, weight 600, `--ink` |
| H3 | mono 12.5px, weight 500, `--ink` |
| Hash marks (#) | `--ink4` (deemphasized) |
| Bold markers | weight 600, `--ink` |
| Citations [@key] | `--accent` |
| Blockquotes | 2px left border `--rule`, 14px left padding, `--ink3`, italic |
| Selection highlight | `rgba(158,74,47,.1)` bg, 1px `--accent` outline |

### 7.4 Preview Pane

- Font: serif, `--ink`
- Padding: 32px 36px
- H1: 26px, weight 600, letter-spacing -.3px
- H2: 18px, weight 600
- H3: 15px, weight 500, italic
- Body: 14px, line-height 1.75, `--ink2`, justified, auto-hyphens
- Citations: `--accent`, weight 500
- Blockquotes: 2px left border, italic, `--ink3`, 13.5px

---

## 8. Interaction Patterns

### 8.1 Sidebar Toggle (header button)

Collapses/expands the 240px panel only. The 72px rail stays visible.

When panel collapses:
- Panel shell animates to width 0 (220ms) while clipping a fixed-width inner panel; panel content must not reflow or squeeze during collapse
- Main area gains `border-top-left-radius: 8px` — the rounding migrates from panel to main

### 8.2 View Modes (footer segmented control)

- **raw**: Editor only, no preview. Editor content constrained to `80ch` max-width, left-aligned
- **split**: Editor + preview side by side, separated by 1px `--rule-light` border
- **preview**: Preview only, no editor

### 8.3 Toolbar Toggle (⌘/)

- **top**: 30px toolbar visible with formatting buttons
- **none**: Toolbar hidden

### 8.4 Rail Navigation

- Clicking a rail item opens its panel content. Clicking the active item collapses the panel.
- Agents and Settings are in `nonPanelItems` — clicking them does nothing in the current mock (Agents opens a separate window, Settings opens a dialog in the real app).
- Active state: `--accent-soft` bg fill with accent-colored icon and label.

### 8.5 Panel Resize

Drag the right edge of the panel. The invisible hit target should be wider than the visible border so it is easy to grab, but only a 2px `--accent` line appears on hover/drag. Resize updates are instant with no transition; only collapse/expand animates. Range: 180-450px.

### 8.6 Footer Stats

- Default: shows total word/char count
- On text selection: swaps to selection char/word count in `--accent` color
- Click: opens stats popover (words, characters, characters without spaces, lines, reading time)
- Click outside: dismisses popover

### 8.7 Zoom

Footer center. Steps through standard zoom levels (50-200%). Scales editor font-size and line-height proportionally. When the editor is focused, `Cmd/Ctrl` + `+`/`-` changes zoom in the same 5% increments as the footer controls.

---

## 9. Transitions

```
--transition: 220ms cubic-bezier(.4,0,.2,1)
```

Only the following elements animate:
- **Panel shell**: width/flex-basis on sidebar toggle; inner panel keeps its configured width and is clipped

---

## 10. Scrollbars

Custom thin scrollbars throughout:
- Width: 3-4px
- Thumb: `--rule` color, 1-2px border-radius
- Track: transparent

---

## 11. Adapting for a Sister App

When building an application that shares this design language but has different layout structure:

1. **Keep the 3-level chrome gradient.** Your outer shell is `--chrome`. Your secondary chrome is `--chrome-mid`. Your content areas are `--surface`. This is the most recognizable visual signature.

2. **Keep the single accent.** `--accent` (#c05d3c terracotta) is used sparingly: active states, citations, primary actions, caret. It should never be a dominant color.

3. **Keep the ink hierarchy.** `--ink` through `--ink4` control all text. Hover shifts one level darker. Active items use `--accent` instead.

4. **Keep the typeface roles.** Serif for rich content, sans for UI chrome, mono for code/data. Never use mono for UI labels or sans for content body.

5. **Keep the border vocabulary.** `--rule` for structural, `--rule-light` for rows, `--line-soft` for ghost borders between chrome zones.

6. **Keep the rounding vocabulary.** Major container: 10px. Panel corners: 8px. Interactive elements: 3-6px. Pills: 100px. Don't invent new radius values.

7. **Keep the density.** Rows are 26-38px. Bars are 26-34px. Padding is 12-14px. Don't add extra whitespace or make things "breathe" — the tool should feel compact and precise.

8. **Keep text-only buttons.** Default state has no background, no border. Interaction is communicated through color, weight, and (for chips) underline. Filled buttons are rare — only for primary export-style actions.

9. **Map hover → `--chrome-mid` bg.** This is the universal hover signal for rows, buttons, and interactive elements on `--surface` backgrounds.

10. **Map active → `--accent-soft` bg + `--accent` text.** This is the universal selected/active signal. Never use a left-border highlight or shadow for selection.

11. **Support all four themes.** Use CSS custom properties (`var(--color-*)`) for every color. Never hardcode hex values in components. Test your UI in Light (warm light), North (cool light), Dark (neutral dark), and Monokai (warm dark). Dark themes invert the chrome gradient but keep the same spatial logic.

---

## 7. Interaction Conventions

Native desktop behavior. The app should feel like Sublime/Zed/Linear, not a web page.

### 7.1 Cursor

**Arrow cursor on all controls. Pointer only on `<a>` hyperlinks.**

Do not use `cursor: pointer` on buttons, tabs, icon buttons, sidebar rows, chips, toggles, dropdowns, or any other control. The hover background change is the affordance. This matches macOS native behavior (Finder, System Settings, Xcode).

The only exception: `<a href>` elements that navigate to a URL. These get browser-default pointer. Never add `cursor-pointer` to `<button>`, `<div @click>`, or `<span @click>`.

### 7.2 Hover

**Every clickable element must have a visible hover background change.**

Text-color-only hover is not sufficient. If a user cannot tell something is clickable by hovering, it needs a `hover:bg-*` rule.

| Surface | Hover bg token |
|---------|---------------|
| `--surface` | `hover:bg-chrome-mid` |
| `--chrome` | `hover:bg-chrome-mid` |
| `--chrome-mid` | `hover:bg-chrome-high` |

### 7.3 Transitions

**No transitions on hover states.** Hover feedback is instant — native controls don't fade in. CSS transitions belong on layout changes (panel collapse, sheet open) and content reveals (stream text), never on control hover.

### 7.4 Text Selection

**UI chrome is inert.** `html { user-select: none }` prevents selecting button labels, sidebar text, toolbar buttons. Content areas opt back in: `.cm-content`, `.preview-content`, `.chat-message-content`, `textarea`, `input`, `[contenteditable]`, `pre`, `code`.

### 7.5 Scroll Isolation

**Scroll contexts are contained.** Every scrollable element uses `overscroll-behavior: contain` (applied globally via attribute selector on `overflow-*` classes). Momentum never bleeds from a sidebar into a parent container.

### 7.6 Focus Rings

**Keyboard only.** Use `:focus-visible` (not `:focus`) for control focus indicators. Click-focus should never show a ring. Inputs keep their existing `border-accent` pattern.

### 7.7 Tooltips

**OS timing.** All tooltips use native `title=` attributes. In Tauri/WKWebView, delay is OS-controlled (~800ms on macOS). No custom tooltip library.
