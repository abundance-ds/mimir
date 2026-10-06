import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { useFileStore } from '../../stores/files.js'
import { useSettingsStore } from '../../stores/settings.js'
import * as operations from '../../services/workspaceFileOperations.js'
import * as fileIndex from '../../services/fileIndex.js'
import { loadGitChanges } from '../../services/gitChanges.js'
import { loadGitReviewChanges } from '../../services/gitReview.js'
import { formatModifiedTime } from '../files/fileLedger.js'
import FilesActivity from './FilesActivity.vue'

vi.mock('../../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(async () => []),
  filterIndexedFiles: vi.fn(),
  refreshWorkspaceIndex: vi.fn(async () => ({ added: 0, changed: 0, removed: 0 })),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(async () => ({
    matches: [],
    cancelled: false,
    truncated: false,
  })),
}))

vi.mock('../../services/gitChanges.js', () => ({
  loadGitChanges: vi.fn(async () => []),
}))

vi.mock('../../services/gitReview.js', async importOriginal => ({
  ...(await importOriginal()),
  loadGitReviewChanges: vi.fn(async () => []),
  loadGitFileDiff: vi.fn(),
  stageGitFile: vi.fn(),
  unstageGitFile: vi.fn(),
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
  moveWorkspaceEntry: vi.fn(),
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
    localStorage.removeItem('mimir:editor:settings:v1')
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    fileIndex.beginContentSearch.mockImplementation(async () => ({
      requestGeneration: fileIndex.beginContentSearch.mock.calls.length,
      workspaceGeneration: 1,
    }))
    fileIndex.cancelContentSearch.mockResolvedValue(true)
    fileIndex.filterIndexedFiles.mockImplementation(async query => indexed
      .filter(file => file.relativePath.toLowerCase().includes(query.toLowerCase()))
      .map(file => ({ file, score: 1 })))
    fileIndex.searchIndexedContent.mockResolvedValue({ matches: [], cancelled: false, truncated: false })
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'managed_project_status') return Promise.resolve({ managed: false, state: 'notRepository' })
      return undefined
    })
    loadGitReviewChanges.mockResolvedValue([])
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

  afterEach(async () => {
    // Settings use a delayed save. Settle it before the next test creates a
    // store, so one test's sort order cannot become another test's default.
    await useSettingsStore(pinia).flush()
    localStorage.removeItem('mimir:editor:settings:v1')
  })

  it('provides compact views and file actions without metadata columns', async () => {
    const wrapper = render({ compact: true })
    await flushPromises()
    expect(wrapper.find('[data-files-ledger-columns]').exists()).toBe(false)
    expect(wrapper.find('[data-files-mode="changes"]').exists()).toBe(false)
    await wrapper.get('[data-files-mode="favorites"]').trigger('click')
    expect(wrapper.get('[data-files-mode="favorites"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[aria-label="File actions"]').trigger('click')
    await flushPromises()
    expect([...document.querySelectorAll('[role=menuitem]')].map(item => item.textContent.trim())).toEqual(['New file', 'New folder', 'Refresh', 'Collapse all', 'Open File Manager'])
    const collapse = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === 'Collapse all')
    expect(collapse.disabled).toBe(true)
    const manager = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.includes('Open File Manager'))
    manager.click()
    expect(wrapper.emitted('openManager')).toHaveLength(1)
    wrapper.unmount()
  })

  it('selects and identifies the current view through the narrow Files menu', async () => {
    const wrapper = render({ compact: true, collapsible: true })
    await flushPromises()
    await wrapper.get('[aria-label="Files view: File tree"]').trigger('click')
    await flushPromises()
    const menu = new DOMWrapper(document.querySelector('[role="menu"][aria-label="Files view: File tree"]'))
    expect(menu.findAll('[role="menuitemradio"]').map(item => item.text())).toEqual(['File tree', 'Favorites', 'Recent'])
    await menu.findAll('[role="menuitemradio"]')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="Files view: Favorites"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-mode="favorites"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[aria-label="Files view: Favorites"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]').textContent.trim()).toBe('Favorites')
    wrapper.unmount()
  })

  it.each(['project', 'favorites'])('collapses nested folders from the %s menu in both file panels', async mode => {
    const store = useWorkspaceFilesStore()
    const nested = { ...browseEntries[0], path: '/w/docs/deep', name: 'deep', relativePath: 'docs/deep' }
    const child = { ...indexed[0], path: '/w/docs/deep/guide.md', name: 'guide.md', relativePath: 'docs/deep/guide.md' }
    store.treeChildren = { '': browseEntries, docs: [nested], 'docs/deep': [child] }
    store.expandedDirectories = new Set(['docs', 'docs/deep'])
    useSettingsStore().workbenchFileFavorites = { '/w': [{ relativePath: 'docs', isDirectory: true }] }
    const sidebar = render({ compact: true, collapsible: true })
    const manager = render()
    document.body.appendChild(sidebar.element)
    try {
      await sidebar.get(`[data-files-mode="${mode}"]`).trigger('click')
      await sidebar.get('[data-file-row="/w/docs/deep/guide.md"] button').trigger('click')
      expect(manager.find('[data-file-row="/w/docs/deep/guide.md"]').exists()).toBe(true)
      const trigger = sidebar.get('[aria-label="File actions"]')
      await trigger.trigger('keydown', { key: 'ArrowDown' })
      const menu = document.querySelector('[role="menu"][aria-label="File actions"]')
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(document.activeElement.textContent).toBe('Collapse all')
      document.activeElement.click()
      await flushPromises()

      expect([...store.expandedDirectories]).toEqual([])
      expect(sidebar.find('[data-file-row="/w/docs/deep"]').exists()).toBe(false)
      expect(manager.find('[data-file-row="/w/docs/deep"]').exists()).toBe(false)
      expect(sidebar.find('[aria-selected="true"]').exists()).toBe(false)
      expect(sidebar.get(`[data-files-mode="${mode}"]`).attributes('aria-pressed')).toBe('true')
      expect(sidebar.emitted('collapse')).toBeUndefined()
      expect(document.activeElement).toBe(trigger.element)
      expect(document.querySelector('[role="menu"]')).toBeNull()

      await sidebar.get('[data-file-row="/w/docs"] button').trigger('click')
      expect(sidebar.get('[data-file-row="/w/docs/deep"]').attributes('aria-expanded')).toBe('false')
      expect(sidebar.find('[data-file-row="/w/docs/deep/guide.md"]').exists()).toBe(false)
    } finally {
      sidebar.unmount()
      manager.unmount()
    }
  })

  it('searches the project from Favorites and restores Favorites when cleared', async () => {
    const wrapper = render({ compact: true })
    await flushPromises()
    await wrapper.get('[data-files-mode="favorites"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-files-search]').setValue('new')
    await flushPromises()
    expect(wrapper.get('[data-files-mode="project"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[aria-label="Clear search"]').trigger('click')
    expect(wrapper.get('[data-files-mode="favorites"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('collapses the remembered tree during search and keeps the query and return view', async () => {
    const store = useWorkspaceFilesStore()
    store.expandedDirectories = new Set(['docs'])
    const wrapper = render({ compact: true })
    try {
      await wrapper.get('[data-files-mode="recent"]').trigger('click')
      await wrapper.get('[data-files-search]').setValue('new')
      await wrapper.get('[aria-label="File actions"]').trigger('click')
      const collapse = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === 'Collapse all')
      collapse.click()
      await flushPromises()

      expect([...store.expandedDirectories]).toEqual([])
      expect(wrapper.get('[data-files-search]').element.value).toBe('new')
      await wrapper.get('[aria-label="Clear search"]').trigger('click')
      expect(wrapper.get('[data-files-mode="recent"]').attributes('aria-pressed')).toBe('true')
    } finally {
      wrapper.unmount()
    }
  })

  it('finds a native filename result when the sidebar mounted before the workspace index loaded', async () => {
    vi.useFakeTimers()
    const store = useWorkspaceFilesStore()
    store.workspacePath = ''
    store.files = []
    store.treeChildren = {}
    const wrapper = render({ compact: true })
    try {
      store.workspacePath = '/w'
      store.files = indexed
      store.treeChildren = { '': browseEntries }
      await wrapper.vm.$nextTick()
      const found = { path: '/w/docs/found.md', name: 'found.md', relativePath: 'docs/found.md', textReadable: true }
      fileIndex.filterIndexedFiles.mockResolvedValue([{ file: found, score: 90 }])

      await wrapper.get('[data-files-search]').setValue('found')
      expect(wrapper.find('[data-files-search-pending]').exists()).toBe(true)
      expect(wrapper.find('[data-files-empty]').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(140)

      expect(wrapper.findAll('[data-files-search-match]').map(row => row.attributes('data-search-path'))).toEqual([found.path])
      await wrapper.get('[data-files-search-match]').trigger('click')
      expect(wrapper.emitted('openFile').at(-1)[0]).toMatchObject({ path: found.path, preview: true })
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('keeps filename results separate from the other Files panel and Quick Open', async () => {
    vi.useFakeTimers()
    const sidebar = render({ compact: true })
    const manager = render()
    const store = useWorkspaceFilesStore()
    try {
      await sidebar.get('[data-files-search]').setValue('new')
      await manager.get('[data-files-search]').setValue('lib')
      await vi.advanceTimersByTimeAsync(140)
      await store.setQuery('missing')
      await store.setQuery('')
      expect(sidebar.findAll('[data-files-search-match]').map(row => row.attributes('data-search-path'))).toEqual(['/w/new.md'])
      expect(manager.findAll('[data-files-search-match]').map(row => row.attributes('data-search-path'))).toEqual(['/w/src/lib.rs'])
      await manager.get('[aria-label="Clear search"]').trigger('click')
      expect(sidebar.get('[data-files-search]').element.value).toBe('new')
      expect(sidebar.findAll('[data-files-search-match]')).toHaveLength(1)
    } finally {
      sidebar.unmount()
      manager.unmount()
      vi.useRealTimers()
    }
  })

  it('keeps one clear control available while native content search is pending', async () => {
    vi.useFakeTimers()
    const wrapper = render({ compact: true })
    try {
      let finish
      fileIndex.searchIndexedContent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      await wrapper.get('[data-files-search]').trigger('focusin')
      await wrapper.get('[data-files-search]').setValue('needle')
      await vi.advanceTimersByTimeAsync(140)
      expect(wrapper.get('[data-files-search]').attributes('type')).toBe('text')
      expect(wrapper.get('[data-files-search]').attributes('role')).toBe('searchbox')
      expect(wrapper.findAll('[aria-label="Clear search"]')).toHaveLength(1)
      expect(wrapper.find('[data-files-search-pending]').exists()).toBe(true)
      expect(wrapper.find('[data-files-empty]').exists()).toBe(false)

      await wrapper.get('[aria-label="Clear search"]').trigger('click')
      expect(wrapper.find('[data-files-search-pending]').exists()).toBe(false)
      expect(wrapper.find('[data-file-row="/w/docs"]').exists()).toBe(true)
      finish({ matches: [{ path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'late needle' }], truncated: true })
      await flushPromises()
      expect(wrapper.find('[data-content-match]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('incomplete')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('shows one honest empty message when a content search was only partial', async () => {
    const wrapper = render({ compact: true })
    await wrapper.get('[data-files-search]').trigger('focusin')
    await completeContentQuery(wrapper, 'not found', [], { truncated: true })
    expect(wrapper.get('[data-files-empty]').text()).toBe('No matches in the files searched.')
    expect(wrapper.text()).not.toContain('No content matches')
    expect(wrapper.text()).not.toContain('Use a more specific phrase')
    expect(wrapper.text()).toContain('Some results were omitted')
    wrapper.unmount()
  })

  it.each(['project', 'favorites', 'recent'])('exits search through the %s view button and restores browsing', async mode => {
    const wrapper = render({ compact: true })
    await wrapper.get('[data-files-search]').trigger('focusin')
    await completeContentQuery(wrapper, 'needle', [], { truncated: true })
    await wrapper.get(`[data-files-mode="${mode}"]`).trigger('click')
    expect(wrapper.get('[data-files-search]').element.value).toBe('')
    expect(wrapper.get('[data-files-search]').attributes('placeholder')).toBe('Search files…')
    expect(wrapper.get(`[data-files-mode="${mode}"]`).attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-files-list]').attributes('role')).toBe('tree')
    expect(wrapper.text()).not.toContain('Some files were not fully searched')
    wrapper.unmount()
  })

  it('leaves filename results with Escape from a result row and restores the previous selection', async () => {
    vi.useFakeTimers()
    const wrapper = render({ compact: true })
    try {
      const list = wrapper.get('[data-files-list]')
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      list.element.scrollTop = 75
      await wrapper.get('[data-files-search]').setValue('lib')
      await vi.advanceTimersByTimeAsync(140)
      await wrapper.get('[data-files-search-match]').trigger('keydown', { key: 'Escape' })
      expect(wrapper.get('[data-files-search]').element.value).toBe('')
      expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
      expect(list.element.scrollTop).toBe(75)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('places Collapse beside the actions menu only in the Sidebar header', async () => {
    const wrapper = render({ compact: true, collapsible: true })
    const toolbar = wrapper.get('[data-files-compact-toolbar]')
    expect(toolbar.find('[data-files-collapse]').exists()).toBe(true)
    expect(toolbar.findAll('button').at(-2).attributes('aria-label')).toBe('File actions')
    await toolbar.get('[data-files-collapse]').trigger('click')
    expect(wrapper.emitted('collapse')).toHaveLength(1)
    await wrapper.setProps({ compact: false })
    expect(wrapper.find('[data-files-collapse]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps one search field and adds no controls on focus', async () => {
    const wrapper = render({ compact: true })
    const before = wrapper.get('[data-files-search]').element.parentElement.outerHTML
    await wrapper.get('[data-files-search]').trigger('focusin')
    expect(wrapper.get('[data-files-search]').element.parentElement.outerHTML).toBe(before)
    expect(wrapper.find('[data-files-search-scope]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps sidebar and manager content results and limits separate', async () => {
    const sidebar = render({ compact: true })
    const manager = render()
    await sidebar.get('[data-files-search]').trigger('focusin')
    const alpha = { path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'alpha' }
    const beta = { path: '/w/src/lib.rs', relativePath: 'src/lib.rs', line: 2, column: 1, excerpt: 'beta' }

    await completeContentQuery(sidebar, 'alpha', [alpha], { truncated: true })
    await completeContentQuery(manager, 'beta', [beta])
    expect(sidebar.get('[data-content-match]').text()).toContain('alpha')
    expect(sidebar.text()).toContain('Some results were omitted')
    expect(manager.get('[data-content-match]').text()).toContain('beta')
    expect(manager.text()).not.toContain('Some results were omitted')

    await manager.get('[data-files-mode="recent"]').trigger('click')
    expect(sidebar.get('[data-content-match]').text()).toContain('alpha')
    expect(sidebar.get('[data-files-search]').element.value).toBe('alpha')
    sidebar.unmount()
    manager.unmount()
  })

  it('restores the Favorites list after clearing a compact content query', async () => {
    const settings = useSettingsStore(pinia)
    settings.set('workbenchFileFavorites', { '/w': [{ relativePath: 'new.md', isDirectory: false }] })
    const wrapper = render({ compact: true })
    await wrapper.get('[data-files-mode="favorites"]').trigger('click')
    await wrapper.get('[data-files-search]').trigger('focusin')
    await completeContentQuery(wrapper, 'alpha', [{ path: '/w/src/lib.rs', relativePath: 'src/lib.rs', line: 1, column: 1, excerpt: 'alpha' }])
    expect(wrapper.get('[data-content-match]').text()).toContain('alpha')

    await wrapper.get('[data-files-search]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-files-mode="favorites"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-file-row="/w/new.md"]').text()).toContain('new.md')
    expect(wrapper.find('[data-content-match]').exists()).toBe(false)
    settings.set('workbenchFileFavorites', {})
    wrapper.unmount()
  })

  it('queues another presentation without canceling its search and drops only its own cleared request', async () => {
    vi.useFakeTimers()
    const sidebar = render({ compact: true })
    const manager = render()
    try {
      let finishAlpha
      fileIndex.searchIndexedContent.mockImplementationOnce(() => new Promise(resolve => { finishAlpha = resolve }))
      await sidebar.get('[data-files-search]').trigger('focusin')
      await sidebar.get('[data-files-search]').setValue('alpha')
      await vi.advanceTimersByTimeAsync(140)
      await manager.get('[data-files-search]').setValue('beta')
      await vi.advanceTimersByTimeAsync(140)

      expect(fileIndex.searchIndexedContent).toHaveBeenCalledTimes(1)
      expect(fileIndex.cancelContentSearch).not.toHaveBeenCalled()
      expect(sidebar.text()).toContain('Searching')
      expect(manager.text()).toContain('Searching')
      await manager.get('[data-files-search]').trigger('keydown', { key: 'Escape' })
      expect(fileIndex.cancelContentSearch).not.toHaveBeenCalled()
      finishAlpha({ matches: [{ path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'alpha' }], cancelled: false })
      await flushPromises()

      expect(sidebar.get('[data-content-match]').text()).toContain('alpha')
      expect(sidebar.text()).not.toContain('Searching')
      expect(manager.find('[data-content-match]').exists()).toBe(false)
      expect(manager.text()).not.toContain('Searching')
      expect(fileIndex.searchIndexedContent).toHaveBeenCalledTimes(1)
    } finally {
      sidebar.unmount()
      manager.unmount()
      vi.useRealTimers()
    }
  })

  it('cancels a replaced query and ignores its late result', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    try {
      let finishOld
      fileIndex.searchIndexedContent
        .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
        .mockResolvedValueOnce({ matches: [{ path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'current result' }], cancelled: false })
      await wrapper.get('[data-files-search]').setValue('old')
      await vi.advanceTimersByTimeAsync(140)
      await wrapper.get('[data-files-search]').setValue('current')
      await vi.advanceTimersByTimeAsync(140)
      expect(fileIndex.cancelContentSearch).toHaveBeenCalledWith({ requestGeneration: 1, workspaceGeneration: 1 })

      finishOld({ matches: [{ path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'stale result' }], cancelled: false })
      await flushPromises()
      expect(wrapper.get('[data-content-match]').text()).toContain('current result')
      expect(wrapper.text()).not.toContain('stale result')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  function render(props = {}) {
    return mount(FilesActivity, {
      props: { activity: { id: 'files', workspacePath: '/w' }, active: true, ...props },
      global: { plugins: [pinia] },
    })
  }

  async function openCompactActions(wrapper) {
    await wrapper.get('[aria-label="File actions"]').trigger('click')
    return new DOMWrapper(document.querySelector('[role="menu"][aria-label="File actions"]'))
  }

  function sortRow(menu, label) {
    return menu.get(`[role="menuitemradio"][aria-label^="${label},"]`)
  }

  it('toggles Name and Modified in the open sidebar menu and shares saved order with File Manager', async () => {
    const store = useWorkspaceFilesStore()
    const child = (name, mtime) => ({ ...indexed[0], path: `/w/docs/${name}`, relativePath: `docs/${name}`, name, mtime })
    store.treeChildren = {
      '': [browseEntries[0], { ...browseEntries[1], mtime: 100 }, { ...browseEntries[2], mtime: 200 }],
      docs: [child('old.md', 100), child('new.md', 200)],
    }
    store.expandedDirectories = new Set(['docs'])
    const sidebar = render({ compact: true })
    const manager = render()
    document.body.appendChild(sidebar.element)
    const paths = wrapper => wrapper.findAll('[data-file-row]').map(row => row.attributes('data-file-row'))
    try {
      await sidebar.get('[data-file-row="/w/new.md"] button').trigger('click')
      const menu = await openCompactActions(sidebar)
      expect(menu.findAll('[role="menuitemradio"]').map(item => item.attributes('aria-label')))
        .toEqual(['Name, A–Z', 'Modified, Newest first'])
      expect(document.querySelector('[data-files-sort-menu]')).toBeNull()
      expect(sortRow(menu, 'Name').attributes('aria-checked')).toBe('true')
      await sortRow(menu, 'Modified').trigger('click')
      expect(paths(sidebar)).toEqual(['/w/docs', '/w/docs/new.md', '/w/docs/old.md', '/w/chart.png', '/w/new.md'])
      expect(paths(manager)).toEqual(paths(sidebar))
      expect(manager.get('[data-file-sort-header="modified"]').attributes('aria-label')).toContain('Newest first')
      expect(document.activeElement).toBe(sortRow(menu, 'Modified').element)
      expect(sortRow(menu, 'Modified').attributes('aria-checked')).toBe('true')
      expect(sortRow(menu, 'Name').attributes('aria-checked')).toBe('false')

      await sortRow(menu, 'Modified').trigger('click')
      expect(sortRow(menu, 'Modified').attributes('aria-label')).toBe('Modified, Oldest first')
      expect(paths(sidebar)).toEqual(['/w/docs', '/w/docs/old.md', '/w/docs/new.md', '/w/new.md', '/w/chart.png'])
      expect(paths(manager)).toEqual(paths(sidebar))
      await sortRow(menu, 'Name').trigger('click')
      expect(sortRow(menu, 'Name').attributes('aria-label')).toBe('Name, A–Z')
      await sortRow(menu, 'Name').trigger('click')
      expect(sortRow(menu, 'Name').attributes('aria-label')).toBe('Name, Z–A')
      expect(paths(sidebar)).toEqual(['/w/docs', '/w/docs/old.md', '/w/docs/new.md', '/w/new.md', '/w/chart.png'])
      expect(manager.get('[data-file-sort-header="name"]').attributes('aria-label')).toContain('Z–A')
      expect(sidebar.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
      expect([...store.expandedDirectories]).toEqual(['docs'])
      expect(useSettingsStore().workbenchFileSort['/w'].project).toEqual({ key: 'name', direction: 'desc' })
      await useSettingsStore().flush()
      expect(JSON.parse(localStorage.getItem('mimir:editor:settings:v1')).workbenchFileSort['/w'].project)
        .toEqual({ key: 'name', direction: 'desc' })
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBe(menu.element)
      expect(document.activeElement).toBe(sortRow(menu, 'Name').element)

      const restored = render({ compact: true })
      try { expect(paths(restored)).toEqual(paths(sidebar)) } finally { restored.unmount() }
      await menu.findAll('[role="menuitem"]').find(item => item.text() === 'Open File Manager').trigger('click')
      expect(sidebar.emitted('openManager')).toHaveLength(1)
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBeNull()
    } finally {
      sidebar.unmount()
      manager.unmount()
    }
  })

  it('keeps per-view sorts and uses the sidebar default for File Manager-only fields', async () => {
    const settings = useSettingsStore()
    settings.set('workbenchFileSort', {
      '/w': { project: { key: 'name', direction: 'desc' } },
      '/other': { project: { key: 'size', direction: 'desc' } },
    })
    useFileStore().setRecentFiles(['/w/src/lib.rs', '/w/new.md'])
    const sidebar = render({ compact: true })
    try {
      await sidebar.get('[data-files-mode="recent"]').trigger('click')
      const recent = await openCompactActions(sidebar)
      expect(recent.findAll('[role="menuitemradio"]')).toHaveLength(2)
      expect(recent.find('[aria-checked="true"]').exists()).toBe(false)
      expect(sidebar.findAll('[data-file-row]').map(row => row.attributes('data-file-row')))
        .toEqual(['/w/src/lib.rs', '/w/new.md'])
      await sortRow(recent, 'Modified').trigger('click')
      expect(sidebar.findAll('[data-file-row]').map(row => row.attributes('data-file-row')))
        .toEqual(['/w/new.md', '/w/src/lib.rs'])
      await sidebar.get('[data-files-mode="favorites"]').trigger('click')
      const favorites = await openCompactActions(sidebar)
      expect(sortRow(favorites, 'Name').attributes('aria-checked')).toBe('true')
      expect(sortRow(favorites, 'Name').attributes('aria-label')).toBe('Name, A–Z')
      await sidebar.get('[data-files-mode="project"]').trigger('click')
      const project = await openCompactActions(sidebar)
      expect(sortRow(project, 'Name').attributes('aria-label')).toBe('Name, Z–A')
      useWorkspaceFilesStore().workspacePath = '/other'
      await flushPromises()
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBeNull()
      const other = await openCompactActions(sidebar)
      expect(sortRow(other, 'Name').attributes('aria-checked')).toBe('true')
      expect(sortRow(other, 'Name').attributes('aria-label')).toBe('Name, A–Z')
      expect(settings.workbenchFileSort['/other'].project).toEqual({ key: 'size', direction: 'desc' })
      expect(settings.workbenchFileSort['/w'].recent).toEqual({ key: 'modified', direction: 'desc' })
    } finally {
      sidebar.unmount()
    }
  })

  it('disables both sort rows during search and restores the browsing order', async () => {
    const settings = useSettingsStore()
    settings.set('workbenchFileSort', { '/w': { project: { key: 'name', direction: 'desc' } } })
    const sidebar = render({ compact: true })
    try {
      await sidebar.get('[data-files-search]').setValue('new')
      const search = await openCompactActions(sidebar)
      for (const row of search.findAll('[role="menuitemradio"]')) {
        expect(row.attributes('aria-label')).toContain('Search relevance')
        expect(row.element.disabled).toBe(true)
        expect(row.attributes('aria-checked')).toBe('false')
        await row.trigger('click')
      }
      await sidebar.get('[aria-label="Clear search"]').trigger('click')
      expect(sidebar.findAll('[data-file-row]').map(row => row.attributes('data-file-row')))
        .toEqual(['/w/docs', '/w/new.md', '/w/chart.png'])
      expect(sortRow(await openCompactActions(sidebar), 'Name').attributes('aria-label')).toBe('Name, Z–A')
      expect(settings.workbenchFileSort['/w'].project).toEqual({ key: 'name', direction: 'desc' })
      useWorkspaceFilesStore().workspacePath = ''
      await flushPromises()
      expect((await openCompactActions(sidebar)).findAll('[role="menuitemradio"]').every(row => row.element.disabled)).toBe(true)
    } finally {
      sidebar.unmount()
    }
  })

  it('keeps keyboard focus on sort rows until Escape, Tab, or an outside click closes the menu', async () => {
    const sidebar = render({ compact: true })
    document.body.appendChild(sidebar.element)
    try {
      const trigger = sidebar.get('[aria-label="File actions"]')
      await trigger.trigger('keydown', { key: 'ArrowDown' })
      const menu = new DOMWrapper(document.querySelector('[role="menu"][aria-label="File actions"]'))
      await menu.trigger('keydown', { key: 'ArrowDown' })
      await menu.trigger('keydown', { key: 'ArrowDown' })
      expect(document.activeElement).toBe(sortRow(menu, 'Name').element)
      document.activeElement.click()
      await flushPromises()
      expect(document.activeElement).toBe(sortRow(menu, 'Name').element)
      expect(sortRow(menu, 'Name').attributes('aria-label')).toBe('Name, Z–A')
      await menu.trigger('keydown', { key: 'ArrowDown' })
      expect(document.activeElement).toBe(sortRow(menu, 'Modified').element)
      document.activeElement.click()
      await flushPromises()
      expect(sortRow(menu, 'Modified').attributes('aria-checked')).toBe('true')
      await menu.trigger('keydown', { key: 'End' })
      expect(document.activeElement.textContent.trim()).toBe('Open File Manager')
      await menu.trigger('keydown', { key: 'Home' })
      expect(document.activeElement.textContent.trim()).toBe('New file')
      await menu.trigger('keydown', { key: 'Escape' })
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBeNull()
      expect(document.activeElement).toBe(trigger.element)
      const tabMenu = await openCompactActions(sidebar)
      await tabMenu.trigger('keydown', { key: 'Tab' })
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBeNull()
      expect(document.activeElement).toBe(trigger.element)
      await openCompactActions(sidebar)
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      await flushPromises()
      expect(document.querySelector('[role="menu"][aria-label="File actions"]')).toBeNull()
    } finally {
      sidebar.unmount()
    }
  })

  it('starts with a dense Project tree and exposes its stable views', () => {
    const wrapper = render()
    const rows = wrapper.findAll('[data-file-row]')

    expect(wrapper.get('[data-files-mode="project"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-files-mode="recent"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-mode="favorites"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-mode="changes"]').exists()).toBe(true)
    expect(rows.map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/chart.png',
      '/w/new.md',
    ])
    expect(wrapper.get('[data-files-new-file]').attributes('title')).toContain('New file')
    expect(wrapper.get('[data-files-new-folder]').attributes('title')).toContain('New folder')
    expect(wrapper.get('[data-files-refresh]').exists()).toBe(true)
    expect(wrapper.get('[data-files-search]').attributes('placeholder')).toBe('Search files…')
  })

  it('shows the adaptive file ledger with kind, exact modification time, size, and fixed favorite controls', () => {
    const wrapper = render()

    expect(wrapper.get('[data-files-ledger-header]').text()).toContain('Kind')
    expect(wrapper.get('[data-files-ledger-header]').text()).toContain('Modified')
    expect(wrapper.get('[data-files-ledger-header]').text()).toContain('Size')
    expect(wrapper.get('[data-file-row="/w/new.md"] [data-file-kind]').text()).toBe('Markdown')
    expect(wrapper.get('[data-file-row="/w/new.md"] [data-file-size]').text()).toBe('1.5 KB')
    expect(wrapper.get('[data-file-row="/w/new.md"] [data-file-modified]').text())
      .toBe(formatModifiedTime(indexed[0].mtime))
    expect(wrapper.get('[data-file-row="/w/docs"] [data-file-size]').text()).toBe('—')
    expect(wrapper.get('[data-file-row="/w/new.md"] [data-file-favorite]').classes())
      .not.toContain('opacity-0')
  })

  it('sorts from column headers, reverses on the second click, and preserves selection', async () => {
    const store = useWorkspaceFilesStore()
    const settings = useSettingsStore()
    store.treeChildren = { '': [
      { ...browseEntries[0] },
      { ...browseEntries[1], mtime: 100, size: 1536 },
      { ...browseEntries[2], mtime: 200, size: 2048 },
    ] }
    const wrapper = render()
    document.body.appendChild(wrapper.element)

    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    const modifiedHeader = wrapper.get('[data-file-sort-header="modified"]')
    await modifiedHeader.trigger('click')
    expect(wrapper.findAll('[data-file-row]').map(row => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/chart.png',
      '/w/new.md',
    ])
    expect(modifiedHeader.attributes('data-file-sort-active')).toBe('')
    expect(modifiedHeader.attributes('aria-label')).toContain('Newest first')
    expect(modifiedHeader.find('[data-file-sort-arrow]').exists()).toBe(true)
    expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
    expect(settings.workbenchFileSort['/w'].project).toEqual({ key: 'modified', direction: 'desc' })

    await modifiedHeader.trigger('click')
    expect(wrapper.findAll('[data-file-row]').map(row => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/new.md',
      '/w/chart.png',
    ])
    expect(modifiedHeader.attributes('aria-label')).toContain('Oldest first')
    expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
    expect(settings.workbenchFileSort['/w'].project).toEqual({ key: 'modified', direction: 'asc' })

    wrapper.unmount()
  })

  it('keeps a keyboard-accessible sort menu for hidden columns and view order', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    const sortButton = wrapper.get('[data-files-sort-button]')
    sortButton.element.focus()
    await sortButton.trigger('keydown', { key: 'ArrowDown' })
    const popup = () => new DOMWrapper(document.querySelector('[data-files-sort-menu]'))
    expect(document.activeElement).toBe(popup().get('[data-file-sort-option="name"]').element)

    await popup().get('[data-file-sort-option="kind"]').trigger('click')
    expect(wrapper.get('[data-file-sort-header="kind"]').attributes('data-file-sort-active')).toBe('')
    expect(document.activeElement).toBe(sortButton.element)

    await sortButton.trigger('click')
    await popup().trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(sortButton.element)
    wrapper.unmount()
  })

  it('restores independent workspace sort state for each Files view', async () => {
    const settings = useSettingsStore()
    settings.set('workbenchFileSort', {
      '/w': {
        project: { key: 'size', direction: 'desc' },
        recent: { key: 'name', direction: 'desc' },
        favorites: { key: 'kind', direction: 'asc' },
      },
    })
    const wrapper = render()

    expect(wrapper.get('[data-file-sort-header="size"]').attributes('data-file-sort-active')).toBe('')
    expect(wrapper.findAll('[data-file-row]').map(row => row.attributes('data-file-row'))).toEqual([
      '/w/docs',
      '/w/chart.png',
      '/w/new.md',
    ])

    await wrapper.get('[data-files-mode="recent"]').trigger('click')
    expect(wrapper.get('[data-file-sort-header="name"]').attributes('data-file-sort-active')).toBe('')
    expect(wrapper.get('[data-file-sort-header="name"]').attributes('aria-label')).toContain('Z–A')
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

  it('confirms a new name with Return instead of opening the focused row', async () => {
    const store = useWorkspaceFilesStore()
    store.refresh = vi.fn(async () => undefined)
    const wrapper = render()
    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')

    await wrapper.get('[data-files-new-file]').trigger('click')
    const input = wrapper.get('[data-files-inline-name]')
    await input.setValue('brief.md')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(operations.createWorkspaceFile).toHaveBeenCalledWith('brief.md')
    expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
    expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
      path: '/w/brief.md',
      preview: false,
    })])
  })

  it('leaves typing in the name field to the field, not to row navigation', async () => {
    const wrapper = render()
    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    const opened = wrapper.emitted('openFile').length

    await wrapper.get('[data-files-new-file]').trigger('click')
    const input = wrapper.get('[data-files-inline-name]')
    await input.trigger('keydown', { key: ' ' })
    await input.trigger('keydown', { key: 'a', metaKey: true })
    await input.trigger('keydown', { key: 'F2' })

    expect(wrapper.emitted('openFile').length).toBe(opened)
    expect(wrapper.get('[data-files-inline-name]').exists()).toBe(true)
  })

  it('keeps a half-typed name when the window, not the user, takes focus away', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus')
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    await wrapper.get('[data-files-new-file]').trigger('click')
    const input = wrapper.get('[data-files-inline-name]')
    await input.setValue('half')

    hasFocus.mockReturnValue(false)
    await input.trigger('blur')
    expect(operations.createWorkspaceFile).not.toHaveBeenCalled()
    expect(wrapper.get('[data-files-inline-name]').element.value).toBe('half')

    hasFocus.mockReturnValue(true)
    await input.trigger('blur')
    await flushPromises()
    expect(operations.createWorkspaceFile).toHaveBeenCalledWith('half')
    hasFocus.mockRestore()
    wrapper.unmount()
  })

  it('offers the proven row actions from a native right-click gesture', async () => {
    const wrapper = render()
    await flushPromises()
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
    expect(menu.text()).toContain('History')
  })

  it('opens a Git-backed text file version from its History drill-in', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'managed_project_status') {
        return Promise.resolve({ managed: false, state: 'manual', remoteUrl: 'https://gitlab.com/acme/project.git' })
      }
      if (command === 'git_file_history') {
        return Promise.resolve([{
          hash: 'abcdef1234567890',
          shortHash: 'abcdef12',
          message: 'Update brief',
          authoredAt: '2026-08-15T14:45:00Z',
          author: 'Ada',
          binary: false,
          size: 120,
        }])
      }
      return undefined
    })
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-file-row="/w/new.md"]').trigger('contextmenu', {
      clientX: 22,
      clientY: 31,
    })
    expect(wrapper.get('[data-file-action="history"]').text()).toBe('History')
    await wrapper.get('[data-file-action="history"]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('git_file_history', { path: '/w/new.md', limit: 50 })
    expect(wrapper.get('[data-file-history-panel]').text()).toContain('Update brief')
    await wrapper.get('[data-file-history-version="abcdef1234567890"]').trigger('click')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([{
      path: '/w/new.md',
      preview: false,
      history: {
        hash: 'abcdef1234567890',
        shortHash: 'abcdef12',
        label: 'Update brief',
        timestamp: '2026-08-15T14:45:00Z',
      },
    }])

    await wrapper.get('[data-file-history-back]').trigger('click')
    expect(wrapper.find('[data-file-history-panel]').exists()).toBe(false)
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

  describe('file rename keys', () => {
    let wrapper
    beforeEach(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'))
    afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })

    it.each([true, false].flatMap(compact => ['project', 'recent', 'favorites'].map(mode => ({ compact, mode }))))(
      'renames with Return in $mode (compact=$compact) and returns focus on Escape', async ({ compact, mode }) => {
        useFileStore().recentFiles = ['/w/new.md']
        useSettingsStore().workbenchFileFavorites = { '/w': [{ relativePath: 'new.md', isDirectory: false }] }
        wrapper = render({ compact })
        document.body.appendChild(wrapper.element)
        await wrapper.get(`[data-files-mode="${mode}"]`).trigger('click')
        const row = wrapper.get('[data-file-row="/w/new.md"] button')
        await row.trigger('click')
        expect(document.activeElement).toBe(row.element)
        expect(wrapper.emitted('openFile').at(-1)[0]).toMatchObject({ preview: true, focus: false })
        await row.trigger('keydown', { key: 'Enter' })
        const input = wrapper.get('[data-files-inline-name]')
        expect(document.activeElement).toBe(input.element)
        expect([input.element.selectionStart, input.element.selectionEnd]).toEqual([0, 3])
        await input.trigger('keydown', { key: 'Escape' })
        await flushPromises()
        expect(document.activeElement).toBe(wrapper.get('[data-file-row="/w/new.md"] button').element)
        expect(operations.renameWorkspaceEntry).not.toHaveBeenCalled()
      },
    )

    it('renames a selected folder and shows Return in the context menu', async () => {
      wrapper = render({ compact: true })
      document.body.appendChild(wrapper.element)
      await wrapper.get('[data-file-row="/w/docs"] button').trigger('click')
      await wrapper.get('[data-file-row="/w/docs"]').trigger('contextmenu', { clientX: 20, clientY: 20 })
      expect(wrapper.get('[data-file-action="rename"]').text()).toContain('↩')
      await wrapper.get('[data-files-context-menu]').trigger('keydown', { key: 'Escape' })
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'Enter' })
      const input = wrapper.get('[data-files-inline-name]')
      expect(input.element.value).toBe('docs')
      expect([input.element.selectionStart, input.element.selectionEnd]).toEqual([0, 4])
    })

    it('leaves modified keys, composition, repeated Return, and multiple selection out of rename', async () => {
      wrapper = render()
      const list = wrapper.get('[data-files-list]')
      await list.trigger('keydown', { key: 'Enter' })
      expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      for (const extra of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
        await list.trigger('keydown', { key: 'Enter', ...extra })
        expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
      }
      await wrapper.get('[data-file-row="/w/chart.png"] button').trigger('click', { metaKey: true })
      for (const key of ['Enter', 'F2']) {
        await list.trigger('keydown', { key })
        expect(wrapper.find('[data-files-inline-name]').exists()).toBe(false)
      }
    })

    it('does not submit a rename for a repeated Return or IME confirmation', async () => {
      wrapper = render()
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'Enter' })
      const input = wrapper.get('[data-files-inline-name]')
      await input.setValue('renamed.md')
      for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
        await input.trigger('keydown', { key: 'Enter', ...extra })
        expect(operations.renameWorkspaceEntry).not.toHaveBeenCalled()
      }
      await input.trigger('keydown', { key: 'Escape', isComposing: true })
      expect(wrapper.find('[data-files-inline-name]').exists()).toBe(true)
    })

    it('opens with Command+Down and keeps Enter to open on other platforms', async () => {
      wrapper = render()
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'ArrowDown', metaKey: true })
      expect(wrapper.emitted('openFile').at(-1)[0]).toMatchObject({ path: '/w/new.md', preview: false, focus: true })
      wrapper.unmount()
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
      wrapper = render()
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('openFile').at(-1)[0]).toMatchObject({ path: '/w/new.md', preview: false, focus: true })
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'F2' })
      expect(wrapper.get('[data-files-inline-name]').element.value).toBe('new.md')
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
      '/w/chart.png',
      '/w/new.md',
    ])
  })

  it('closes Trash confirmation and hides the row before the native operation settles', async () => {
    let rejectTrash
    operations.trashWorkspaceEntries.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectTrash = reject
    }))
    const wrapper = render()
    const list = wrapper.get('[data-files-list]')

    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    await list.trigger('keydown', { key: 'Backspace', metaKey: true })
    await wrapper.get('[data-files-confirm-delete]').trigger('click')

    expect(wrapper.find('[data-files-delete-dialog]').exists()).toBe(false)
    expect(wrapper.find('[data-file-row="/w/new.md"]').exists()).toBe(false)

    rejectTrash(new Error('Trash is unavailable'))
    await flushPromises()

    expect(wrapper.get('[data-file-row="/w/new.md"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-operation-error]').text()).toContain('Trash is unavailable')
  })

  it('moves focus into Trash confirmation and accepts Return', async () => {
    const wrapper = render()
    document.body.appendChild(wrapper.element)
    const list = wrapper.get('[data-files-list]')
    list.element.focus()

    await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
    await list.trigger('keydown', { key: 'Backspace', metaKey: true })

    const confirm = wrapper.get('[data-files-confirm-delete]')
    expect(document.activeElement).toBe(confirm.element)

    await confirm.trigger('keydown', { key: 'Tab' })
    const cancel = wrapper.get('[data-files-delete-dialog]').findAll('button')[0]
    expect(document.activeElement).toBe(cancel.element)

    await cancel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm.element)

    await confirm.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(operations.trashWorkspaceEntries).toHaveBeenCalledWith(['/w/new.md'])
    expect(wrapper.find('[data-files-delete-dialog]').exists()).toBe(false)
    expect(document.activeElement).toBe(list.element)
    wrapper.unmount()
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
    useSettingsStore().set('workbenchFileSort', {})
    editorFiles.setRecentFiles(['/w/src/lib.rs', '/w/moved.md'])
    const wrapper = render()

    await wrapper.get('[data-files-mode="recent"]').trigger('click')

    expect(wrapper.findAll('[data-file-row]').map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/src/lib.rs',
      '/w/moved.md',
    ])
    expect(wrapper.get('[data-file-row="/w/moved.md"]').text()).toContain('Missing')
  })

  it('keeps Recent inside the active project', async () => {
    const editorFiles = useFileStore()
    editorFiles.setRecentFiles(['/other/foreign.md', '/w/src/lib.rs', '/w2/prefix.md'])
    const wrapper = render()

    await wrapper.get('[data-files-mode="recent"]').trigger('click')

    expect(wrapper.findAll('[data-file-row]').map((row) => row.attributes('data-file-row'))).toEqual([
      '/w/src/lib.rs',
    ])
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
      const wrapper = render()
      await wrapper.get('[data-files-search]').setValue('lib')

      await vi.advanceTimersByTimeAsync(100)
      expect(fileIndex.filterIndexedFiles).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(40)
      expect(fileIndex.filterIndexedFiles).toHaveBeenCalledWith('lib', 251)
      expect(wrapper.findAll('[data-files-search-match]').map(row => row.attributes('data-search-path'))).toEqual(['/w/src/lib.rs'])
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enters path results at the first or last row from the search field', async () => {
    const wrapper = render()
    const input = wrapper.get('[data-files-search]')

    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.get('[data-file-row="/w/docs"]').attributes('aria-selected')).toBe('true')

    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')
  })

  async function completeContentQuery(wrapper, value, matches, { truncated = false } = {}) {
    vi.useFakeTimers()
    try {
      fileIndex.searchIndexedContent.mockResolvedValue({ matches, cancelled: false, truncated })
      await wrapper.get('[data-files-search]').setValue(value)
      await vi.advanceTimersByTimeAsync(140)
      await flushPromises()
    } finally {
      vi.useRealTimers()
    }
  }

  it('searches file contents automatically after filenames', async () => {
    vi.useFakeTimers()
    try {
      fileIndex.searchIndexedContent.mockResolvedValue({
        matches: [{
          path: '/w/src/lib.rs',
          name: 'lib.rs',
          relativePath: 'src/lib.rs',
          line: 12,
          column: 4,
          excerpt: 'let needle = true',
        }],
        cancelled: false,
        truncated: false,
      })
      const wrapper = render()

      await wrapper.get('[data-files-search]').setValue('needle')
      expect(wrapper.get('[data-files-list]').attributes('role')).toBe('listbox')
      await vi.advanceTimersByTimeAsync(140)
      await wrapper.vm.$nextTick()

      expect(fileIndex.searchIndexedContent).toHaveBeenLastCalledWith(expect.any(Object), {
        query: 'needle', pathQuery: null, maxResults: 200, maxMatchesPerFile: 1,
      })
      expect(wrapper.get('[data-content-match]').text()).toContain('src/lib.rs')
      expect(wrapper.get('[data-content-match]').text()).toContain('12:4')
      expect(wrapper.get('[data-content-match]').text()).toContain('let needle = true')

      await wrapper.get('[data-content-match]').trigger('click')
      expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
        path: '/w/src/lib.rs',
        line: 12,
        column: 4,
        preview: true,
      })])

      await wrapper.get('[data-content-match]').trigger('dblclick')
      expect(wrapper.emitted('openFile').at(-1)).toEqual([expect.objectContaining({
        path: '/w/src/lib.rs', line: 12, column: 4, preview: false,
      })])
    } finally {
      vi.useRealTimers()
    }
  })

  it('enters content results without preselecting or skipping the first match', async () => {
    const wrapper = render()
    await completeContentQuery(wrapper, 'needle', [
      {
        path: '/w/new.md',
        relativePath: 'new.md',
        line: 2,
        column: 1,
        excerpt: 'first needle',
      },
      {
        path: '/w/src/lib.rs',
        relativePath: 'src/lib.rs',
        line: 12,
        column: 4,
        excerpt: 'second needle',
      },
    ])

    const matches = wrapper.findAll('[data-content-match]')
    expect(matches.map(match => match.attributes('aria-selected'))).toEqual(['false', 'false'])

    const input = wrapper.get('[data-files-search]')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(matches[0].attributes('aria-selected')).toBe('true')

    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(matches[1].attributes('aria-selected')).toBe('true')
  })

  it('limits content results to the active Recent and Favorites views', async () => {
    const editorFiles = useFileStore()
    const settings = useSettingsStore()
    editorFiles.setRecentFiles(['/w/src/lib.rs'])
    settings.set('workbenchFileFavorites', {
      '/w': [{ relativePath: 'docs', isDirectory: true }],
    })
    const wrapper = render()
    const matches = [
      { path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'new' },
      { path: '/w/src/lib.rs', relativePath: 'src/lib.rs', line: 2, column: 1, excerpt: 'recent' },
      { path: '/w/docs/guide.md', relativePath: 'docs/guide.md', line: 3, column: 1, excerpt: 'favorite' },
    ]

    await wrapper.get('[data-files-mode="recent"]').trigger('click')
    await completeContentQuery(wrapper, 'needle', matches)
    expect(wrapper.findAll('[data-content-match]').map(match => match.text())).toEqual([
      expect.stringContaining('src/lib.rs'),
    ])

    await wrapper.get('[data-files-mode="favorites"]').trigger('click')
    await completeContentQuery(wrapper, 'needle', matches)
    expect(wrapper.findAll('[data-content-match]').map(match => match.text())).toEqual([
      expect.stringContaining('docs/guide.md'),
    ])
  })

  it('composes the Git filter with content results and keeps its narrow-panel control', async () => {
    loadGitChanges.mockResolvedValueOnce([
      { path: 'new.md', status: 'new' },
    ])
    const wrapper = render()
    await flushPromises()

    const gitFilter = wrapper.get('[data-files-git-filter]')
    expect(gitFilter.classes()).toContain('shrink-0')
    expect(gitFilter.classes()).not.toContain('files-footer-secondary')

    await completeContentQuery(wrapper, 'needle', [
      { path: '/w/new.md', relativePath: 'new.md', line: 1, column: 1, excerpt: 'changed' },
      { path: '/w/src/lib.rs', relativePath: 'src/lib.rs', line: 2, column: 1, excerpt: 'unchanged' },
    ])
    await wrapper.get('[data-files-git-filter]').trigger('click')

    expect(wrapper.findAll('[data-content-match]').map(match => match.text())).toEqual([
      expect.stringContaining('new.md'),
    ])
  })

  it('counts changed descendants and filters the visible tree from the Git summary', async () => {
    loadGitChanges.mockResolvedValueOnce([
      { path: 'docs/deep/guide.md', status: 'modified' },
      { path: 'new.md', status: 'new' },
      { path: 'old.md', status: 'deleted' },
    ])
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-file-row="/w/docs"] [data-file-git]').text()).toBe('1')
    expect(wrapper.get('[data-file-row="/w/docs"] [data-file-git]').attributes('title'))
      .toBe('1 changed file inside')
    expect(wrapper.get('[data-file-row="/w/new.md"] [data-file-git]').text()).toBe('A')

    await wrapper.get('[data-files-git-filter]').trigger('click')
    expect(wrapper.get('[data-files-active-filter]').text()).toContain('Git changes')
    expect(wrapper.find('[data-file-row="/w/chart.png"]').exists()).toBe(false)
    expect(wrapper.get('[data-file-row="/w/docs/deep/guide.md"]').text()).toContain('docs/deep')
    expect(wrapper.get('[data-file-row="/w/new.md"]').exists()).toBe(true)
    expect(wrapper.get('[data-file-row="/w/old.md"]').text()).toContain('Missing')
    expect(wrapper.get('[data-file-row="/w/old.md"] [data-file-git]').text()).toBe('D')

    const opened = wrapper.emitted('openFile')?.length || 0
    await wrapper.get('[data-file-row="/w/old.md"] button').trigger('click')
    expect(wrapper.emitted('openFile')?.length || 0).toBe(opened)
    expect(wrapper.get('[data-file-row="/w/old.md"] [data-file-favorite]').attributes())
      .toHaveProperty('disabled')

    await wrapper.get('[data-file-row="/w/old.md"]').trigger('contextmenu', {
      clientX: 22,
      clientY: 31,
    })
    const missingMenu = wrapper.get('[data-files-context-menu]')
    expect(missingMenu.text()).toContain('Copy relative path')
    expect(missingMenu.text()).not.toContain('Rename')
    expect(missingMenu.text()).not.toContain('Move to Trash')
    await wrapper.get('[data-file-action="copy-relative-path"]').trigger('click')

    await wrapper.get('[data-files-clear-git-filter]').trigger('click')
    expect(wrapper.get('[data-file-row="/w/chart.png"]').exists()).toBe(true)
  })

  it('opens the isolated Changes ledger without changing Project behavior', async () => {
    loadGitReviewChanges.mockResolvedValueOnce([
      { path: 'new.md', oldPath: '', status: 'new', staged: false, unstaged: true, conflicted: false },
      { path: 'src/lib.rs', oldPath: '', status: 'modified', staged: true, unstaged: false, conflicted: false },
    ])
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-files-mode="changes"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-git-changes-list]').exists()).toBe(true)
    expect(wrapper.findAll('[data-git-change]').map(row => row.attributes('data-git-change')))
      .toEqual(['new.md', 'src/lib.rs'])
    expect(wrapper.emitted('reviewGit').at(-1)).toEqual([{
      workspacePath: '/w', file: 'new.md', scope: 'all',
    }])

    await wrapper.get('[data-files-mode="project"]').trigger('click')
    expect(wrapper.get('[data-file-row="/w/new.md"]').exists()).toBe(true)
    expect(wrapper.get('[data-files-search]').attributes('placeholder')).toBe('Search files…')
  })

  it('removes Git controls and native diagnostics from a non-Git folder', async () => {
    loadGitReviewChanges.mockRejectedValue(new Error(
      "Could not find a Git repository from /w: could not find repository at '/w'; class=Repository (6); code=NotFound (-3)",
    ))
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-files-mode="changes"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-git-not-repository]').text()).toContain('No Git repository')
    expect(wrapper.find('[data-files-search]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('class=Repository')
    expect(wrapper.text()).not.toContain('Changes could not be loaded')

    await wrapper.get('[data-files-mode="project"]').trigger('click')
    await wrapper.get('[data-file-row="/w/new.md"]').trigger('contextmenu', {
      clientX: 22,
      clientY: 31,
    })
    expect(wrapper.get('[data-files-context-menu]').text()).not.toContain('History')
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
      await wrapper.get('[data-file-row="/w/new.md"] button').trigger('click')
      operations.listWorkspaceDirectory.mockResolvedValue([])
      hover('[data-file-row="/w/docs"]')
      await handler({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths: ['/D/brief.md'] } })
      await flushPromises()

      expect(wrapper.get('[data-file-row="/w/new.md"]').attributes('aria-selected')).toBe('true')

      // Focus is still on the last row: stepping up lands on its neighbour,
      // not on the row a reset-to-zero focus would wrap around to.
      await wrapper.get('[data-files-list]').trigger('keydown', { key: 'ArrowUp' })
      expect(wrapper.get('[data-file-row="/w/chart.png"]').attributes('aria-selected')).toBe('true')
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

  describe('drag and drop inside the tree', () => {
    // Internal drags are pointer-driven (Tauri's drag-drop interception
    // swallows HTML5 DnD), so the test presses a row and moves the document
    // pointer the way a user would.
    function dragFrom(wrapper, path) {
      return wrapper.get(`[data-file-row="${path}"]`).trigger('pointerdown', {
        button: 0,
        clientX: 0,
        clientY: 0,
      })
    }

    function pointerTo(wrapper, selector, point = { clientX: 40, clientY: 40 }) {
      document.elementFromPoint = vi.fn(() => wrapper.get(selector).element)
      document.dispatchEvent(Object.assign(new Event('pointermove'), point))
    }

    it('moves a row dropped onto a folder and reloads both ends', async () => {
      operations.moveWorkspaceEntry.mockResolvedValue({
        path: '/w/docs/new.md',
        relativePath: 'docs/new.md',
        name: 'new.md',
        isDirectory: false,
      })
      const wrapper = render()
      await flushPromises()

      await dragFrom(wrapper, '/w/new.md')
      pointerTo(wrapper, '[data-file-row="/w/docs"]')
      await flushPromises()
      expect(wrapper.get('[data-file-row="/w/docs"]').attributes('data-file-drop-target')).toBe('')
      expect(wrapper.get('[data-files-drag-ghost]').text()).toContain('new.md')

      document.dispatchEvent(new Event('pointerup'))
      await flushPromises()

      expect(operations.moveWorkspaceEntry).toHaveBeenCalledWith('/w/new.md', 'docs')
      expect(operations.listWorkspaceDirectory).toHaveBeenCalledWith('docs')
      expect(wrapper.find('[data-files-drag-ghost]').exists()).toBe(false)
      expect(wrapper.find('[data-file-drop-target]').exists()).toBe(false)
    })

    it('never offers a drop that would move nothing', async () => {
      const wrapper = render()
      await flushPromises()

      await dragFrom(wrapper, '/w/new.md')
      // Hovering empty tree space targets the root, where new.md already is.
      pointerTo(wrapper, '[data-files-list]')
      await flushPromises()

      expect(wrapper.get('[data-files-list]').attributes('data-files-drop-root')).toBeUndefined()
      document.dispatchEvent(new Event('pointerup'))
      await flushPromises()
      expect(operations.moveWorkspaceEntry).not.toHaveBeenCalled()
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
