import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { useWorkbenchResize } from './useWorkbenchResize.js'

describe('useWorkbenchResize', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('resizes Sidebar with pointer movement and persists once on release', () => {
    const store = useWorkbenchStore()
    const persist = vi.fn()
    const resize = useWorkbenchResize(store, { persist })

    resize.start('sidebar', { clientX: 100 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }))

    expect(store.paneLayout.sidebar.width).toBe(290)
    expect(resize.dragging.value).toBe(true)

    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 150 }))
    expect(resize.dragging.value).toBe(false)
    expect(persist).toHaveBeenCalledWith(store.layoutSnapshot())
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
    expect(store.paneLayout.sidebar.width).toBe(320)

    resize.dispose()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: -1000 }))
    expect(store.paneLayout.sidebar.width).toBe(320)
    expect(resize.dragging.value).toBe(false)
  })
})
