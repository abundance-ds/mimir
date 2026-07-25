import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { useFileStore } from '../../stores/files.js'
import * as operations from '../../services/workspaceFileOperations.js'
import FilesActivity from './FilesActivity.vue'

vi.mock('../../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(async () => []),
  filterIndexedFiles: vi.fn(),
  refreshWorkspaceIndex: vi.fn(async () => ({ added: 0, changed: 0, removed: 0 })),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

vi.mock('../../services/workspaceFileOperations.js', () => ({
  listWorkspaceDirectory: vi.fn(async () => []),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  duplicateWorkspaceEntry: vi.fn(),
  trashWorkspaceEntries: vi.fn(),
  openWorkspaceEntryNative: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
}))

const indexed = [
  { path: '/w/new.md', name: 'new.md', relativePath: 'new.md', mtime: Date.now(), size: 1536, textReadable: true },
  { path: '/w/src/lib.rs', name: 'lib.rs', relativePath: 'src/lib.rs', mtime: Date.now() - 60_000, size: 82, textReadable: true },
]

const browseEntries = [
  { path: '/w/docs', name: 'docs', relativePath: 'docs', mtime: Date.now(), size: 0, isDirectory: true, textReadable: false },
  { path: '/w/new.md', name: 'new.md', relativePath: 'new.md', mtime: Date.now(), size: 1536, isDirectory: false, textReadable: true },
  { path: '/w/chart.png', name: 'chart.png', relativePath: 'chart.png', mtime: Date.now(), size: 2048, isDirectory: false, textReadable: false },
]

describe('FilesActivity', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    const store = useWorkspaceFilesStore()
    store.workspacePath = '/w'
    store.files = indexed
    store.directoryEntries = browseEntries
    operations.listWorkspaceDirectory.mockResolvedValue(browseEntries)
    operations.createWorkspaceFile.mockResolvedValue({
      path: '/w/brief.md',
      relativePath: 'brief.md',
      name: 'brief.md',
      isDirectory: false,
    })
    operations.createWorkspaceFolder.mockResolvedValue({
      path: '/w/research',
      relativePath: 'research',
      name: 'research',
      isDirectory: true,
    })
    operations.renameWorkspaceEntry.mockResolvedValue({
      path: '/w/renamed.md',
      relativePath: 'renamed.md',
      name: 'renamed.md',
      isDirectory: false,
    })
    operations.duplicateWorkspaceEntry.mockResolvedValue({
      path: '/w/new copy.md',
      relativePath: 'new copy.md',
      name: 'new copy.md',
      isDirectory: false,
    })
    operations.trashWorkspaceEntries.mockResolvedValue(['new.md'])
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
  })

  function render(props = {}) {
    return mount(FilesActivity, {
      props: { activity: { id: 'files', workspacePath: '/w' }, active: true, ...props },
      global: { plugins: [pinia] },
    })
  }

  it('starts recent-first while keeping the complete browser actions visible', () => {
    const wrapper = render()
    const rows = wrapper.findAll('[data-file-row]')

    expect(wrapper.get('[data-files-mode="recent"]').attributes('aria-pressed')).toBe('true')
    expect(rows.map((row) => row.attributes('data-file-row'))).toEqual(['/w/new.md', '/w/src/lib.rs'])
    expect(rows[0].text()).toContain('1.5 KB')
    expect(wrapper.get('[data-files-new-file]').attributes('title')).toContain('New file')
    expect(wrapper.get('[data-files-new-folder]').attributes('title')).toContain('New folder')
    expect(wrapper.get('[data-files-refresh]').exists()).toBe(true)
  })

  it('browses folders with breadcrumbs and opens text files in the existing editor', async () => {
    const wrapper = render()
    await wrapper.get('[data-files-mode="browse"]').trigger('click')

    expect(wrapper.findAll('[data-file-row]').map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/new.md',
      '/w/chart.png',
    ])
    await wrapper.get('[data-file-row="/w/docs"]').trigger('dblclick')
    expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')

    await wrapper.get('[data-file-row="/w/new.md"]').trigger('dblclick')
    expect(wrapper.emitted('openFile').at(-1)).toEqual(['/w/new.md'])

    await wrapper.get('[data-file-row="/w/chart.png"]').trigger('dblclick')
    expect(operations.openWorkspaceEntryNative).toHaveBeenCalledWith('/w/chart.png')
  })

  it('creates a named workspace file and immediately opens it', async () => {
    const wrapper = render()
    await wrapper.get('[data-files-new-file]').trigger('click')
    await wrapper.get('[data-files-name-input]').setValue('brief.md')
    await wrapper.get('[data-files-name-form]').trigger('submit')

    expect(operations.createWorkspaceFile).toHaveBeenCalledWith('brief.md')
    expect(wrapper.emitted('openFile').at(-1)).toEqual(['/w/brief.md'])
  })

  it('offers the proven row actions from a native right-click gesture', async () => {
    const wrapper = render()
    await wrapper.get('[data-file-row="/w/new.md"]').trigger('contextmenu', {
      clientX: 22,
      clientY: 31,
    })

    const menu = wrapper.get('[data-files-context-menu]')
    expect(menu.text()).toContain('Open')
    expect(menu.text()).toContain('Open in default app')
    expect(menu.text()).toContain('Rename')
    expect(menu.text()).toContain('Duplicate')
    expect(menu.text()).toContain('Reveal in Finder')
    expect(menu.text()).toContain('Copy path')
    expect(menu.text()).toContain('Move to Trash')
  })

  it('renames through F2 and keeps open editor paths coherent', async () => {
    const editorFiles = useFileStore()
    await editorFiles.openFile('/w/new.md', '# Draft')
    const wrapper = render()
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F2' })
    await wrapper.get('[data-files-name-input]').setValue('renamed.md')
    await wrapper.get('[data-files-name-form]').trigger('submit')

    expect(operations.renameWorkspaceEntry).toHaveBeenCalledWith('/w/new.md', 'renamed.md')
    await vi.waitFor(() => {
      expect(editorFiles.openFiles[0].path).toBe('/w/renamed.md')
    })
  })

  it('invokes the selected row menu from Shift+F10 and copies an absolute path', async () => {
    const wrapper = render()
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F10', shiftKey: true })
    expect(wrapper.get('[data-files-context-menu]').exists()).toBe(true)
    await wrapper.get('[data-file-action="copy-path"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/w/new.md')
  })

  it('navigates an invoked context menu with native arrow and Enter behavior', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F10', shiftKey: true })
    const menu = wrapper.get('[data-files-context-menu]')
    wrapper.get('[data-file-action="open"]').element.focus()

    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'Enter' })

    expect(wrapper.get('[data-files-name-input]').element).toBe(document.activeElement)
    wrapper.unmount()
  })

  it('uses Cmd+Shift+N for folders and confirms recoverable multi-delete', async () => {
    const wrapper = render()
    const list = wrapper.get('[data-files-list]')
    await list.trigger('keydown', { key: 'n', metaKey: true, shiftKey: true })
    await wrapper.get('[data-files-name-input]').setValue('research')
    await wrapper.get('[data-files-name-form]').trigger('submit')
    expect(operations.createWorkspaceFolder).toHaveBeenCalledWith('research')

    await wrapper.get('[data-file-row="/w/new.md"]').trigger('click', { metaKey: true })
    await wrapper.get('[data-file-row="/w/src/lib.rs"]').trigger('click', { metaKey: true })
    await list.trigger('keydown', { key: 'Backspace', metaKey: true })
    expect(wrapper.get('[data-files-delete-dialog]').text()).toContain('2 items')
    await wrapper.get('[data-files-confirm-delete]').trigger('click')
    expect(operations.trashWorkspaceEntries).toHaveBeenCalledWith([
      '/w/new.md',
      '/w/src/lib.rs',
    ])
  })

  it('turns empty and error states into direct recovery actions', async () => {
    const store = useWorkspaceFilesStore()
    store.files = []
    const wrapper = render()
    expect(wrapper.get('[data-files-empty]').text()).toContain('Create a file')

    store.error = 'Workspace was removed'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-files-error]').text()).toContain('Workspace was removed')
    await wrapper.get('[data-files-retry]').trigger('click')
    expect(operations.listWorkspaceDirectory).toHaveBeenCalled()
  })

  it('refreshes only when opened instead of polling full workspace scans in the background', async () => {
    const store = useWorkspaceFilesStore()
    store.refresh = vi.fn(async () => undefined)
    const wrapper = render({ active: false })

    await wrapper.setProps({ active: true })

    expect(store.refresh).toHaveBeenCalledTimes(1)
  })
})
