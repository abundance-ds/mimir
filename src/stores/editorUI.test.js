import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorUIStore } from './editorUI.js'

describe('editorUI store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with focused editor defaults', () => {
    const store = useEditorUIStore()
    expect(store.zoomLevel).toBe(100)
    expect(store.settingsOpen).toBe(false)
  })

  it('zooms in and out with hard readable bounds', () => {
    const store = useEditorUIStore()
    store.zoomIn()
    expect(store.zoomLevel).toBe(105)
    store.setZoomLevel(198)
    store.zoomIn()
    expect(store.zoomLevel).toBe(200)
    store.setZoomLevel(27)
    store.zoomOut()
    expect(store.zoomLevel).toBe(25)
  })

  it('clamps direct zoom changes', () => {
    const store = useEditorUIStore()
    store.setZoomLevel(500)
    expect(store.zoomLevel).toBe(200)
    store.setZoomLevel(1)
    expect(store.zoomLevel).toBe(25)
  })
})
