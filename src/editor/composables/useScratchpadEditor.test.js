import { computed, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import { useFileStore } from '../../stores/files.js'
import { useScratchpadStore } from '../../stores/scratchpad.js'
import { useScratchpadEditor } from './useScratchpadEditor.js'

async function setup() {
  const store = useScratchpadStore()
  store.path = '/home/.mimir/scratchpad.md'
  store.content = 'First'
  store.history = [{ time: 1, content: 'First' }]
  const fileManager = useFileStore()
  await fileManager.openFile(store.path, 'First', { meta: { scratchpad: true } })
  const currentFile = computed(() => fileManager.currentFile)
  const save = vi.fn(async ({ file }) => { await store.save(file.content, file.scratchpadBase); file.dirty = false; return true })
  store.refresh = vi.fn(async () => {})
  store.save = vi.fn(async (content, expected) => {
    if (expected !== store.content) throw Error('Conflict')
    store.content = content
    store.history.push({ time: store.history.length + 1, content })
  })
  const options = { fileManager, currentFile, flush: vi.fn(), sync: vi.fn(), open: vi.fn(), save,
    ownsFocus: vi.fn(() => false), reviewing: vi.fn(() => false), reveal: vi.fn(), reportError: vi.fn() }
  const editor = useScratchpadEditor(options)
  return { store, fileManager, options, editor }
}

describe('Scratchpad editor', () => {
  it('reveals an external save without requesting keyboard focus', async () => {
    const { store, fileManager, options, editor } = await setup()
    store.content = 'Agent text'
    store.externalChange++
    await flushPromises()
    expect(fileManager.currentFile.content).toBe('Agent text')
    expect(options.open).toHaveBeenCalledWith(store.path, { focus: false })
    expect(options.reveal).toHaveBeenCalledWith({ focus: false })
    editor.dispose()
  })

  it('preserves dirty text and retains both sides when Use latest is chosen', async () => {
    const { store, fileManager, editor } = await setup()
    fileManager.updateContent('Human text')
    store.content = 'Agent text'
    store.history.push({ time: 2, content: 'Agent text' })
    await nextTick()
    expect(fileManager.currentFile.content).toBe('Human text')
    expect(editor.conflict.value).toBe(true)
    await editor.replace(store.content, { useLatest: true })
    expect(store.history.map(s => s.content)).toEqual(['First', 'Agent text', 'Human text', 'Agent text'])
    expect(fileManager.currentFile.content).toBe('Agent text')
    expect(fileManager.currentFile.dirty).toBe(false)
    editor.dispose()
  })

  it('keeps a displayed history entry stable during external saves; browsing never writes', async () => {
    const { store, fileManager, options, editor } = await setup()
    await editor.browse(store.history[0])
    store.content = 'Later text'
    store.externalChange++
    await nextTick(); await nextTick(); await nextTick()
    expect(editor.selected.value.content).toBe('First')
    expect(fileManager.currentFile.content).toBe('Later text')
    expect(editor.pending.value).toBe(true)
    expect(options.open).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    await editor.replace(editor.selected.value.content)
    expect(store.save).toHaveBeenCalledWith('First', 'Later text')
    editor.dispose()
  })

  it('does not replace another editor tab while it owns focus', async () => {
    const { store, fileManager, options, editor } = await setup()
    await fileManager.openFile('/project/email.md', 'Writing')
    options.ownsFocus.mockReturnValue(true)
    store.externalChange++
    await nextTick(); await nextTick(); await nextTick()
    expect(options.open).not.toHaveBeenCalled()
    expect(editor.pending.value).toBe(true)
    expect(fileManager.currentFile.path).toBe('/project/email.md')
    editor.dispose()
  })

  it('saves pending typing before Clear and keeps Scratchpad global across projects', async () => {
    const { fileManager, editor, store } = await setup()
    fileManager.updateContent('Unfinished text')
    await editor.replace('')
    expect(store.history.map(s => s.content)).toEqual(['First', 'Unfinished text', ''])
    fileManager.setWorkspaceScope('/elsewhere', ['/home', '/elsewhere'])
    expect(fileManager.visibleOpenFiles.some(file => file.path === store.path)).toBe(true)
    editor.dispose()
  })

  it('retains text typed while Restore is waiting for the file write', async () => {
    const { fileManager, editor, store } = await setup()
    let finish
    store.save.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => { store.content = 'Restored text'; resolve() }
    }))
    const restoring = editor.replace('Restored text')
    fileManager.updateContent('Typing during restore')
    finish()
    await restoring
    expect(store.content).toBe('Restored text')
    expect(fileManager.currentFile.content).toBe('Typing during restore')
    expect(fileManager.currentFile.dirty).toBe(true)
    editor.dispose()
  })
})
