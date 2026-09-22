import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { EditorView } from '@codemirror/view'
import WorkbenchApp from './WorkbenchApp.vue'
import { useFileStore } from '../stores/files.js'
import { useWorkspaceFilesStore } from '../stores/workspaceFiles.js'
import { useSettingsStore } from '../stores/settings.js'
import { useWorkbenchStore } from '../stores/workbench.js'

const io = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../services/fileSystem.js', async original => ({ ...(await original()), readFile: io.read }))
vi.mock('../services/fileIndex.js', async original => ({
  ...(await original()),
  openWorkspaceIndex: vi.fn(async () => entries),
  listIndexedFiles: vi.fn(async () => entries),
  filterIndexedFiles: vi.fn(async () => []),
  beginContentSearch: vi.fn(async () => ({ requestGeneration: 1, workspaceGeneration: 1 })),
  cancelContentSearch: vi.fn(async () => true),
  searchIndexedContent: vi.fn(async () => ({
    matches: [{ path: '/work/b.md', relativePath: 'b.md', line: 2, column: 3, excerpt: 'A needle here' }],
    cancelled: false, truncated: false,
  })),
}))
vi.mock('../services/toolRuntime.js', () => ({
  createToolRuntime: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }),
}))
vi.mock('../editor/nativeMenu.js', () => ({
  installNativeEditorMenu: vi.fn(async () => true), shouldInstallNativeEditorMenu: () => false,
}))

let entries
function entry(name) {
  return { path: `/work/${name}`, relativePath: name, name, isDirectory: false, textReadable: true, openBehavior: 'text', mtime: 1, size: 30 }
}

