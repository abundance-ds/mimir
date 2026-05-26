import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelUIStore } from './ui.js'

describe('panel UI store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initializes with correct defaults', () => {
    const store = usePanelUIStore()
    expect(store.sidebarOpen).toBe(true)
    expect(store.mobileChatOpen).toBe(false)
    expect(store.showAddProjectDialog).toBe(false)
    expect(store.projectDialogMode).toBe('new')
    expect(store.showSettingsDialog).toBe(false)
    expect(store.searchQuery).toBe('')
    expect(store.newChatStartMode).toBe('chat')
    expect(store.storageReady).toBe(false)
  })

  it('openProjectDialog("clone") sets mode to clone and opens dialog', () => {
    const store = usePanelUIStore()
    store.openProjectDialog('clone')
    expect(store.projectDialogMode).toBe('clone')
    expect(store.showAddProjectDialog).toBe(true)
  })

  it('openProjectDialog() defaults to "new"', () => {
    const store = usePanelUIStore()
    store.openProjectDialog()
    expect(store.projectDialogMode).toBe('new')
    expect(store.showAddProjectDialog).toBe(true)
  })

  it('openProjectDialog with unknown mode defaults to "new"', () => {
    const store = usePanelUIStore()
    store.openProjectDialog('unknown')
    expect(store.projectDialogMode).toBe('new')
    expect(store.showAddProjectDialog).toBe(true)
  })

  it('closeProjectDialog sets showAddProjectDialog to false', () => {
    const store = usePanelUIStore()
    store.showAddProjectDialog = true
    store.closeProjectDialog()
    expect(store.showAddProjectDialog).toBe(false)
  })

  it('normalizedQuery trims and lowercases', () => {
    const store = usePanelUIStore()
    store.searchQuery = '  Hello World  '
    expect(store.normalizedQuery()).toBe('hello world')
  })

  it('normalizedQuery returns empty string for empty input', () => {
    const store = usePanelUIStore()
    store.searchQuery = '   '
    expect(store.normalizedQuery()).toBe('')
  })

  it('toggles and explicitly sets sidebar state', () => {
    const store = usePanelUIStore()
    store.toggleSidebar()
    expect(store.sidebarOpen).toBe(false)
    store.openSidebar()
    expect(store.sidebarOpen).toBe(true)
    store.closeSidebar()
    expect(store.sidebarOpen).toBe(false)
  })
})
