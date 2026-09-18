import { nextTick } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { undo, redo } from '@codemirror/commands'
import App from './App.vue'
import EditorSurface from './components/workspace/EditorSurface.vue'
import { useFileStore } from '../stores/files.js'
import { useSettingsStore } from '../stores/settings.js'
import { createSessionSnapshot } from './sessionPersist.js'

const io = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('../services/session.js', () => ({ loadSession: vi.fn(async () => null), saveSession: vi.fn(async () => {}) }))
vi.mock('../services/fileSystem.js', () => ({ readFile: io.read, saveFile: io.save, openFileDialog: vi.fn(), saveFileDialog: vi.fn(), openHtmlInBrowser: vi.fn(), readBinaryFile: vi.fn() }))
vi.mock('./nativeMenu.js', () => ({ installNativeEditorMenu: vi.fn(async () => true), shouldInstallNativeEditorMenu: () => false }))
enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())
beforeEach(() => {
  io.read.mockReset().mockImplementation(async path => `Text of ${path}\n`)
  io.save.mockReset().mockResolvedValue(undefined)
  useSettingsStore().editorAutoSave = false
})

async function setup() {
  const files = useFileStore()
  const wrapper = mount(App, {
    props: { embedded: true, workspacePath: '/work', workspacePaths: ['/work'] },
    global: { stubs: { AppHeader: true, AppFooter: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true, Teleport: true, Transition: false } },
  })
  await flushPromises()
  const surface = wrapper.findComponent(EditorSurface)
  const open = (path, preview = false) => wrapper.vm.mimirOpen(path, { preview, entry: { openBehavior: 'text' } })
  const type = text => surface.vm.getView().dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' })
  return { files, wrapper, surface, open, type }
}

