import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { editorWindowChromeOptions } from '../shared/windowChrome.js'
import { loadSession } from '../services/session.js'

export function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__)
}

async function findEditorWindow() {
  if (!isTauriRuntime()) return null
  const all = await getAllWebviewWindows()
  return all.find(w => w.label.startsWith('editor-')) || null
}

export async function openOrFocusEditorWindow() {
  try {
    if (!isTauriRuntime()) {
      window.open('/?view=editor', 'shoulders-editor')
      return true
    }

    const existing = await findEditorWindow()
    if (existing) {
      await existing.setFocus()
      return true
    }

    return await createEditorWindow({ isNew: true })
  } catch (error) {
    console.error('Could not open editor window', error)
    return false
  }
}

export async function autoRestoreEditorWindow() {
  try {
    const existing = await findEditorWindow()
    if (existing) return

    const session = await loadSession()
    if (!session?.openFiles?.length) return

    await createEditorWindow({ isNew: false })
  } catch (error) {
    console.error('Could not auto-restore editor window', error)
  }
}

async function createEditorWindow({ isNew = true } = {}) {
  const label = `editor-${Date.now()}`
  const params = new URLSearchParams({ view: 'editor', window: label })
  if (isNew) params.set('new', '1')
  const url = `/?${params.toString()}`

  if (!isTauriRuntime()) {
    return Boolean(window.open(url, label, 'width=1280,height=860'))
  }

  const editorWindow = new WebviewWindow(label, {
    url,
    title: isNew ? 'Untitled - Shoulders' : 'Shoulders',
    width: 1280,
    height: 860,
    minWidth: 300,
    minHeight: 620,
    center: true,
    resizable: true,
    ...editorWindowChromeOptions,
  })

  return new Promise((resolve) => {
    editorWindow.once('tauri://created', () => resolve(true))
    editorWindow.once('tauri://error', (event) => {
      console.error('Could not create editor window', event.payload)
      resolve(false)
    })
  })
}
