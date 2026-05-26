export async function submitReview({ filePath, editorView, comments, target }) {
  let documentContent = null
  if (editorView) {
    documentContent = editorView.state.doc.toString()
  }

  const payload = {
    filePath,
    documentContent,
    target,
    comments: (comments || []).map(c => ({
      id: c.id,
      text: c.text,
      anchorText: c.anchorText,
      author: c.author,
      replies: (c.replies || []).map(r => ({ author: r.author, text: r.text })),
    })),
  }

  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('comments_submit', { payload })
    await invoke('focus_main_window')
  }
}
