# Editor Performance

Status: current as of 2026-05-11.

## Hot-Path Rule

The CodeMirror transaction path should stay local to CM6. A keystroke should not synchronously:

- serialize the full document with `doc.toString()`
- parse Markdown
- write `localStorage`
- invoke Tauri commands
- scan all citations
- update large Vue content state

Immediate edit handling should only mark the active file dirty and schedule downstream work.

## Current Edit Flow

```
CM6 transaction
  -> App.vue onContentChange()
     -> fileManager.markDirty()
     -> schedule full-content sync after 150ms
     -> autoSaveController.schedule() after 1000ms

Deferred full-content sync
  -> read current CM6 document once
  -> update fileManager content if changed
  -> schedule document bridge
  -> schedule preview render only outside source mode
```

Relevant source:

- `src/editor/App.vue`
- `src/editor/composables/useDeferredMarkdownPreview.js`
- `src/editor/composables/useDocumentBridge.js`
- `src/editor/codemirror/outline.js`

## Implemented Optimizations

- **Outline extraction moved into CM6.** `outlineExtension()` reads the CM6 document after edits settle, then emits heading data to Vue. `SidebarOutline.vue` is presentational and no longer parses Markdown during render.
- **Markdown preview is deferred.** `useDeferredMarkdownPreview()` delays `marked()` work and skips it entirely in source-only mode. Switching into split/preview renders immediately for correctness.
- **Panel document context is throttled.** `useDocumentBridge()` batches browser fallback `shoulders:doc` writes and Tauri `document_context_send` events outside the immediate edit path.
- **Citation diagnostics are lighter in the editor.** CM6 citation wiring gets reference items and duplicate-key diagnostics. Full cited-key scans remain in refs/export surfaces where the content is needed.
- **Save feedback is derived, not polled.** The footer reads cheap save-state refs and a delayed feedback flag. It does not serialize editor content or perform disk work during typing.

## Timing Budgets

- Content snapshot sync: `150ms`
- Outline extraction: `160ms` plus idle scheduling
- Preview render: `180ms` plus idle scheduling
- Document bridge: `650ms`
- Autosave: `1000ms` via `autoSaveController.js`, with a flush before save
- Slow save indicator: `400ms` delay before showing `Saving...`

These delays are intentionally short enough to keep side panels fresh while keeping burst typing and paste operations responsive.

## Current Measurement

Outline extraction benchmark from the CM6 `Text` document:

```bash
bun - <<'JS'
import { Text } from '@codemirror/state'
import { extractOutline } from './src/editor/codemirror/outline.js'

const lines = []
for (let i = 0; i < 20000; i++) {
  lines.push(i % 12 === 0 ? `### Heading ${i}` : `Paragraph ${i}`)
}
const doc = Text.of(lines)
const runs = []
for (let i = 0; i < 20; i++) {
  const t0 = performance.now()
  extractOutline(doc)
  runs.push(performance.now() - t0)
}
runs.sort((a, b) => a - b)
console.log({ medianMs: runs[10], p95Ms: runs[18] })
JS
```

Observed on 2026-05-11: 20k lines / 1667 headings, median `1.482ms`, p95 `3.121ms`.

## Further Work

Only add more machinery if a measured long-document case still lags:

- Make outline extraction incremental or syntax-tree based if the deferred full scan becomes visible with the outline panel open.
- Parse preview in a worker if split/preview mode lags on large Markdown documents.
- Move remaining full-content consumers to explicit active-panel reads if a sidebar panel still causes edit latency.
