import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { listen } from '@tauri-apps/api/event'
import { useFileStore } from '../../stores/files.js'
import { useExternalFileSync } from './useExternalFileSync.js'

describe('external file sync', () => {
  let callbacks
  let unlisteners
  let files
  let readFile
  let onReloaded

  beforeEach(() => {
    setActivePinia(createPinia())
    window.__TAURI_INTERNALS__ = true
    callbacks = new Map()
    unlisteners = new Map()
    listen.mockReset().mockImplementation((event, callback) => {
      callbacks.set(event, callback)
      const unlisten = vi.fn()
      unlisteners.set(event, unlisten)
      return Promise.resolve(unlisten)
    })
    files = useFileStore()
    readFile = vi.fn()
    onReloaded = vi.fn()
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  function createSync() {
    return useExternalFileSync({
      fileManager: files,
      readFile,
      onReloaded,
    })
  }

  it('reloads only a changed open clean text file from the workspace watcher', async () => {
    await files.openFile('/work/README.md', 'before')
    await files.openFile('/work/notes.md', 'notes')
    readFile.mockResolvedValue('after')
    const sync = createSync()
    await sync.start()

    callbacks.get('mimir://workspace-files-changed')({
      payload: { paths: ['/work/README.md', '/work/not-open.md'] },
    })

    await vi.waitFor(() => expect(files.openFiles[0].content).toBe('after'))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('/work/README.md')
    expect(files.openFiles[1].content).toBe('notes')
    expect(onReloaded).toHaveBeenCalledWith(files.openFiles[0])

    sync.dispose()
    expect(unlisteners.get('mimir://file-updated')).toHaveBeenCalledTimes(1)
    expect(unlisteners.get('mimir://workspace-files-changed')).toHaveBeenCalledTimes(1)
  })

  it('does not replace unsaved content if the buffer becomes dirty during the disk read', async () => {
    let finishRead
    readFile.mockReturnValue(new Promise(resolve => {
      finishRead = resolve
    }))
    await files.openFile('/work/README.md', 'before')
    const sync = createSync()

    const refresh = sync.refreshChangedPaths({ paths: ['/work/README.md'] })
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1))
    files.updateContent('my unsaved edit')
    finishRead('agent edit')

    await expect(refresh).resolves.toEqual([false])
    expect(files.currentFile).toMatchObject({
      content: 'my unsaved edit',
      dirty: true,
    })
    expect(onReloaded).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('keeps the newest watcher result when disk reads finish out of order', async () => {
    const finishes = []
    readFile.mockImplementation(() => new Promise(resolve => {
      finishes.push(resolve)
    }))
    await files.openFile('/work/README.md', 'before')
    const sync = createSync()

    const first = sync.refreshChangedPaths({ paths: ['/work/README.md'] })
    const second = sync.refreshChangedPaths({ paths: ['/work/README.md'] })
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2))

    finishes[1]('newest agent edit')
    await expect(second).resolves.toEqual([true])
    finishes[0]('stale agent edit')
    await expect(first).resolves.toEqual([false])

    expect(files.currentFile.content).toBe('newest agent edit')
    expect(onReloaded).toHaveBeenCalledTimes(1)
    sync.dispose()
  })

  it('ignores a watcher notification when disk content is unchanged', async () => {
    await files.openFile('/work/README.md', 'same content')
    readFile.mockResolvedValue('same content')
    const sync = createSync()

    await expect(sync.refreshChangedPaths({
      paths: ['/work/README.md'],
    })).resolves.toEqual([false])
    expect(onReloaded).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('uses direct file-update content without a redundant disk read', async () => {
    await files.openFile('/work/README.md', 'before')
    const sync = createSync()
    await sync.start()

    callbacks.get('mimir://file-updated')({
      payload: { path: '/work/README.md', content: 'updated by Mimir' },
    })

    expect(files.currentFile).toMatchObject({
      content: 'updated by Mimir',
      dirty: false,
      saveState: 'idle',
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(onReloaded).toHaveBeenCalledWith(files.currentFile)
    sync.dispose()
  })

  it('keeps a dirty buffer authoritative when a direct file-update event arrives', async () => {
    await files.openFile('/work/README.md', 'before')
    files.updateContent('my unsaved edit')
    const sync = createSync()

    expect(sync.applyEventContent({
      path: '/work/README.md',
      content: 'external edit',
    })).toBe(false)
    expect(files.currentFile).toMatchObject({
      content: 'my unsaved edit',
      dirty: true,
    })
    expect(onReloaded).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('invalidates matching binary previews without reading them as text', async () => {
    await files.openFile('/work/photo.png', '', { kind: 'external' })
    await files.openFile('/work/report.pdf', '', { kind: 'pdf' })
    await files.openFile('/work/other.jpg', '', { kind: 'external' })
    const sync = createSync()
    await sync.refreshChangedPaths({ paths: ['/work/photo.png', '/work/report.pdf'] })
    expect(files.openFiles.map(file => file.previewRevision || 0)).toEqual([1, 1, 0])
    expect(readFile).not.toHaveBeenCalled()
    expect(onReloaded).not.toHaveBeenCalled()
    sync.dispose()
  })
})
