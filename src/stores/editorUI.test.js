import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorUIStore } from './editorUI.js'

describe('editorUI store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has correct initial state', () => {
    const store = useEditorUIStore()

    expect(store.activePanel).toBe('outline')
    expect(store.panelOpen).toBe(false)
    expect(store.sidebarVisible).toBe(true)
    expect(store.viewMode).toBe('source')
    expect(store.activeTab).toBe(0)
    expect(store.zoomLevel).toBe(100)
    expect(store.settingsOpen).toBe(false)
    expect(store.settingsTab).toBe('editor')
  })

  it('selectPanel opens a panel and sets it active', () => {
    const store = useEditorUIStore()

    store.selectPanel('notes')
    expect(store.activePanel).toBe('notes')
    expect(store.panelOpen).toBe(true)
    expect(store.sidebarVisible).toBe(true)
  })

  it('selectPanel toggles off when called with already-open panel', () => {
    const store = useEditorUIStore()

    store.selectPanel('notes')
    expect(store.panelOpen).toBe(true)

    store.selectPanel('notes')
    expect(store.panelOpen).toBe(false)
  })

  it('selectPanel("settings") opens settings dialog without changing activePanel', () => {
    const store = useEditorUIStore()

    store.selectPanel('notes')
    expect(store.activePanel).toBe('notes')

    store.selectPanel('settings')
    expect(store.settingsOpen).toBe(true)
    expect(store.activePanel).toBe('notes')
  })

  it('selectPanel rejects unknown panels silently', () => {
    const store = useEditorUIStore()

    store.selectPanel('agents')
    expect(store.activePanel).toBe('outline')
    expect(store.panelOpen).toBe(false)

    store.selectPanel('export')
    expect(store.activePanel).toBe('outline')
    expect(store.panelOpen).toBe(false)
  })

  it('toggleSidebar toggles panelOpen and sets sidebarVisible', () => {
    const store = useEditorUIStore()

    store.toggleSidebar()
    expect(store.panelOpen).toBe(true)
    expect(store.sidebarVisible).toBe(true)

    store.toggleSidebar()
    expect(store.panelOpen).toBe(false)
    expect(store.sidebarVisible).toBe(true)
  })

  it('closePanel closes the sidebar', () => {
    const store = useEditorUIStore()

    store.selectPanel('notes')
    expect(store.panelShown).toBe(true)

    store.closePanel()
    expect(store.panelOpen).toBe(false)
    expect(store.sidebarVisible).toBe(true)
    expect(store.panelShown).toBe(false)
  })

  it('panelShown is true only when panelOpen and sidebarVisible', () => {
    const store = useEditorUIStore()

    // Initially: panelOpen=false
    expect(store.panelShown).toBe(false)

    store.selectPanel('notes')
    expect(store.panelShown).toBe(true)

    store.sidebarVisible = false
    expect(store.panelShown).toBe(false)
  })

  it('zoomIn increments by 5 and caps at 200', () => {
    const store = useEditorUIStore()

    store.zoomIn()
    expect(store.zoomLevel).toBe(105)

    store.setZoomLevel(198)
    store.zoomIn()
    expect(store.zoomLevel).toBe(200)

    store.zoomIn()
    expect(store.zoomLevel).toBe(200)
  })

  it('zoomOut decrements by 5 and caps at 25', () => {
    const store = useEditorUIStore()

    store.zoomOut()
    expect(store.zoomLevel).toBe(95)

    store.setZoomLevel(27)
    store.zoomOut()
    expect(store.zoomLevel).toBe(25)

    store.zoomOut()
    expect(store.zoomLevel).toBe(25)
  })

  it('setZoomLevel sets the zoom directly', () => {
    const store = useEditorUIStore()

    store.setZoomLevel(150)
    expect(store.zoomLevel).toBe(150)
  })

  // --- openPanel (non-toggling) ---

  it('openPanel opens sidebar to the specified panel', () => {
    const store = useEditorUIStore()
    expect(store.panelShown).toBe(false)

    store.openPanel('notes')
    expect(store.activePanel).toBe('notes')
    expect(store.panelOpen).toBe(true)
    expect(store.sidebarVisible).toBe(true)
  })

  it('openPanel does NOT toggle when called twice with the same panel', () => {
    const store = useEditorUIStore()

    store.openPanel('notes')
    expect(store.panelShown).toBe(true)

    store.openPanel('notes')
    expect(store.panelShown).toBe(true)
    expect(store.activePanel).toBe('notes')
  })

  it('openPanel switches panel when already open on a different panel', () => {
    const store = useEditorUIStore()

    store.openPanel('outline')
    expect(store.activePanel).toBe('outline')

    store.openPanel('notes')
    expect(store.activePanel).toBe('notes')
    expect(store.panelShown).toBe(true)
  })

  it('openPanel rejects invalid panels', () => {
    const store = useEditorUIStore()

    store.openPanel('bogus')
    expect(store.panelOpen).toBe(false)
    expect(store.activePanel).toBe('outline')
  })

})
