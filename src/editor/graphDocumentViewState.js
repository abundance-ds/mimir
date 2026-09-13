// Transient view state belongs to an open document, not its persisted draft.
// Weak keys release note history when the FileStore releases the tab.
const views = new WeakMap()

export function graphDocumentViewState(file) {
  let view = views.get(file)
  if (!view || view.path !== file.path) {
    view = { path: file.path, note: null, scrollTop: 0, focusNote: false }
    views.set(file, view)
  }
  return view
}