// Keep Files -> Workbench -> Editor and CodeMirror real. Only native I/O is mocked.
describe('Files keyboard focus through Workbench', () => {
  let wrapper
  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    entries = ['a.md', 'b.md', 'c.md'].map(entry)
    io.read.mockReset().mockImplementation(async path => `Text of ${path}\nA needle here\n`)
    const storage = new Map([['mimir:editor:settings:v1', JSON.stringify({ mimirWorkspaceFolder: '/work' })]])
    vi.stubGlobal('localStorage', {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    })
    delete window.__TAURI_INTERNALS__
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 })
    vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
      if (command === 'workspace_file_list_directory') return entries
      if (command === 'workspace_file_rename') {
        const renamed = entry(args.newName)
        entries = entries.map(item => item.path === args.path ? renamed : item)
        useWorkspaceFilesStore().files = entries
        return renamed
      }
      if (command === 'app_catalog') return { directory: '/apps', diagnostics: [], apps: [] }
      if (command === 'activity_list') return []
      if (command === 'chat_config') return { enabled: false }
      if (command === 'chat_status') return { state: 'disabled' }
      return null
    })
    useSettingsStore().editorAutoSave = false
    wrapper = mount(WorkbenchApp, { attachTo: document.body, global: { plugins: [pinia], stubs: {
      EmbeddedAppHost: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true,
    } } })
    await flushPromises()
  })

  afterEach(async () => {
    wrapper?.unmount()
    await flushPromises()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function row(name) { return wrapper.get(`[data-sidebar-files] [data-file-row="/work/${name}"] button`) }
  function editor() { return EditorView.findFromDOM(wrapper.get('[data-pane="editor"] .cm-editor').element) }
  async function key(key, options = {}) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
    await nextTick()
  }

  it.each([false, true])('keeps Return in Files after a click (delayed read=%s)', async delayed => {
    await row('a.md').trigger('dblclick')
    await flushPromises()
    expect(editor().hasFocus).toBe(true)
    let finishRead
    if (delayed) io.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    await row('b.md').trigger('click')
    if (!delayed) await flushPromises()
    expect(document.activeElement).toBe(row('b.md').element)
    await key('Enter')
    const input = wrapper.get('[data-files-inline-name]').element
    expect(document.activeElement).toBe(input)
    if (delayed) finishRead('Text of /work/b.md\nA needle here\n')
    await flushPromises()
    expect(document.activeElement).toBe(input)
    const files = useFileStore()
    expect(files.currentFile).toMatchObject({ path: '/work/b.md', preview: true, dirty: false, content: 'Text of /work/b.md\nA needle here\n' })
    expect(files.openFiles.find(file => file.path === '/work/a.md').dirty).toBe(false)
    await key('Escape')
    await flushPromises()
    expect(document.activeElement).toBe(row('b.md').element)
  })

  it('saves a rename and returns selection and keyboard focus to the new path', async () => {
    await row('b.md').trigger('click')
    await flushPromises()
    const files = useFileStore()
    const documentId = files.currentFile.id
    const text = files.currentFile.content
    await key('Enter')
    await wrapper.get('[data-files-inline-name]').setValue('renamed.md')
    await key('Enter')
    await flushPromises()
    expect(files.currentFile).toMatchObject({ id: documentId, path: '/work/renamed.md', content: text, dirty: false })
    expect(wrapper.get('[data-file-row="/work/renamed.md"]').attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(row('renamed.md').element)
    await key('ArrowUp')
    await flushPromises()
    expect(document.activeElement).toBe(row('c.md').element)
  })

  it('renames the clicked Recent file after opening it moves it to the top', async () => {
    const files = useFileStore()
    files.recentFiles = ['/work/a.md', '/work/b.md', '/work/c.md']
    await wrapper.get('[data-files-mode="recent"]').trigger('click')
    await row('b.md').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-file-row]')[0].attributes('data-file-row')).toBe('/work/b.md')
    expect(document.activeElement.closest('[data-file-row]')?.getAttribute('data-file-row')).toBe('/work/b.md')
    await key('Enter')
    expect(wrapper.get('[data-files-inline-name]').element.value).toBe('b.md')
    await key('Escape')
    await flushPromises()
    await key('ArrowDown', { metaKey: true })
    await flushPromises()
    expect(files.currentFile).toMatchObject({ path: '/work/b.md', preview: false })
  })

  it('keeps double-clicked and edited tabs while later previews replace only clean previews', async () => {
    await row('a.md').trigger('dblclick')
    await flushPromises()
    const files = useFileStore()
    expect(files.currentFile).toMatchObject({ path: '/work/a.md', preview: false })
    expect(editor().hasFocus).toBe(true)
    await row('b.md').trigger('click')
    await flushPromises()
    await row('c.md').trigger('click')
    await flushPromises()
    expect(files.openFiles.map(file => file.path).filter(Boolean)).toEqual(['/work/a.md', '/work/c.md'])
    const view = editor()
    view.focus()
    view.dispatch({ changes: { from: 0, insert: 'Edited: ' }, userEvent: 'input.type' })
    expect(files.currentFile).toMatchObject({ preview: false, dirty: true })
    await row('b.md').trigger('click')
    await flushPromises()
    expect(files.openFiles.map(file => file.path).filter(Boolean)).toEqual(['/work/a.md', '/work/c.md', '/work/b.md'])
    await key('ArrowDown', { metaKey: true })
    await flushPromises()
    expect(files.currentFile).toMatchObject({ path: '/work/b.md', preview: false })
    expect(view.hasFocus).toBe(true)
    const before = files.currentFile.content
    await key('Enter')
    expect(files.currentFile.content.length).toBe(before.length + 1)
    expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
  })

  it('leaves focus at a later click while a rename finishes', async () => {
    await row('b.md').trigger('click')
    await flushPromises()
    await key('Enter')
    await wrapper.get('[data-files-inline-name]').setValue('renamed.md')
    const original = vi.mocked(invoke).getMockImplementation()
    let finishRename
    vi.mocked(invoke).mockImplementation((command, args) => command === 'workspace_file_rename'
      ? new Promise(resolve => { finishRename = () => resolve(original(command, args)) })
      : original(command, args))
    await key('Enter')
    await flushPromises()
    await row('c.md').trigger('click')
    await flushPromises()
    finishRename()
    await flushPromises()
    expect(document.activeElement).toBe(row('c.md').element)
    expect(wrapper.get('[data-file-row="/work/c.md"]').attributes('aria-selected')).toBe('true')
  })

  it('keeps a failed rename in the name field and preserves the document', async () => {
    await row('b.md').trigger('click')
    await flushPromises()
    const files = useFileStore()
    const text = files.currentFile.content
    await key('Enter')
    await wrapper.get('[data-files-inline-name]').setValue('a.md')
    const original = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'workspace_file_rename'
      ? Promise.reject(new Error('A file with this name already exists.')) : original(command, args))
    await key('Enter')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-files-inline-name]').element)
    expect(wrapper.get('[data-files-operation-error]').text()).toContain('already exists')
    expect(files.currentFile).toMatchObject({ path: '/work/b.md', content: text, dirty: false })
  })

  it('keeps a binary preview in Files until an explicit open focuses its Editor control', async () => {
    const binary = { ...entry('archive.zip'), textReadable: false, openBehavior: 'external' }
    entries = [...entries, binary]
    const workspace = useWorkspaceFilesStore()
    workspace.files = entries
    await workspace.loadTreeDirectory('', { force: true })
    await nextTick()
    await row('archive.zip').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(row('archive.zip').element)
    await key('ArrowDown', { metaKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-external-file-preview] [data-preview-open-native]').element)
    expect(useFileStore().currentFile.preview).toBe(false)
  })

  it('previews a content match without taking focus and opens it with Return', async () => {
    await wrapper.get('[data-files-search]').setValue('needle')
    await vi.waitFor(() => expect(wrapper.find('[data-files-search-match]').exists()).toBe(true))
    const match = wrapper.get('[data-files-search-match]')
    await match.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(match.element)
    expect(useFileStore().currentFile.preview).toBe(true)
    expect(editor().state.selection.main.head).toBe(editor().state.doc.line(2).from + 2)
    await key('Enter')
    await flushPromises()
    expect(useFileStore().currentFile.preview).toBe(false)
    expect(editor().hasFocus).toBe(true)
    expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
    expect(useWorkbenchStore().activeActivityId).toBe('')
  })
})
