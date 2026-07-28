import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { useFileStore } from '../../stores/files.js'
import { useSettingsStore } from '../../stores/settings.js'
import * as operations from '../../services/workspaceFileOperations.js'
import { loadGitChanges } from '../../services/gitChanges.js'
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

vi.mock('../../services/gitChanges.js', () => ({
  loadGitChanges: vi.fn(async () => []),
}))

// Records the drag-drop handlers the Files panel registers on the webview, so
// the tests can raise the native events Tauri would deliver.
const dragDrop = vi.hoisted(() => ({ handlers: [] }))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    setZoom: vi.fn(async () => undefined),
    onDragDropEvent: async (handler) => {
      dragDrop.handlers.push(handler)
      return () => {}
    },
  }),
}))

vi.mock('../../services/workspaceFileOperations.js', () => ({
  listWorkspaceDirectory: vi.fn(async () => []),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  duplicateWorkspaceEntry: vi.fn(),
  importWorkspaceEntries: vi.fn(),
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
    store.treeChildren = { '': browseEntries }
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

  it('starts with a dense Project tree and exposes Project, Recent, and Favorites', () => {
    const wrapper = render()
    const rows = wrapper.findAll('[data-file-row]')

    expect(wrapper.get('[data-files-mode="project"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-files-mode="recent"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-mode="favorites"]').exists()).toBe(true)
    expect(rows.map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/new.md',
      '/w/chart.png',
    ])
    expect(wrapper.get('[data-files-new-file]').attributes('title')).toContain('New file')
    expect(wrapper.get('[data-files-new-folder]').attributes('title')).toContain('New folder')
    expect(wrapper.get('[data-files-refresh]').exists()).toBe(true)
    expect(wrapper.get('[data-files-search]').attributes('placeholder')).toBe('Filter project files')
  })

  it('lazily expands folders and uses preview-on-click, permanent-on-double-click', async () => {
    operations.listWorkspaceDirectory.mockResolvedValueOnce([{
      path: '/w/docs/guide.md',
      name: 'guide.md',
      relativePath: 'docs/guide.md',
      mtime: Date.now(),
      size: 512,
      isDirectory: false,
      textReadable: true,
    }])
    const wrapper = render()

    await wrapper.get('[data-file-row="/w/docs"] button').trigger('click')
    expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')
    expect(wrapper.find('[data-file-row="/w/docs/guide.md"]').exists()).toBe(true)

    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
      path: '/w/new.md',
      preview: true,
      entry: expect.objectContaining({ openBehavior: 'text' }),
    })])

    await wrapper.get('[data-file-row="/w/chart.png"] button').trigger('dblclick')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
      path: '/w/chart.png',
      preview: false,
      entry: expect.objectContaining({ openBehavior: 'external' }),
    })])
    expect(operations.openWorkspaceEntryNative).not.toHaveBeenCalled()
  })

  it('creates a named workspace file and immediately opens it', async () => {
    const store = useWorkspaceFilesStore()
    store.refresh = vi.fn(async () => undefined)
    const wrapper = render()
    await wrapper.get('[data-files-new-file]').trigger('click')
    await wrapper.get('[data-files-inline-name]').setValue('brief.md')
    await wrapper.get('form').trigger('submit')

    expect(operations.createWorkspaceFile).toHaveBeenCalledWith('brief.md')
    expect(store.refresh).not.toHaveBeenCalled()
    expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
      path: '/w/brief.md',
      preview: false,
    })])
  })

  it('offers the proven row actions from a native right-click gesture', async () => {
    const wrapper = render()
    await wrapper.get('[data-file-row="/w/new.md"]').trigger('contextmenu', {
      clientX: 22,
      clientY: 31,
    })

    const menu = wrapper.get('[data-files-context-menu]')
    expect(menu.text()).toContain('Open in Mimir')
    expect(menu.text()).toContain('Open in default app')
    expect(menu.text()).toContain('Add to Favorites')
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
    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F2' })
    await wrapper.get('[data-files-inline-name]').setValue('renamed.md')
    await wrapper.get('form').trigger('submit')

    expect(operations.renameWorkspaceEntry).toHaveBeenCalledWith('/w/new.md', 'renamed.md')
    await vi.waitFor(() => {
      expect(editorFiles.openFiles[0].path).toBe('/w/renamed.md')
    })
  })

  it('invokes the selected row menu from Shift+F10 and copies an absolute path', async () => {
    const wrapper = render()
    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F10', shiftKey: true })
    expect(wrapper.get('[data-files-context-menu]').exists()).toBe(true)
    await wrapper.get('[data-file-action="copy-path"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/w/new.md')
  })

  it('navigates an invoked context menu with native arrow and Enter behavior', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F10', shiftKey: true })
    const menu = wrapper.get('[data-files-context-menu]')
    wrapper.get('[data-file-action="open"]').element.focus()

    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'Enter' })

    expect(wrapper.get('[data-files-inline-name]').element).toBe(document.activeElement)
    wrapper.unmount()
  })

  it('uses Cmd+Shift+N for folders and confirms recoverable multi-delete', async () => {
    const wrapper = render()
    const list = wrapper.get('[data-files-list]')
    await list.trigger('keydown', { key: 'n', metaKey: true, shiftKey: true })
    await wrapper.get('[data-files-inline-name]').setValue('research')
    await wrapper.get('form').trigger('submit')
    expect(operations.createWorkspaceFolder).toHaveBeenCalledWith('research')

    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click', { metaKey: true })
    await wrapper.get('[data-file-row="/w/chart.png"] button').trigger('click', { metaKey: true })
    await list.trigger('keydown', { key: 'Backspace', metaKey: true })
    expect(wrapper.get('[data-files-delete-dialog]').text()).toContain('2 items')
    await wrapper.get('[data-files-confirm-delete]').trigger('click')
    expect(operations.trashWorkspaceEntries).toHaveBeenCalledWith([
      '/w/new.md',
      '/w/chart.png',
    ])
  })

  it('persists favorite files and folders as a dedicated working set', async () => {
    const wrapper = render()
    const settings = useSettingsStore()

    await wrapper.get('[data-file-row="/w/docs"] [data-file-favorite]').trigger('click')
    await wrapper.get('[data-file-row="/w/new.md"] [data-file-favorite]').trigger('click')

    expect(settings.workbenchFileFavorites['/w']).toEqual([
      { relativePath: 'docs', isDirectory: true },
      { relativePath: 'new.md', isDirectory: false },
    ])
    expect(wrapper.get('[data-files-mode="favorites"]').text()).toContain('2')

    await wrapper.get('[data-files-mode="favorites"]').trigger('click')
    expect(wrapper.findAll('[data-file-row]').map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/new.md',
    ])
  })

  it('builds Recent from actual editor history and keeps missing entries visible', async () => {
    const editorFiles = useFileStore()
    editorFiles.setRecentFiles(['/w/src/lib.rs', '/w/moved.md'])
    const wrapper = render()

    await wrapper.get('[data-files-mode="recent"]').trigger('click')

    expect(wrapper.findAll('[data-file-row]').map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/src/lib.rs',
      '/w/moved.md',
    ])
    expect(wrapper.get('[data-file-row="/w/moved.md"]').text()).toContain('Missing')
  })

  it('turns empty and error states into direct recovery actions', async () => {
    const store = useWorkspaceFilesStore()
    store.files = []
    store.treeChildren = { '': [] }
    const wrapper = render()
    expect(wrapper.get('[data-files-empty]').text()).toContain('Create a file')

    store.error = 'Workspace was removed'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-files-error]').text()).toContain('Workspace was removed')
    await wrapper.get('[data-files-retry]').trigger('click')
    expect(operations.listWorkspaceDirectory).toHaveBeenCalled()
  })

  it('never couples Activity navigation to a full workspace refresh', async () => {
    const store = useWorkspaceFilesStore()
    store.refresh = vi.fn(async () => undefined)
    const wrapper = render({ active: false })

    await wrapper.setProps({ active: true })
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })

    expect(store.refresh).not.toHaveBeenCalled()
  })

  it('debounces project filtering until roughly 130ms of quiet typing', async () => {
    vi.useFakeTimers()
    try {
      const store = useWorkspaceFilesStore()
      const setQuery = vi.spyOn(store, 'setQuery').mockResolvedValue(undefined)
      const wrapper = render()
      await wrapper.get('[data-files-search]').setValue('lib')

      await vi.advanceTimersByTimeAsync(100)
      expect(setQuery).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(40)
      expect(setQuery).toHaveBeenCalledWith('lib')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks changed directories from the precomputed git status map', async () => {
    loadGitChanges.mockResolvedValueOnce([
      { path: 'docs/deep/guide.md', status: 'modified' },
      { path: 'new.md', status: 'new' },
    ])
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-file-row="/w/docs"]').text()).toContain('M')
    expect(wrapper.get('[data-file-row="/w/new.md"]').text()).toContain('A')
    expect(wrapper.get('[data-file-row="/w/chart.png"]').text()).not.toContain('M')
  })

  function seedLargeTree(count = 400) {
    const store = useWorkspaceFilesStore()
    store.treeChildren = {
      '': Array.from({ length: count }, (_, index) => ({
        path: `/w/f${index}.md`,
        name: `f${index}.md`,
        relativePath: `f${index}.md`,
        mtime: Date.now(),
        size: 10,
        isDirectory: false,
        textReadable: true,
      })),
    }
    return count
  }

  describe('drag and drop from outside', () => {
    // Tauri intercepts OS drags and reports them through the webview event
    // instead of a DOM drop, so the test drives that event directly.
    async function renderWithDrop() {
      window.__TAURI_INTERNALS__ = {}
      dragDrop.handlers.length = 0
      const wrapper = render()
      await flushPromises()
      const handler = dragDrop.handlers.at(-1)
      const list = wrapper.get('[data-files-list]').element
      const hover = (selector) => {
        document.elementFromPoint = vi.fn(
          () => (selector ? wrapper.get(selector).element : list),
        )
      }
      return { wrapper, handler, hover }
    }

    afterEach(() => {
      delete window.__TAURI_INTERNALS__
    })

    it('imports into the hovered folder and marks it while dragging', async () => {
      operations.importWorkspaceEntries.mockResolvedValue({
        entries: [{ path: '/w/docs/brief.md', relativePath: 'docs/brief.md', name: 'brief.md' }],
        skippedLinks: 0,
      })
      const { wrapper, handler, hover } = await renderWithDrop()

      hover('[data-file-row="/w/docs"]')
      await handler({ payload: { type: 'enter', position: { x: 0, y: 0 }, paths: ['/D/brief.md'] } })
      await flushPromises()
      expect(wrapper.get('[data-file-row="/w/docs"]').attributes('data-file-drop-target')).toBe('')

      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/brief.md'] } })
      await flushPromises()

      expect(operations.importWorkspaceEntries).toHaveBeenCalledWith('docs', ['/D/brief.md'])
      expect(wrapper.find('[data-file-drop-target]').exists()).toBe(false)
      // The destination is reloaded so the arrivals show up.
      expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')
    })

    it('imports into the workspace root over empty space and reports skipped links', async () => {
      operations.importWorkspaceEntries.mockResolvedValue({
        entries: [{ path: '/w/photos', relativePath: 'photos', name: 'photos' }],
        skippedLinks: 2,
      })
      const { wrapper, handler, hover } = await renderWithDrop()

      hover(null)
      await handler({ payload: { type: 'over', position: { x: 0, y: 0 } } })
      await flushPromises()
      expect(wrapper.get('[data-files-list]').attributes('data-files-drop-root')).toBe('')

      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/photos'] } })
      await flushPromises()

      expect(operations.importWorkspaceEntries).toHaveBeenCalledWith('', ['/D/photos'])
      // Nothing failed, so the notice must not be dressed up as an error.
      expect(wrapper.get('[data-files-operation-notice]').text())
        .toContain('2 symbolic links inside the drop were skipped')
      expect(wrapper.get('[data-files-operation-notice]').attributes('role')).toBe('status')
      expect(wrapper.find('[data-files-operation-error]').exists()).toBe(false)
    })

    it('shows what did land when only some of the drop failed', async () => {
      operations.importWorkspaceEntries.mockResolvedValue({
        entries: [{ path: '/w/docs/brief.md', relativePath: 'docs/brief.md', name: 'brief.md' }],
        skippedLinks: 0,
        failures: ['sketch.png could not be read: No such file or directory'],
      })
      const { wrapper, handler, hover } = await renderWithDrop()

      hover('[data-file-row="/w/docs"]')
      await handler({
        payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/brief.md', '/D/sketch.png'] },
      })
      await flushPromises()

      expect(wrapper.get('[data-files-operation-error]').text()).toContain('sketch.png')
      // The file that did arrive is still reconciled into the tree.
      expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')
    })

    it('selects and focuses the arrivals the view actually shows', async () => {
      const photos = {
        path: '/w/photos', name: 'photos', relativePath: 'photos',
        mtime: Date.now(), size: 0, isDirectory: true, textReadable: false,
      }
      operations.listWorkspaceDirectory.mockResolvedValue([...browseEntries, photos])
      operations.importWorkspaceEntries.mockResolvedValue({
        entries: [{ path: '/w/photos', relativePath: 'photos', name: 'photos' }],
        skippedLinks: 0,
        failures: [],
      })
      const { wrapper, handler, hover } = await renderWithDrop()

      hover(null)
      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/photos'] } })
      await flushPromises()

      expect(wrapper.get('[data-file-row="/w/photos"]').attributes('aria-selected')).toBe('true')
      expect(wrapper.get('footer').text()).toContain('1 selected')
    })

    it('leaves selection and focus alone when the arrival is not on screen', async () => {
      operations.importWorkspaceEntries.mockResolvedValue({
        entries: [{ path: '/w/docs/brief.md', relativePath: 'docs/brief.md', name: 'brief.md' }],
        skippedLinks: 0,
        failures: [],
      })
      const { wrapper, handler, hover } = await renderWithDrop()

      // Focus and select the last row, then import into a folder whose new
      // child the reload does not surface.
      await wrapper.get('[data-file-row="/w/chart.png"] button').trigger('click')
      operations.listWorkspaceDirectory.mockResolvedValue([])
      hover('[data-file-row="/w/docs"]')
      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/brief.md'] } })
      await flushPromises()

      expect(wrapper.get('[data-file-row="/w/chart.png"]').attributes('aria-selected')).toBe('true')

      // Focus is still on the last row: stepping up lands on its neighbour,
      // not on the row a reset-to-zero focus would wrap around to.
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'ArrowUp' })
      expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
    })

    it('surfaces a failed import without leaving the panel highlighted', async () => {
      operations.importWorkspaceEntries.mockRejectedValue(new Error('Disk is full'))
      const { wrapper, handler, hover } = await renderWithDrop()

      hover('[data-file-row="/w/docs"]')
      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/brief.md'] } })
      await flushPromises()

      expect(wrapper.get('[data-files-operation-error]').text())
        .toContain('Dropped items could not be added: Disk is full')
      expect(wrapper.find('[data-file-drop-target]').exists()).toBe(false)
      // Even a hard failure reloads the destination: earlier sources in the
      // batch may already have landed.
      expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')
    })
  })

  it('windows large trees behind spacers that preserve scroll geometry', () => {
    const count = seedLargeTree(400)
    const wrapper = render()
    const rows = wrapper.findAll('[data-file-row]')
    const spacers = wrapper.findAll('[data-files-spacer]')

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(count)
    expect(rows[0].attributes('data-file-row')).toBe('/w/f0.md')
    expect(spacers.length).toBeGreaterThan(0)
    const spacerHeight = spacers.reduce(
      (sum, spacer) => sum + Number.parseInt(spacer.element.style.height, 10),
      0,
    )
    expect(spacerHeight + rows.length * 28).toBe(count * 28)
  })

  it('keeps the keyboard-focused row mounted outside the virtual window', async () => {
    seedLargeTree(400)
    const wrapper = render()
    expect(wrapper.find('[data-file-row="/w/f399.md"]').exists()).toBe(false)

    await wrapper.get('[data-files-list]').trigger('keydown', { key: 'ArrowUp' })

    expect(wrapper.find('[data-file-row="/w/f399.md"]').exists()).toBe(true)
    expect(wrapper.get('[data-file-row="/w/f399.md"]').attributes('aria-selected')).toBe('true')
  })
})
