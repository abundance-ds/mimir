import { describe, it, expect, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import HistoryView from './HistoryView.vue'
import { useSessionStore } from '../../../stores/panel/sessions.js'
import { usePanelUIStore } from '../../../stores/panel/ui.js'

function makeMeta(overrides = {}) {
  return {
    id: overrides.id || 'sess-1',
    label: overrides.label || 'Test session',
    projectId: overrides.projectId || 'proj-1',
    createdAt: overrides.createdAt || '2026-05-20T10:00:00Z',
    updatedAt: overrides.updatedAt || '2026-05-20T12:00:00Z',
    ...overrides,
  }
}

describe('HistoryView', () => {
  let panelUI, sessionStore

  beforeEach(() => {
    panelUI = usePanelUIStore()
    sessionStore = useSessionStore()
    panelUI.projectHomeId = 'proj-1'
    sessionStore.sessions = []
    sessionStore.archivedMetas = []
  })

  function mount() {
    return shallowMount(HistoryView)
  }

  it('shows empty state when no sessions', () => {
    const w = mount()
    expect(w.text()).toContain('No sessions yet')
  })

  it('shows active sessions for the current project', () => {
    sessionStore.sessions = [
      makeMeta({ id: 's1', label: 'Session one', projectId: 'proj-1' }),
      makeMeta({ id: 's2', label: 'Session two', projectId: 'proj-2' }),
    ]
    const w = mount()
    expect(w.text()).toContain('Session one')
    expect(w.text()).not.toContain('Session two')
  })

  it('shows archived sessions for the current project', () => {
    sessionStore.archivedMetas = [
      makeMeta({ id: 'a1', label: 'Archived one', projectId: 'proj-1' }),
      makeMeta({ id: 'a2', label: 'Archived two', projectId: 'proj-2' }),
    ]
    const w = mount()
    expect(w.text()).toContain('Archived one')
    expect(w.text()).not.toContain('Archived two')
  })

  it('shows "Archived" divider when both active and archived exist', () => {
    sessionStore.sessions = [makeMeta({ id: 's1', projectId: 'proj-1' })]
    sessionStore.archivedMetas = [makeMeta({ id: 'a1', projectId: 'proj-1' })]
    const w = mount()
    expect(w.text()).toContain('Archived')
  })

  it('filters sessions by search query', async () => {
    sessionStore.sessions = [
      makeMeta({ id: 's1', label: 'Design review', projectId: 'proj-1' }),
      makeMeta({ id: 's2', label: 'Sprint planning', projectId: 'proj-1' }),
    ]
    const w = mount()
    await w.find('input[type="search"]').setValue('design')
    expect(w.text()).toContain('Design review')
    expect(w.text()).not.toContain('Sprint planning')
  })

  it('collapses archived after 5 with "show more" button', () => {
    sessionStore.archivedMetas = Array.from({ length: 8 }, (_, i) =>
      makeMeta({ id: `a${i}`, label: `Archived ${i}`, projectId: 'proj-1' }),
    )
    const w = mount()
    const archivedRows = w.findAll('.hv-archived')
    expect(archivedRows).toHaveLength(5)
    expect(w.text()).toContain('Show 3 more')
  })

  it('expands archived when "show more" is clicked', async () => {
    sessionStore.archivedMetas = Array.from({ length: 8 }, (_, i) =>
      makeMeta({ id: `a${i}`, label: `Archived ${i}`, projectId: 'proj-1' }),
    )
    const w = mount()
    const showMoreBtn = w.findAll('button').find(b => b.text().includes('Show 3 more'))
    await showMoreBtn.trigger('click')
    expect(w.findAll('.hv-archived')).toHaveLength(8)
  })

  it('shows Restore button on archived sessions', () => {
    sessionStore.archivedMetas = [makeMeta({ id: 'a1', projectId: 'proj-1' })]
    const w = mount()
    expect(w.text()).toContain('Restore')
  })
})
