import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../services/fileSystem.js', () => ({
  openFileDialog: vi.fn(),
  saveFileDialog: vi.fn(),
  saveFile: vi.fn(),
}))

import { useFileStore } from './files.js'
import {
  openFileDialog,
  saveFileDialog,
  saveFile,
} from '../services/fileSystem.js'

describe('files store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // 1. Starts with empty openFiles and recentFiles
  it('starts with empty openFiles and recentFiles', () => {
    const store = useFileStore()
    expect(store.openFiles).toEqual([])
    expect(store.recentFiles).toEqual([])
    expect(store.activeFileIndex).toBe(0)
  })

  // 2. newFile(): adds entry, sets activeFileIndex
  it('newFile() adds {path: null, content: "", dirty: false} and sets activeFileIndex', () => {
    const store = useFileStore()
    store.newFile()
    expect(store.openFiles).toHaveLength(1)
    expect(store.openFiles[0]).toMatchObject({ path: null, content: '', dirty: false })
    expect(store.activeFileIndex).toBe(0)

    store.newFile()
    expect(store.openFiles).toHaveLength(2)
    expect(store.activeFileIndex).toBe(1)
  })

  // 3. openFile(path, content): adds file, sets active, adds to recentFiles
  it('openFile(path, content) adds file and updates recentFiles', async () => {
    const store = useFileStore()
    await store.openFile('/tmp/hello.md', '# Hello')
    expect(store.openFiles).toHaveLength(1)
    expect(store.openFiles[0]).toMatchObject({
      path: '/tmp/hello.md',
      content: '# Hello',
      dirty: false,
    })
    expect(store.activeFileIndex).toBe(0)
    expect(store.recentFiles).toContain('/tmp/hello.md')
  })

  // 4. openFile with duplicate path: switches to existing tab
  it('openFile with duplicate path switches to existing tab', async () => {
    const store = useFileStore()
    await store.openFile('/tmp/a.md', 'aaa')
    await store.openFile('/tmp/b.md', 'bbb')
    expect(store.activeFileIndex).toBe(1)

    await store.openFile('/tmp/a.md', 'aaa')
    expect(store.openFiles).toHaveLength(2) // no duplicate added
    expect(store.activeFileIndex).toBe(0) // switched back
  })

  // 5. currentFile computed
  it('currentFile returns the file at activeFileIndex', () => {
    const store = useFileStore()
    expect(store.currentFile).toBeNull()

    store.newFile()
    expect(store.currentFile).toMatchObject({ path: null, content: '', dirty: false })
  })

  // 6. tabList computed: names from paths, untitled for null
  it('tabList returns names from paths or Untitled for null', async () => {
    const store = useFileStore()
    await store.openFile('/tmp/readme.md', 'hi')
    store.newFile()
    expect(store.tabList[0].name).toBe('readme.md')
    expect(store.tabList[1].name).toBe('Untitled.md')
  })

  // 7. tabList with multiple untitled: each gets a unique name
  it('tabList with multiple untitled each get sequential names', () => {
    const store = useFileStore()
    store.newFile()
    store.newFile()
    store.newFile()
    const names = store.tabList.map(t => t.name)
    expect(names).toEqual(['Untitled.md', 'Untitled-2.md', 'Untitled-3.md'])
  })

  // 8. hasOpenFiles computed
  it('hasOpenFiles is false initially, true after newFile', () => {
    const store = useFileStore()
    expect(store.hasOpenFiles).toBe(false)
    store.newFile()
    expect(store.hasOpenFiles).toBe(true)
  })

  // 9. updateContent(text): sets content and dirty=true
  it('updateContent sets content and marks dirty', () => {
    const store = useFileStore()
    store.newFile()
    store.updateContent('new text')
    expect(store.openFiles[0].content).toBe('new text')
    expect(store.openFiles[0].dirty).toBe(true)
    expect(store.openFiles[0].saveState).toBe('dirty')
  })

  // 10. markDirty(): sets dirty=true without changing content
  it('markDirty sets dirty without changing content', () => {
    const store = useFileStore()
    store.newFile()
    expect(store.openFiles[0].dirty).toBe(false)
    store.markDirty()
    expect(store.openFiles[0].dirty).toBe(true)
    expect(store.openFiles[0].saveState).toBe('dirty')
    expect(store.openFiles[0].content).toBe('')
  })

  // 11. setActiveTab(idx): clamps to valid range
  it('setActiveTab clamps to valid range', () => {
    const store = useFileStore()
    store.newFile()
    store.newFile()
    store.newFile()

    store.setActiveTab(2)
    expect(store.activeFileIndex).toBe(2)

    store.setActiveTab(-1)
    expect(store.activeFileIndex).toBe(2) // unchanged, out of range

    store.setActiveTab(99)
    expect(store.activeFileIndex).toBe(2) // unchanged, out of range

    store.setActiveTab(0)
    expect(store.activeFileIndex).toBe(0)
  })

  // 12. closeFile on non-dirty: removes file, adjusts activeFileIndex
  it('closeFile on non-dirty removes file and adjusts index', () => {
    const store = useFileStore()
    store.newFile()
    store.newFile()
    store.newFile()
    store.setActiveTab(1)

    store.closeFile(1)
    expect(store.openFiles).toHaveLength(2)
    expect(store.activeFileIndex).toBeLessThan(2)
  })

  // 13. closeFile on last file: creates new blank file
  it('closeFile on last file creates a new blank file', () => {
    const store = useFileStore()
    store.newFile()
    expect(store.openFiles).toHaveLength(1)

    store.closeFile(0)
    expect(store.openFiles).toHaveLength(1) // new blank added
    expect(store.openFiles[0]).toMatchObject({ path: null, content: '', dirty: false })
  })

  // 14. addRecentFile: front, dedup, cap at 12
  it('addRecentFile adds to front, removes duplicates, caps at 12', () => {
    const store = useFileStore()
    for (let i = 0; i < 15; i++) {
      store.addRecentFile(`/tmp/file-${i}.md`)
    }
    expect(store.recentFiles).toHaveLength(12)
    expect(store.recentFiles[0]).toBe('/tmp/file-14.md')

    // adding existing moves to front
    store.addRecentFile('/tmp/file-10.md')
    expect(store.recentFiles[0]).toBe('/tmp/file-10.md')
    expect(store.recentFiles).toHaveLength(12) // no growth
  })

  // 15. removeRecentFile(path)
  it('removeRecentFile removes the path from list', () => {
    const store = useFileStore()
    store.addRecentFile('/tmp/a.md')
    store.addRecentFile('/tmp/b.md')
    expect(store.recentFiles).toHaveLength(2)

    store.removeRecentFile('/tmp/a.md')
    expect(store.recentFiles).toEqual(['/tmp/b.md'])
  })

  // 16. setRecentFiles(paths): deduplicates, caps at 12
  it('setRecentFiles deduplicates and caps at 12', () => {
    const store = useFileStore()
    const paths = Array.from({ length: 20 }, (_, i) => `/tmp/r-${i}.md`)
    // add some duplicates
    paths.push('/tmp/r-0.md', '/tmp/r-1.md')
    store.setRecentFiles(paths)
    expect(store.recentFiles).toHaveLength(12)
    // no duplicates
    expect(new Set(store.recentFiles).size).toBe(12)
  })

  // closeFile removes dirty file without confirmation (caller handles it)
  it('closeFile removes dirty file unconditionally', () => {
    const store = useFileStore()
    store.newFile()
    store.newFile()
    store.updateContent('changed')
    expect(store.openFiles[1].dirty).toBe(true)

    store.closeFile(1)
    expect(store.openFiles).toHaveLength(1)
  })

  // save() on file with path
  it('save() writes file and clears dirty flag', async () => {
    saveFile.mockResolvedValue(undefined)

    const store = useFileStore()
    await store.openFile('/tmp/test.md', 'content')
    store.updateContent('updated')
    expect(store.openFiles[0].dirty).toBe(true)

    await store.save()
    expect(saveFile).toHaveBeenCalledWith('/tmp/test.md', 'updated')
    expect(store.openFiles[0].dirty).toBe(false)
    expect(store.openFiles[0].saveState).toBe('saved')
    expect(store.openFiles[0].saveError).toBeNull()
  })

  it('save() exposes saving state while the disk write is pending', async () => {
    let resolveSave
    saveFile.mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve
    }))

    const store = useFileStore()
    await store.openFile('/tmp/test.md', 'content')
    store.updateContent('updated')

    const saving = store.save()
    expect(store.openFiles[0].saveState).toBe('saving')
    expect(store.openFiles[0].dirty).toBe(true)

    resolveSave()
    await saving

    expect(store.openFiles[0].saveState).toBe('saved')
    expect(store.openFiles[0].dirty).toBe(false)
  })

  it('save() marks failed saves and keeps dirty state', async () => {
    const error = new Error('disk full')
    saveFile.mockRejectedValue(error)

    const store = useFileStore()
    await store.openFile('/tmp/test.md', 'content')
    store.updateContent('updated')

    await expect(store.save()).rejects.toThrow('disk full')
    expect(store.openFiles[0].dirty).toBe(true)
    expect(store.openFiles[0].saveState).toBe('failed')
    expect(store.openFiles[0].saveError).toBe('disk full')
  })

  // saveAs()
  it('saveAs() prompts for path and saves', async () => {
    saveFileDialog.mockResolvedValue('/tmp/new-name.md')
    saveFile.mockResolvedValue(undefined)

    const store = useFileStore()
    store.newFile()
    store.updateContent('hello world')

    await store.saveAs()
    expect(saveFileDialog).toHaveBeenCalledWith('untitled.md')
    expect(saveFile).toHaveBeenCalledWith('/tmp/new-name.md', 'hello world')
    expect(store.openFiles[0].path).toBe('/tmp/new-name.md')
    expect(store.openFiles[0].dirty).toBe(false)
  })

  // openDialog()
  it('openDialog() opens file from dialog result', async () => {
    openFileDialog.mockResolvedValue({ path: '/tmp/from-dialog.md', content: 'dialog content' })

    const store = useFileStore()
    await store.openDialog()
    expect(store.openFiles).toHaveLength(1)
    expect(store.openFiles[0].path).toBe('/tmp/from-dialog.md')
    expect(store.openFiles[0].content).toBe('dialog content')
  })

  it('openDialog() does nothing when dialog is cancelled', async () => {
    openFileDialog.mockResolvedValue(null)

    const store = useFileStore()
    await store.openDialog()
    expect(store.openFiles).toHaveLength(0)
  })

  // ── moveTab ──

  describe('moveTab', () => {
    function storeWith3Files() {
      const store = useFileStore()
      store.openFiles = [
        { path: '/a.md', content: 'A', dirty: false },
        { path: '/b.md', content: 'B', dirty: false },
        { path: '/c.md', content: 'C', dirty: false },
      ]
      store.activeFileIndex = 0
      return store
    }

    it('moves tab forward: [A,B,C] moveTab(0,2) → [B,C,A]', () => {
      const store = storeWith3Files()
      store.moveTab(0, 2)
      expect(store.openFiles.map(f => f.path)).toEqual(['/b.md', '/c.md', '/a.md'])
    })

    it('moves tab backward: [A,B,C] moveTab(2,0) → [C,A,B]', () => {
      const store = storeWith3Files()
      store.moveTab(2, 0)
      expect(store.openFiles.map(f => f.path)).toEqual(['/c.md', '/a.md', '/b.md'])
    })

    it('active tab follows when it is the one being moved', () => {
      const store = storeWith3Files()
      store.activeFileIndex = 0
      store.moveTab(0, 2)
      expect(store.activeFileIndex).toBe(2)
    })

    it('active stays when a neighbor moves past it (active=2, move 0→1)', () => {
      const store = storeWith3Files()
      store.activeFileIndex = 2
      store.moveTab(0, 1)
      expect(store.activeFileIndex).toBe(2)
    })

    it('active shifts down when tab moves from before to after (active=1, move 0→2)', () => {
      const store = storeWith3Files()
      store.activeFileIndex = 1
      store.moveTab(0, 2)
      expect(store.activeFileIndex).toBe(0)
    })

    it('active shifts up when tab moves from after to before (active=1, move 2→0)', () => {
      const store = storeWith3Files()
      store.activeFileIndex = 1
      store.moveTab(2, 0)
      expect(store.activeFileIndex).toBe(2)
    })

    it('same index is a no-op', () => {
      const store = storeWith3Files()
      store.moveTab(1, 1)
      expect(store.openFiles.map(f => f.path)).toEqual(['/a.md', '/b.md', '/c.md'])
    })

    it('out of bounds is a no-op', () => {
      const store = storeWith3Files()
      store.moveTab(-1, 5)
      expect(store.openFiles.map(f => f.path)).toEqual(['/a.md', '/b.md', '/c.md'])
    })
  })

  // ── removeTabForTransfer ──

  describe('removeTabForTransfer', () => {
    it('removes tab and returns file data', () => {
      const store = useFileStore()
      store.openFiles = [
        { path: '/a.md', content: 'A', dirty: false },
        { path: '/b.md', content: 'B', dirty: true },
      ]
      store.activeFileIndex = 0

      const removed = store.removeTabForTransfer(1)
      expect(removed).toMatchObject({ path: '/b.md', content: 'B', dirty: true })
      expect(store.openFiles).toHaveLength(1)
      expect(store.openFiles[0].path).toBe('/a.md')
    })

    it('returns null and does nothing when only 1 tab', () => {
      const store = useFileStore()
      store.openFiles = [{ path: '/a.md', content: 'A', dirty: false }]
      store.activeFileIndex = 0

      const removed = store.removeTabForTransfer(0)
      expect(removed).toBeNull()
      expect(store.openFiles).toHaveLength(1)
    })

    it('adjusts activeFileIndex when removing before active', () => {
      const store = useFileStore()
      store.openFiles = [
        { path: '/a.md', content: 'A', dirty: false },
        { path: '/b.md', content: 'B', dirty: false },
        { path: '/c.md', content: 'C', dirty: false },
      ]
      store.activeFileIndex = 2

      store.removeTabForTransfer(0)
      expect(store.activeFileIndex).toBe(1)
    })

    it('clamps activeFileIndex when removing the active tab', () => {
      const store = useFileStore()
      store.openFiles = [
        { path: '/a.md', content: 'A', dirty: false },
        { path: '/b.md', content: 'B', dirty: false },
      ]
      store.activeFileIndex = 1

      store.removeTabForTransfer(1)
      expect(store.activeFileIndex).toBe(0)
    })
  })

  // ── addFileFromTransfer ──

  describe('addFileFromTransfer', () => {
    it('adds file with correct properties and sets active', () => {
      const store = useFileStore()
      store.newFile()
      expect(store.activeFileIndex).toBe(0)

      store.addFileFromTransfer({ path: '/test.md', content: 'hi', dirty: true })
      expect(store.openFiles).toHaveLength(2)
      expect(store.openFiles[1]).toMatchObject({ path: '/test.md', content: 'hi', dirty: true })
      expect(store.activeFileIndex).toBe(1)
    })

    it('converts empty string path to null', () => {
      const store = useFileStore()
      store.addFileFromTransfer({ path: '', content: '', dirty: false })
      expect(store.openFiles[0].path).toBeNull()
    })

    it('adds to existing tabs without replacing', () => {
      const store = useFileStore()
      store.openFiles = [
        { path: '/a.md', content: 'A', dirty: false },
      ]
      store.addFileFromTransfer({ path: '/b.md', content: 'B', dirty: false })
      expect(store.openFiles).toHaveLength(2)
      expect(store.openFiles[0].path).toBe('/a.md')
      expect(store.openFiles[1].path).toBe('/b.md')
    })
  })

})
