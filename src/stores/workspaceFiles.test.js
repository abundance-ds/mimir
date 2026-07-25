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
vi.mock('../services/workspaceFileOperations.js', () => ({
  listWorkspaceDirectory: vi.fn(),
}))

import * as api from '../services/fileIndex.js'
import { listWorkspaceDirectory } from '../services/workspaceFileOperations.js'
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
    listWorkspaceDirectory.mockResolvedValue([
      {
        path: '/w/docs',
        relativePath: 'docs',
        name: 'docs',
        isDirectory: true,
        mtime: 20,
        size: 0,
      },
      {
        path: '/w/new.md',
        relativePath: 'new.md',
        name: 'new.md',
        isDirectory: false,
        mtime: 30,
        size: 20,
        textReadable: true,
      },
    ])
  })

  it('opens a workspace as a recent-first review inbox', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')

    expect(store.workspacePath).toBe('/w')
    expect(store.files.map((file) => file.relativePath)).toEqual(['new.md', 'src/old.rs'])
    expect(listWorkspaceDirectory).toHaveBeenCalledWith('')
    expect(store.directoryEntries.map((entry) => entry.name)).toEqual(['docs', 'new.md'])
    expect(store.selectionIndex).toBe(0)
  })

  it('navigates directories and exposes a root-aware breadcrumb', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')
    listWorkspaceDirectory.mockResolvedValueOnce([{
      path: '/w/docs/guide.md',
      relativePath: 'docs/guide.md',
      name: 'guide.md',
      isDirectory: false,
    }])

    await store.openDirectory('docs')

    expect(listWorkspaceDirectory).toHaveBeenLastCalledWith('docs')
    expect(store.currentDirectory).toBe('docs')
    expect(store.breadcrumbs).toEqual([
      { label: 'workspace', path: '' },
      { label: 'docs', path: 'docs' },
    ])
    expect(store.directoryEntries[0].name).toBe('guide.md')

    await store.openParentDirectory()
    expect(store.currentDirectory).toBe('')
  })

  it('keeps precise directory errors and preserves the previous location on failure', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')
    listWorkspaceDirectory.mockRejectedValueOnce(new Error('Permission denied for docs'))

    await expect(store.openDirectory('docs')).rejects.toThrow('Permission denied for docs')

    expect(store.currentDirectory).toBe('')
    expect(store.directoryError).toBe('Permission denied for docs')
  })

  it('uses Rust fuzzy filtering and keeps selection valid', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')

    await store.setQuery('old')

    expect(api.filterIndexedFiles).toHaveBeenCalledWith('old', 250)
    expect(store.visibleFiles).toEqual([files[1]])
    expect(store.selectedFile).toEqual(files[1])
  })

  it('ignores a stale fuzzy result when a newer query finishes first', async () => {
    const store = useWorkspaceFilesStore()
    await store.openWorkspace('/w')
    let resolveOld
    api.filterIndexedFiles
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce([{ file: files[0], score: 80 }])

    const oldSearch = store.setQuery('old')
    await store.setQuery('new')
    resolveOld([{ file: files[1], score: 90 }])
    await oldSearch

    expect(store.query).toBe('new')
    expect(store.visibleFiles).toEqual([files[0]])
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
    expect(listWorkspaceDirectory).toHaveBeenCalledTimes(2)
    expect(store.files).toEqual(files)
  })

  it('does not poll and rebuild the entire workspace index while Files is idle', async () => {
    vi.useFakeTimers()
    try {
      const store = useWorkspaceFilesStore()
      await store.openWorkspace('/w')
      api.refreshWorkspaceIndex.mockClear()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(api.refreshWorkspaceIndex).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
