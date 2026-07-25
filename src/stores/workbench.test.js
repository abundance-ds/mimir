import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  ACTIVITY_RAIL_WIDTH,
  EDITOR_RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  useWorkbenchStore,
} from './workbench.js'

describe('workbench store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with the complete three-pane workbench expanded', () => {
    const store = useWorkbenchStore()

    expect(store.paneLayout).toEqual({
      sidebar: { state: 'expanded', width: 240 },
      activity: { state: 'expanded', width: 560 },
      editor: { state: 'expanded', width: 520 },
    })
    expect(store.expandedPanes).toEqual(['sidebar', 'activity', 'editor'])
  })

  it('uses the specified permanent rail widths', () => {
    expect(SIDEBAR_RAIL_WIDTH).toBe(52)
    expect(ACTIVITY_RAIL_WIDTH).toBe(44)
    expect(EDITOR_RAIL_WIDTH).toBe(44)
  })

  it('clamps expanded pane widths to their supported ranges', () => {
    const store = useWorkbenchStore()

    store.setPaneWidth('sidebar', 20)
    store.setPaneWidth('activity', 100)
    store.setPaneWidth('editor', 100)
    expect(store.paneLayout.sidebar.width).toBe(180)
    expect(store.paneLayout.activity.width).toBe(336)
    expect(store.paneLayout.editor.width).toBe(336)

    store.setPaneWidth('sidebar', 900)
    expect(store.paneLayout.sidebar.width).toBe(320)
  })

  it('restores Editor when Activity is collapsed while Editor is already railed', () => {
    const store = useWorkbenchStore()
    store.setPaneState('editor', 'rail')
    store.setPaneState('activity', 'rail')

    expect(store.paneLayout.activity.state).toBe('rail')
    expect(store.paneLayout.editor.state).toBe('expanded')
  })

  it('restores Activity when Editor is collapsed while Activity is already railed', () => {
    const store = useWorkbenchStore()
    store.setPaneState('activity', 'rail')
    store.setPaneState('editor', 'rail')

    expect(store.paneLayout.editor.state).toBe('rail')
    expect(store.paneLayout.activity.state).toBe('expanded')
  })

  it('recovers to expanded Activity if a restored snapshot rails every pane', () => {
    const store = useWorkbenchStore()

    store.restoreLayout({
      sidebar: { state: 'rail', width: 240 },
      activity: { state: 'rail', width: 560 },
      editor: { state: 'rail', width: 520 },
    })

    expect(store.paneLayout.sidebar.state).toBe('rail')
    expect(store.paneLayout.activity.state).toBe('expanded')
    expect(store.paneLayout.editor.state).toBe('rail')
  })

  it('sanitizes malformed persisted layout data instead of poisoning the shell', () => {
    const store = useWorkbenchStore()

    store.restoreLayout({
      sidebar: { state: 'gone', width: Number.NaN },
      activity: { state: 'rail', width: -20 },
      editor: null,
    })

    expect(store.paneLayout).toEqual({
      sidebar: { state: 'expanded', width: 240 },
      activity: { state: 'rail', width: 336 },
      editor: { state: 'expanded', width: 520 },
    })
  })

  it('returns a detached serializable layout snapshot', () => {
    const store = useWorkbenchStore()
    store.setPaneState('sidebar', 'rail')
    const snapshot = store.layoutSnapshot()

    snapshot.sidebar.state = 'expanded'

    expect(store.paneLayout.sidebar.state).toBe('rail')
    expect(JSON.parse(JSON.stringify(store.layoutSnapshot()))).toEqual(store.layoutSnapshot())
  })

  it('tracks independent Activity navigation history', () => {
    const store = useWorkbenchStore()

    store.openActivity('files')
    store.openActivity('agent:alpha')
    store.openActivity('terminal:beta')
    expect(store.activeActivityId).toBe('terminal:beta')

    store.previousActivity()
    expect(store.activeActivityId).toBe('agent:alpha')
    store.previousActivity()
    expect(store.activeActivityId).toBe('files')
    store.nextActivity()
    expect(store.activeActivityId).toBe('agent:alpha')

    store.openActivity('app:gamma')
    expect(store.activeActivityId).toBe('app:gamma')
    expect(store.canGoNextActivity).toBe(false)
  })

  it('does not duplicate history when the active Activity is selected again', () => {
    const store = useWorkbenchStore()

    store.openActivity('files')
    store.openActivity('files')
    store.previousActivity()

    expect(store.activeActivityId).toBe('files')
    expect(store.canGoPreviousActivity).toBe(false)
  })

  it('resets navigation and layout cleanly for a different workspace', () => {
    const store = useWorkbenchStore()
    store.openActivity('agent:alpha')
    store.setPaneState('sidebar', 'rail')
    store.setPaneWidth('editor', 700)

    store.resetForWorkspace()

    expect(store.activeActivityId).toBe('files')
    expect(store.canGoPreviousActivity).toBe(false)
    expect(store.paneLayout.sidebar).toEqual({ state: 'expanded', width: 240 })
    expect(store.paneLayout.editor).toEqual({ state: 'expanded', width: 520 })
  })
})
