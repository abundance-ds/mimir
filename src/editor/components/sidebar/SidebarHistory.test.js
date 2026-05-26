import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidebarHistory from './SidebarHistory.vue'
import { useFileStore } from '../../../stores/files.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { useDiffStore } from '../../../stores/diff.js'

const mockEntries = [
  {
    hash: 'abc1234567890',
    short_hash: 'abc1234',
    message: 'Add methods section',
    author: 'paul',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    insertions: 45,
    deletions: 3,
  },
  {
    hash: 'def4567890123',
    short_hash: 'def4567',
    message: 'Initial draft',
    author: 'paul',
    timestamp: new Date(Date.now() - 86400000 * 2).toISOString(),
    insertions: 120,
    deletions: 0,
  },
]

describe('SidebarHistory', () => {
  let fileStore, ui, diff

  beforeEach(() => {
    setActivePinia(createPinia())
    fileStore = useFileStore()
    ui = useEditorUIStore()
    diff = useDiffStore()
    vi.restoreAllMocks()
  })

  function mountHistory() {
    return mount(SidebarHistory)
  }

  it('shows empty state for untitled file', () => {
    fileStore.newFile()
    ui.openPanel('history')
    const w = mountHistory()
    expect(w.text()).toContain('No earlier versions')
  })

  it('shows empty state when invoke fails with not_a_repo', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke.mockRejectedValue('not_a_repo')

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'hello', dirty: false })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.text()).toContain('No earlier versions')
    })
  })

  it('shows Current marker and timeline when history exists', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke.mockResolvedValue(mockEntries)

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'hello', dirty: false })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.text()).toContain('Current')
      expect(w.text()).toContain('Add methods section')
      expect(w.text()).toContain('Initial draft')
      expect(w.text()).toContain('paul')
    })
  })

  it('shows unsaved changes indicator when file is dirty', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke.mockResolvedValue(mockEntries)

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'hello', dirty: true })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.text()).toContain('Unsaved changes')
    })
  })

  it('shows line stats with +/- counts', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke.mockResolvedValue(mockEntries)

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'hello', dirty: false })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.text()).toContain('+45')
      expect(w.text()).toContain('+120')
    })
  })

  it('clicking an entry activates diff with historical content', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke
      .mockResolvedValueOnce(mockEntries)
      .mockResolvedValueOnce(mockEntries)
      .mockResolvedValueOnce('old content')

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'current content', dirty: false })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.findAll('.history-entry').length).toBe(2)
    })

    await w.findAll('.history-entry')[0].trigger('click')

    await vi.waitFor(() => {
      expect(diff.active).toBe(true)
      expect(diff.originalContent).toBe('old content')
      expect(diff.modifiedContent).toBe('current content')
      expect(diff.reviewMeta?.type).toBe('history')
    })
  })

  it('shows empty state for empty git log', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    invoke.mockResolvedValue([])

    fileStore.openFiles.push({ id: 1, path: '/tmp/test.md', content: 'hello', dirty: false })
    fileStore.activeFileIndex = 0
    ui.openPanel('history')

    const w = mountHistory()
    await vi.waitFor(() => {
      expect(w.text()).toContain('No earlier versions')
    })
  })
})
