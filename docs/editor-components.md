# Editor Component Map

Visual component tree for the Editor window. Use this when making CSS/layout changes — it shows nesting, backgrounds, and where the chrome gradient transitions happen.

## Component Tree (DOM nesting)

```
editor-shell (bg-surface, flex col, h-full)
│
└─ editor-body (bg-chrome, flex row, flex-1)
   │
   ├─ AppRail (bg-chrome, 66px, shrink-0)
   │   ├─ [macOS traffic light clearance: 32px top padding]
   │   ├─ Rail buttons (44px wide, rounded-[6px])
   │   ├─ flex spacer
   │   ├─ Agents button
   │   ├─ divider (1px)
   │   └─ Settings button
   │
   ├─ Sidebar (sidebar-shell → sidebar-panel)
   │   │  sidebar-panel: bg-chrome, flex col
   │   │
   │   ├─ Shared header (34px, chrome bg, seamless with rail)
   │   │   ├─ [◀] collapse button (left)
   │   │   ├─ flex spacer
   │   │   ├─ subtitle (mono, ink-4)
   │   │   └─ TITLE (sans, uppercase, ink-3)
   │   │
   │   ├─ Content body (flex-1, bg-chrome-mid, rounded-tl-[8px], rounded-bl-[8px])
   │   │   └─ Active panel content (SidebarOutline | SidebarNotes | SidebarRefs | ...)
   │   │
   │   └─ Footer spacer (26px, chrome bg — matches editor footer height)
   │
   └─ editor-workspace (flex col, flex-1, no explicit bg → inherits chrome)
       │  Sets CSS vars: --scroller-tl-radius, --scroller-bl-radius
       │  (8px when sidebar collapsed, 0px when expanded)
       │
       ├─ TabStrip (bg-chrome, 34px, drag-region)
       │   ├─ [◀ ▶] nav buttons (hidden at ≤520px)
       │   ├─ File tabs (bg-chrome-high inactive, bg-surface active)
       │   ├─ [+] add tab
       │   └─ flex spacer (drag target)
       │
       ├─ EditorToolbar (bg-surface, 30px, optional — toggle on/off)
       │
       ├─ editor-panes (flex row, flex-1)
       │   ├─ EditorSurface (editor-wrap: bg-surface, flex-1)
       │   │   └─ CM6 editor
       │   │       ├─ .cm-editor (bg-chrome — provides color behind rounded corners)
       │   │       └─ .cm-scroller (bg-surface, rounded-tl/bl via CSS vars)
       │   │           ├─ .cm-gutters (bg-surface, color ink-3, 10px font, border-r)
       │   │           │   ├─ comment gutter (16px)
       │   │           │   ├─ fold gutter (14px)
       │   │           │   └─ line numbers (36px min-width)
       │   │           └─ .cm-content (color ink-2, 24px padding)
       │   │
       │   └─ PreviewPane (v-show, bg-surface)
       │
       ├─ RewriteOverlay (conditional, absolute)
       │
       └─ AppFooter (bg-chrome, 26px, grid 3-col)
           ├─ Stats (left) — live word/char count from documentStats
           ├─ Zoom (center)
           └─ View mode segmented control (right)
```

## Chrome Gradient Flow

The visual signature: darker at the edges, lighter toward content.

```
CHROME (#1e1e1e monokai)     Rail, header, footer, tab strip, .cm-editor bg
  ↓
CHROME-MID (#252525 monokai) Sidebar body, inactive tab bg hover
  ↓
SURFACE (#272822 monokai)    Editor canvas, .cm-scroller, toolbar, active tab, popovers
```

Every background in the UI maps to one of these three levels. No other background colors should be invented.

## "Peeling Corner" Pattern

Where a surface-colored area meets a chrome-colored area, a `border-radius: 8px` creates a curve that reveals chrome behind the surface — the surface "peels away" from the chrome band.

Used in two places:
1. **Sidebar body** — `rounded-tl-[8px]` and `rounded-bl-[8px]` on the chrome-mid content div. Chrome header/footer visible behind the curves.
2. **CM6 scroller** — `border-top-left-radius` and `border-bottom-left-radius` via CSS variables. `.cm-editor` bg is chrome; `.cm-scroller` bg is surface. The scroller peels away from the chrome editor root. Only active when sidebar is collapsed (CSS vars set on `editor-workspace`).

## Responsive Breakpoints

| Width | What changes |
|---|---|
| ≤760px | Sidebar becomes overlay (absolute positioned, with scrim) |
| ≤520px | Rail labels hidden. Non-macOS rail shrinks to 52px. macOS rail stays 66px (traffic lights). Tab nav buttons hidden. Tab strip padding tightens. |
| ≤430px | Footer stats hidden, view control centered |

## Key CSS Variable Cascade

```
editor-workspace (Vue reactive :style)
  │
  ├─ --scroller-tl-radius: 8px (sidebar collapsed) / 0px (sidebar expanded)
  ├─ --scroller-bl-radius: 8px (sidebar collapsed) / 0px (sidebar expanded)
  │
  └─ cascades through editor-panes → editor-wrap → .cm-editor → .cm-scroller
       which reads: border-top-left-radius: var(--scroller-tl-radius, 0px)
                    border-bottom-left-radius: var(--scroller-bl-radius, 0px)
```

CM6 theme variables bridge (set in `editor-content.css`, overridden per theme in `themes.css`):
```
--editor-paper  → .cm-scroller bg, .cm-gutters bg  (= surface)
--editor-size   → .cm-editor font-size
--editor-line-height → .cm-scroller, .cm-gutters line-height
--ink, --ink-strong  → text colors
--muted         → .cm-gutters color (= ink-4)
--accent        → caret, selection, active line
--selection     → selection background
```

## Sidebar Panel Structure

Each panel (Outline, Notes, Refs, History, Export) is a content-only component — no header. The shared header in `Sidebar.vue` provides the title bar. Panel components provide:

| Panel | Content structure |
|---|---|
| Outline | Scrollable heading rows with indentation |
| Notes | Chip row (Open/Resolved/All + add button) → scroll-synced comment cards → optional footer |
| Refs | Chip row (In document/All + import) → search input → scrollable ref rows |
| History | Empty state placeholder |
| Export | Format chips → settings rows → export buttons |

SidebarAgents was deleted (dead code — "Agents" rail button opens the Panel window directly).

## Gotchas for CSS Changes

1. **CM6 is deep** — The gutter is 6+ levels deep from the Vue component. Parent `overflow: hidden` + `border-radius` rarely reaches it. Use the CM6 theme in `core.js` or CSS variables that cascade.

2. **Scoped CSS + child components** — Vue scoped styles only apply to elements in the same component. Use `:deep()` to pierce into child components, or better: restructure so the styled element is in the same component.

3. **Same-color rounding is invisible** — `border-radius` + `overflow: hidden` clips children, but the gap reveals the parent background. If parent and child are the same color, the rounding is invisible. Always verify the color behind the clip differs.

4. **`isolation: isolate` + `z-index: -1`** — Theoretically works for pseudo-element layering. In practice, unreliable across Vue component boundaries. Prefer real DOM elements.

5. **Tailwind specificity** — Scoped CSS can override Tailwind utilities because Vue adds `[data-v-xxx]` (specificity 0,1,1 vs Tailwind's 0,1,0). But inline styles always win over both.

6. **Traffic lights (macOS)** — Native overlay at `{x: 14, y: 14}`, spanning ~52px wide. The rail must be ≥66px on macOS to contain them. Rail top padding is 32px on macOS vs 14px on other platforms.
