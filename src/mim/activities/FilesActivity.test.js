import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import FilesActivity from './FilesActivity.vue'

vi.mock('../../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(),
  filterIndexedFiles: vi.fn(),
  refreshWorkspaceIndex: vi.fn(),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

const indexed = [
  { path: '/w/new.md', name: 'new.md', relativePath: 'new.md', mtime: Date.now(), size: 1536, textReadable: true },
  { path: '/w/src/lib.rs', name: 'lib.rs', relativePath: 'src/lib.rs', mtime: Date.now() - 60_000, size: 82, textReadable: true },
]

describe('FilesActivity', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    const store = useWorkspaceFilesStore()
    store.workspacePath = '/w'
    store.files = indexed
  })

  function render() {
    return mount(FilesActivity, { global: { plugins: [pinia] } })
  }

  it('renders the recent-first review inbox with useful metadata', () => {
    const wrapper = render()
    const rows = wrapper.findAll('[data-file-row]')

    expect(rows.map((row) => row.attributes('data-file-row'))).toEqual(['/w/new.md', '/w/src/lib.rs'])
    expect(rows[0].text()).toContain('new.md')
    expect(rows[0].text()).toContain('1.5 KB')
  })

  it('supports arrow navigation and Return without changing Activity', async () => {
    const wrapper = render()
    const list = wrapper.get('[data-files-list]')

    await list.trigger('keydown', { key: 'ArrowDown' })
    await list.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('openFile')[0]).toEqual(['/w/src/lib.rs'])
  })

  it('selects on hover and opens on double click', async () => {
    const wrapper = render()
    const row = wrapper.get('[data-file-row="/w/src/lib.rs"]')

    await row.trigger('mouseenter')
    await row.trigger('dblclick')

    expect(useWorkspaceFilesStore().selectedFile.path).toBe('/w/src/lib.rs')
    expect(wrapper.emitted('openFile')[0]).toEqual(['/w/src/lib.rs'])
  })

  it('shows content matches as locations and emits the matching file', async () => {
    const store = useWorkspaceFilesStore()
    store.contentMatches = [{
      path: '/w/src/lib.rs',
      relativePath: 'src/lib.rs',
      line: 14,
      column: 3,
      excerpt: 'let needle = true',
    }]
    const wrapper = render()
    await wrapper.get('[data-search-mode="content"]').trigger('click')

    expect(wrapper.get('[data-content-match]').text()).toContain('src/lib.rs:14')
    expect(wrapper.get('[data-content-match]').text()).toContain('let needle = true')
    await wrapper.get('[data-content-match]').trigger('click')
    expect(wrapper.emitted('openFile')[0]).toEqual(['/w/src/lib.rs'])
  })

  it('offers workspace recovery for missing state', async () => {
    const store = useWorkspaceFilesStore()
    store.workspacePath = ''
    const wrapper = render()

    await wrapper.get('[data-files-choose-workspace]').trigger('click')

    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
  })
})
