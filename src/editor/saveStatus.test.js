import { describe, expect, it } from 'vitest'
import { footerSaveStatus, tabFromFile } from './saveStatus.js'

describe('editor save status presentation', () => {
  it('keeps named auto-saved dirty files out of the tab attention path', () => {
    const tab = tabFromFile({
      id: 1,
      path: '/tmp/doc.md',
      dirty: true,
      saveState: 'dirty',
    }, { autoSaveEnabled: true })

    expect(tab).toMatchObject({
      name: 'doc.md',
      dirty: false,
      saveTone: 'clean',
    })
  })

  it('shows tab attention for manual-save dirty files', () => {
    const tab = tabFromFile({
      id: 1,
      path: '/tmp/doc.md',
      dirty: true,
      saveState: 'dirty',
    }, { autoSaveEnabled: false })

    expect(tab.dirty).toBe(true)
    expect(tab.saveTone).toBe('dirty')
  })

  it('shows tab attention for dirty untitled drafts even when auto-save is on', () => {
    const tab = tabFromFile({
      id: 4,
      path: null,
      dirty: true,
      saveState: 'dirty',
    }, { autoSaveEnabled: true, untitledIndex: 3 })

    expect(tab.name).toBe('Untitled-3.md')
    expect(tab.dirty).toBe(true)
    expect(tab.saveTone).toBe('dirty')
  })

  it('always shows failed saves as tab attention', () => {
    const tab = tabFromFile({
      id: 1,
      path: '/tmp/doc.md',
      dirty: true,
      saveState: 'failed',
    }, { autoSaveEnabled: true })

    expect(tab.dirty).toBe(true)
    expect(tab.saveTone).toBe('failed')
  })

  it('keeps normal auto-save dirty state calm but visible in the footer', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: true, saveState: 'dirty' },
      autoSaveEnabled: true,
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
    })
  })

  it('shows persistent unsaved state when auto-save is off', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: true, saveState: 'dirty' },
      autoSaveEnabled: false,
    })).toEqual({
      label: 'Unsaved changes',
      tone: 'dirty',
      action: 'save',
      title: 'Save now',
    })
  })

  it('shows saving only when the delayed saving indicator is visible', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: true, saveState: 'saving' },
      autoSaveEnabled: true,
      savingVisible: false,
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
    })

    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: true, saveState: 'saving' },
      autoSaveEnabled: true,
      savingVisible: true,
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
      detail: 'Saving...',
      detailTone: 'saving',
    })
  })

  it('shows stable auto-save mode when a named auto-saved file is clean', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: false, saveState: 'saved' },
      autoSaveEnabled: true,
      savedVisible: false,
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
    })
  })

  it('shows stable saved state when auto-save is off and the named file is clean', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: false, saveState: 'saved' },
      autoSaveEnabled: false,
      savedVisible: false,
    })).toEqual({ label: 'Saved', tone: 'saved', action: null, title: '' })

    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: false, saveState: 'saved' },
      autoSaveEnabled: false,
      savedVisible: true,
    })).toEqual({ label: 'Saved', tone: 'confirmed', action: null, title: '' })
  })

  it('shows transient saved feedback when explicitly requested by feedback timing', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: false, saveState: 'saved' },
      autoSaveEnabled: true,
      savedVisible: true,
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
      detail: 'Saved',
      detailTone: 'confirmed',
    })
  })

  it('uses a custom transient saved label when provided', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/my_draft.md', dirty: false, saveState: 'saved' },
      autoSaveEnabled: true,
      savedVisible: true,
      savedLabel: 'Saved as my_draft.md',
    })).toEqual({
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
      detail: 'Saved as my_draft.md',
      detailTone: 'confirmed',
    })
  })

  it('shows save failures persistently', () => {
    expect(footerSaveStatus({
      file: { path: '/tmp/doc.md', dirty: true, saveState: 'failed' },
      autoSaveEnabled: true,
    })).toEqual({
      label: 'Save failed',
      tone: 'failed',
      action: 'retry',
      title: 'Retry save',
    })
  })

  it('shows unsaved drafts as a Save As action', () => {
    expect(footerSaveStatus({
      file: { path: null, dirty: true, saveState: 'dirty' },
      autoSaveEnabled: true,
    })).toEqual({
      label: 'Unsaved draft',
      tone: 'dirty',
      action: 'saveAs',
      title: 'Save draft',
    })
  })
})
