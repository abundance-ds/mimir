import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../stores/workbench.js'
import {
  applyResponsiveZone,
  CONTENT_PANE_MIN_WIDTH,
  fittedEditorWidth,
  responsiveZoneFor,
} from './responsiveLayout.js'

describe('responsive workbench layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('uses wide, compact, and single-focus zones at deterministic boundaries', () => {
    expect(responsiveZoneFor(1280)).toBe('wide')
    expect(responsiveZoneFor(1039)).toBe('compact')
    expect(responsiveZoneFor(760)).toBe('compact')
    expect(responsiveZoneFor(759)).toBe('focus')
  })

  it('keeps both content panes useful in compact mode and one in focus mode', () => {
    const workbench = useWorkbenchStore()
    const desktop = workbench.layoutSnapshot()

    applyResponsiveZone(workbench, 'compact', { desktopLayout: desktop })
    expect(workbench.paneLayout.sidebar.state).toBe('rail')
    expect(workbench.paneLayout.activity.state).toBe('expanded')
    expect(workbench.paneLayout.editor.state).toBe('expanded')

    applyResponsiveZone(workbench, 'focus', { preferEditor: true, desktopLayout: desktop })
    expect(workbench.paneLayout.activity.state).toBe('rail')
    expect(workbench.paneLayout.editor.state).toBe('expanded')

    applyResponsiveZone(workbench, 'focus', { preferEditor: false, desktopLayout: desktop })
    expect(workbench.paneLayout.activity.state).toBe('expanded')
    expect(workbench.paneLayout.editor.state).toBe('rail')
  })

  it.each([
    [760, 372],
    [800, 412],
    [900, 512],
  ])('fits a large remembered Editor at %ipx without clipping content panes', (viewport, expected) => {
    const editor = fittedEditorWidth(viewport, 900, 52)

    expect(editor).toBe(expected)
    expect(52 + CONTENT_PANE_MIN_WIDTH + editor).toBe(viewport)
  })

  it('clamps a large persisted Editor width at desktop size without rewriting the preference', () => {
    expect(fittedEditorWidth(1280, 900, 240)).toBe(704)
    expect(fittedEditorWidth(1600, 900, 240)).toBe(900)
  })

  it('preserves collapsed panels and remembered widths after leaving a narrow window', () => {
    const workbench = useWorkbenchStore()
    workbench.setPaneWidth('sidebar', 286)
    workbench.setPaneState('editor', 'rail')
    const desktop = workbench.layoutSnapshot()

    applyResponsiveZone(workbench, 'focus', { desktopLayout: desktop })
    applyResponsiveZone(workbench, 'wide', { desktopLayout: desktop })

    expect(workbench.layoutSnapshot()).toEqual({ ...desktop, sidebar: { ...desktop.sidebar, state: 'rail' } })
  })
})
