import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(),
  filterIndexedFiles: vi.fn(),
  refreshWorkspaceIndex: vi.fn(),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

import * as api from '../services/fileIndex.js'
import { useWorkspaceFilesStore } from './workspaceFiles.js'

const files = [
  { path: '/w/new.md', name: 'new.md', relativePath: 'new.md', mtime: 30, size: 20, textReadable: true },
  { path: '/w/src/old.rs', name: 'old.rs', relativePath: 'src/old.rs', mtime: 10, size: 10, textReadable: true },
]

describe('workspace files store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    api.openWorkspaceIndex.mockResolvedValue(files)
    api.listIndexedFiles.mockResolvedValue(files)
    api.filterIndexedFiles.mockResolvedValue([{ file: files[1], score: 44 }])
    api.refreshWorkspaceIndex.mockResolvedValue({ added: 0, changed: 1, removed: 0, total: 2 })
    api.beginContentSearch.mockResolvedValue({ requestGeneration: 1, workspaceGeneration: 1 })
    api.searchIndexedContent.mockResolvedValue({
      matches: [{ path: files[1].path, relativePath: files[1].relativePath, line: 4, column: 2, excerpt: 'needle' }],
      cancelled: false,
      truncated: false,
    })
  })

  it('opens a workspace as a recent-first review inbox', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')

    expect(store.workspacePath).toBe('/w')
    expect(store.files.map((file) => file.relativePath)).toEqual(['new.md', 'src/old.rs'])
    expect(store.selectionIndex).toBe(0)
  })

  it('uses Rust fuzzy filtering and keeps selection valid', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')

    await store.setQuery('old')

    expect(api.filterIndexedFiles).toHaveBeenCalledWith('old', 250)
    expect(store.visibleFiles).toEqual([files[1]])
    expect(store.selectedFile).toEqual(files[1])
  })

  it('moves keyboard selection with bounded wraparound', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')

    store.moveSelection(-1)
    expect(store.selectedFile).toEqual(files[1])
    store.moveSelection(1)
    expect(store.selectedFile).toEqual(files[0])
  })

  it('refreshes external writes and reloads only when the index changed', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')
    await store.refresh()

    expect(api.listIndexedFiles).toHaveBeenCalledTimes(1)
    expect(store.files).toEqual(files)
  })

  it('cancels the prior bounded content search before starting another', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')
    await store.searchContent('needle')
    api.beginContentSearch.mockResolvedValueOnce({ requestGeneration: 2, workspaceGeneration: 1 })

    await store.searchContent('next')

    expect(api.cancelContentSearch).toHaveBeenCalledWith({
      requestGeneration: 1,
      workspaceGeneration: 1,
    })
    expect(store.contentMatches[0].excerpt).toBe('needle')
  })
})
