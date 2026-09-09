import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { useWorkbenchResize } from './useWorkbenchResize.js'

describe('useWorkbenchResize', () => {
  let frames

  beforeEach(() => {
    setActivePinia(createPinia())
    frames = new Map()
    let nextFrameId = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId
      nextFrameId += 1
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function runFrame() {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
  }

  it('resizes Sidebar with pointer movement and persists once on release', () => {
    const store = useWorkbenchStore()
    const persist = vi.fn()
    const resize = useWorkbenchResize(store, { persist })

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))
    runFrame()

    expect(store.paneLayout.sidebar.width).toBe(330)
    expect(resize.dragging.value).toBe(true)

    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 150 }))
    expect(resize.dragging.value).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith(store.layoutSnapshot())
  })

  it('coalesces pointer moves into one store write per animation frame', () => {
    const store = useWorkbenchStore()
    const resize = useWorkbenchResize(store)
    const setPaneWidth = vi.spyOn(store, 'setPaneWidth')

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 110 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))

    expect(setPaneWidth).not.toHaveBeenCalled()
    expect(store.paneLayout.sidebar.width).toBe(280)

    runFrame()
    expect(setPaneWidth).toHaveBeenCalledTimes(1)
    expect(setPaneWidth).toHaveBeenCalledWith('sidebar', 330)
  })

  it('flushes the exact final width on release even with a frame pending', () => {
    const store = useWorkbenchStore()
    const resize = useWorkbenchResize(store)
    const setPaneWidth = vi.spyOn(store, 'setPaneWidth')

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 145 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 145 }))

    expect(store.paneLayout.sidebar.width).toBe(325)
    expect(setPaneWidth).toHaveBeenCalledTimes(1)

    runFrame()
    expect(setPaneWidth).toHaveBeenCalledTimes(1)
  })

  it('resizes Editor from its left edge in the opposite direction', () => {
    const store = useWorkbenchStore()
    const resize = useWorkbenchResize(store)

    resize.start('editor', { clientX: 800 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 700 }))

    expect(store.paneLayout.editor.width).toBe(620)
  })

  it('clamps through the store contract and tears down listeners', () => {
    const store = useWorkbenchStore()
    const resize = useWorkbenchResize(store)

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1000 }))
    runFrame()
    expect(store.paneLayout.sidebar.width).toBe(400)

    resize.dispose()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: -1000 }))
    runFrame()
    expect(store.paneLayout.sidebar.width).toBe(400)
    expect(resize.dragging.value).toBe(false)
  })

  it('drops pending frame work on dispose instead of applying it late', () => {
    const store = useWorkbenchStore()
    const resize = useWorkbenchResize(store)
    const setPaneWidth = vi.spyOn(store, 'setPaneWidth')

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))
    resize.dispose()
    runFrame()

    expect(setPaneWidth).not.toHaveBeenCalled()
    expect(store.paneLayout.sidebar.width).toBe(280)
  })
})
