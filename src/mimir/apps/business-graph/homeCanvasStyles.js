import { EditorView } from '@codemirror/view'

// Only layout differs from the main Editor. Typography, syntax, live preview,
// links, tables, and checkboxes use the Editor's shared extensions.
export const canvasLayout = EditorView.theme({
  '&': { height: 'auto', minHeight: 'var(--graph-editor-min-height)', backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'visible', backgroundColor: 'transparent' },
  '.cm-content': { minHeight: 'var(--graph-editor-min-height)', padding: '4px 0 28px' },
})
