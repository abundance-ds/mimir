import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, onUnmounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useFileOpen } from './useFileOpen.js'
import { useFileStore } from '../../stores/files.js'

function mountComposable(composableFn) {
  let result
  const Wrapper = defineComponent({
    setup() {
      result = composableFn()
      return () => null
    },
  })
  const wrapper = mount(Wrapper)
  return { wrapper, result }
}

describe('useFileOpen', () => {
  let filesStore
  let listenCallback
  let unlisten

  beforeEach(() => {
    setActivePinia(createPinia())
    filesStore = useFileStore()
    unlisten = vi.fn()
    listenCallback = null

    invoke.mockReset()
    invoke.mockImplementation((cmd, args) => {
      if (cmd === 'take_pending_files') return Promise.resolve([])
      if (cmd === 'read_text_file') return Promise.resolve({ content: `content of ${args.path}` })
      return Promise.resolve()
    })

    getCurrentWindow.mockReturnValue({
      label: 'editor-1',
      listen: vi.fn((event, cb) => {
        listenCallback = cb
        return Promise.resolve(unlisten)
      }),
      emit: vi.fn(),
      onCloseRequested: vi.fn(() => Promise.resolve(vi.fn())),
    })

    window.__TAURI_INTERNALS__ = true
  })

  it('calls take_pending_files on mount and opens returned paths', async () => {
    invoke.mockImplementation((cmd, args) => {
      if (cmd === 'take_pending_files') return Promise.resolve(['/docs/readme.md', '/docs/notes.txt'])
      if (cmd === 'read_text_file') return Promise.resolve({ content: `content of ${args.path}` })
      return Promise.resolve()
    })

    mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(filesStore.openFiles).toHaveLength(2)
    })
    expect(filesStore.openFiles[0].path).toBe('/docs/readme.md')
    expect(filesStore.openFiles[0].content).toBe('content of /docs/readme.md')
    expect(filesStore.openFiles[1].path).toBe('/docs/notes.txt')
  })

  it('opens files from mim://open-file event', async () => {
    mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(listenCallback).toBeTruthy()
    })

    listenCallback({ payload: ['/new/file.md'] })
    await vi.waitFor(() => {
      expect(filesStore.openFiles).toHaveLength(1)
    })
    expect(filesStore.openFiles[0].path).toBe('/new/file.md')
  })

  it('switches to existing tab for duplicate paths', async () => {
    await filesStore.openFile('/existing.md', 'existing content')
    expect(filesStore.openFiles).toHaveLength(1)

    mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(listenCallback).toBeTruthy()
    })

    listenCallback({ payload: ['/existing.md'] })
    await vi.waitFor(() => {
      expect(filesStore.activeFileIndex).toBe(0)
    })
    expect(filesStore.openFiles).toHaveLength(1)
  })

  it('skips files that fail to read without crashing', async () => {
    invoke.mockImplementation((cmd, args) => {
      if (cmd === 'take_pending_files') return Promise.resolve(['/bad.md', '/good.md'])
      if (cmd === 'read_text_file') {
        if (args.path === '/bad.md') return Promise.reject(new Error('not found'))
        return Promise.resolve({ content: 'good' })
      }
      return Promise.resolve()
    })

    mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(filesStore.openFiles).toHaveLength(1)
    })
    expect(filesStore.openFiles[0].path).toBe('/good.md')
  })

  it('cleans up listener on unmount', async () => {
    const { wrapper } = mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(listenCallback).toBeTruthy()
    })

    wrapper.unmount()
    expect(unlisten).toHaveBeenCalled()
  })

  it('handles empty pending files gracefully', async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === 'take_pending_files') return Promise.resolve([])
      return Promise.resolve()
    })

    mountComposable(() => useFileOpen())
    await vi.waitFor(() => {
      expect(listenCallback).toBeTruthy()
    })
    expect(filesStore.openFiles).toHaveLength(0)
  })
})