describe('document lifecycle with the real editor', () => {
  it('closes an untouched preview without a save prompt', async () => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md', true)
    const id = files.currentFile.id
    expect(await wrapper.vm.mimirCloseActiveTab()).toBe(true)
    expect(files.openFiles.some(file => file.id === id)).toBe(false)
    expect(wrapper.find('[aria-labelledby="close-confirm-title"]').exists()).toBe(false)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('pauses autosave during close confirmation and discards without a later write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore().editorAutoSave = true
    const { files, wrapper, open, type } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    type('Unsaved: ')
    const closing = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save).not.toHaveBeenCalled()
    await wrapper.get('.btn-discard').trigger('click')
    await closing
    await vi.advanceTimersByTimeAsync(1100)
    expect(files.openFiles).not.toContain(file)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('projects a reload containing protected comment tags exactly', async () => {
    const { files, surface, open } = await setup()
    const original = '<comment id="c1" author="user" text="Check">Old</comment>'
    io.read.mockResolvedValue(original)
    await open('/work/comments.md')
    const content = '<comment id="c2" author="user" text="Updated">New</comment>'
    files.replaceCleanContent(files.currentFile, content)
    await nextTick()
    expect(surface.vm.getContent()).toBe(content)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(files.currentFile.dirty).toBe(false)
  })

  it('replaces a preview document without inheriting text, Undo, or Redo', async () => {
    const { files, surface, open } = await setup()
    await open('/work/a.md', true)
    const a = files.currentFile
    await open('/work/b.md', true)
    const b = files.currentFile
    expect(b.id).not.toBe(a.id)
    expect(files.openFiles).not.toContain(a)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(redo(surface.vm.getView())).toBe(false)
    expect(surface.vm.getContent()).toBe('Text of /work/b.md\n')
    expect(b).toMatchObject({ content: 'Text of /work/b.md\n', dirty: false, preview: true })
    await open('/work/a.md', true)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('keeps each document history through tab switches and a rename', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    type('Edit A: ')
    expect(a.content).toBe('Edit A: Text of /work/a.md\n')
    await open('/work/b.md')
    type('Edit B: ')
    files.moveWorkspacePath('/work/a.md', '/work/renamed.md')
    await open('/work/renamed.md')
    expect(files.currentFile.id).toBe(a.id)
    expect(undo(surface.vm.getView())).toBe(true)
    expect(a.content).toBe('Text of /work/a.md\n')
    expect(a.dirty).toBe(false)
    expect(redo(surface.vm.getView())).toBe(true)
    expect(a.dirty).toBe(true)
    await open('/work/b.md')
    expect(undo(surface.vm.getView())).toBe(true)
    expect(files.currentFile.content).toBe('Text of /work/b.md\n')
  })

  it('saves typing made during another file read, including when both files are edited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore().editorAutoSave = true
    const { files, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    let finishRead
    io.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const opening = open('/work/b.md')
    type('During read: ')
    expect(a.content).toBe('During read: Text of /work/a.md\n')
    finishRead('File B\n')
    await opening
    type('Edit B: ')
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save.mock.calls).toEqual([
      ['/work/a.md', 'During read: Text of /work/a.md\n'],
      ['/work/b.md', 'Edit B: File B\n'],
    ])
    expect(a.dirty).toBe(false)
    expect(files.currentFile.dirty).toBe(false)
  })

  it('binds editor events to the loaded document during a pending render and rejects closed documents', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    const opening = files.openFile('/work/b.md', 'B')
    type('Before render: ')
    expect(a.content).toBe('Before render: Text of /work/a.md\n')
    expect(files.currentFile).toMatchObject({ content: 'B', dirty: false })
    await opening
    await nextTick()
    files.closeFile(files.openFiles.indexOf(a), { ensureOne: false })
    surface.vm.$emit('change', { fileId: a.id, content: 'late text' })
    expect(files.currentFile).toMatchObject({ content: 'B', dirty: false })
  })

  it.each(['\n', '\r\n', '\r'])('keeps line endings %j and a clean saved baseline through open, edit, undo, and save', async ending => {
    const content = ['first', 'second', ''].join(ending)
    io.read.mockResolvedValue(content)
    const { files, wrapper, surface, open, type } = await setup()
    await open('/work/lines.md', true)
    expect(wrapper.vm.mimirState({ includeContent: true }).active).toMatchObject({ content, dirty: false })
    type('New: ')
    expect(files.currentFile.content).toBe(`New: ${content}`)
    undo(surface.vm.getView())
    expect(files.currentFile).toMatchObject({ content, dirty: false })
    redo(surface.vm.getView())
    await wrapper.vm.mimirSave()
    expect(io.save).toHaveBeenCalledWith('/work/lines.md', `New: ${content}`)
    undo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(true)
    redo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(false)
  })

  it('does not add external reloads to Undo, but retains an accepted edit as an undo step', async () => {
    const { files, surface, open } = await setup()
    await open('/work/a.md')
    files.replaceCleanContent(files.currentFile, 'External text\n')
    await nextTick()
    expect(undo(surface.vm.getView())).toBe(false)
    files.updateContent('Accepted proposal\n', files.currentFile)
    await nextTick()
    expect(undo(surface.vm.getView())).toBe(true)
    expect(files.currentFile).toMatchObject({ content: 'External text\n', dirty: false })
  })

  it('keeps edits dirty when an earlier save completes and saves the current text next', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    type('First: ')
    let finishWrite
    io.save.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve }))
    const saving = files.save()
    undo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(true)
    finishWrite()
    expect(await saving).toBe(false)
    expect(files.currentFile.dirty).toBe(true)
    await files.save()
    expect(io.save).toHaveBeenLastCalledWith('/work/a.md', 'Text of /work/a.md\n')
    expect(files.currentFile.dirty).toBe(false)
  })

  it('retains immediate edits in session snapshots and uses disk text as the restored baseline', async () => {
    const { files, open, type } = await setup()
    await open('/work/a.md')
    type('Draft: ')
    const snapshot = createSessionSnapshot({ openFiles: { value: files.openFiles }, activeFileIndex: { value: files.activeFileIndex }, recentFiles: { value: [] }, zoomLevel: { value: 100 } })
    const entry = snapshot.openFiles.find(file => file.path === '/work/a.md')
    expect(entry).toMatchObject({ content: 'Draft: Text of /work/a.md\n', dirty: true })
    files.closeFile(files.activeFileIndex, { ensureOne: false })
    files.restorePath({ ...entry, savedContent: 'Text of /work/a.md\n' })
    files.updateContent('Text of /work/a.md\n')
    expect(files.currentFile.dirty).toBe(false)
  })
})
