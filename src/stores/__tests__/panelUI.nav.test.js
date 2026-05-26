import { describe, it, expect, beforeEach } from 'vitest'
import { usePanelUIStore } from '../panel/ui.js'

describe('panelUI navigation history', () => {
  let ui

  beforeEach(() => {
    ui = usePanelUIStore()
  })

  it('starts with empty history and no back/forward', () => {
    expect(ui.canGoBack).toBe(false)
    expect(ui.canGoForward).toBe(false)
  })

  it('pushHistory adds session entries', () => {
    ui.pushHistory('s1')
    ui.pushHistory('s2')
    expect(ui.navHistory).toHaveLength(2)
    expect(ui.navHistory[0]).toEqual({ type: 'session', id: 's1' })
    expect(ui.navHistory[1]).toEqual({ type: 'session', id: 's2' })
  })

  it('showProjectHome adds project entries', () => {
    ui.showProjectHome('p1')
    expect(ui.navHistory).toHaveLength(1)
    expect(ui.navHistory[0]).toMatchObject({ type: 'project', id: 'p1' })
    expect(ui.projectHomeId).toBe('p1')
  })

  it('deduplicates consecutive identical entries', () => {
    ui.pushHistory('s1')
    ui.pushHistory('s1')
    expect(ui.navHistory).toHaveLength(1)
  })

  it('deduplicates consecutive project entries', () => {
    ui.showProjectHome('p1')
    ui.showProjectHome('p1')
    expect(ui.navHistory).toHaveLength(1)
  })

  it('does not deduplicate different entries', () => {
    ui.pushHistory('s1')
    ui.showProjectHome('p1')
    ui.pushHistory('s1')
    expect(ui.navHistory).toHaveLength(3)
  })

  it('goBack returns previous entry and enables forward', () => {
    ui.pushHistory('s1')
    ui.showProjectHome('p1')
    ui.pushHistory('s2')

    expect(ui.canGoBack).toBe(true)

    const entry = ui.goBack()
    expect(entry).toMatchObject({ type: 'project', id: 'p1' })
    expect(ui.canGoForward).toBe(true)
  })

  it('goForward returns next entry', () => {
    ui.pushHistory('s1')
    ui.pushProjectHome
    ui.pushHistory('s2')

    ui.goBack()
    const entry = ui.goForward()
    expect(entry).toEqual({ type: 'session', id: 's2' })
  })

  it('goBack returns null when at start', () => {
    ui.pushHistory('s1')
    expect(ui.goBack()).toBeNull()
  })

  it('goForward returns null when at end', () => {
    ui.pushHistory('s1')
    expect(ui.goForward()).toBeNull()
  })

  it('new push after goBack truncates forward history', () => {
    ui.pushHistory('s1')
    ui.pushHistory('s2')
    ui.pushHistory('s3')

    ui.goBack()
    ui.goBack()
    ui.pushHistory('s4')

    expect(ui.navHistory).toHaveLength(2)
    expect(ui.navHistory[1]).toEqual({ type: 'session', id: 's4' })
    expect(ui.canGoForward).toBe(false)
  })

  it('mixed session and project navigation round-trips', () => {
    ui.pushHistory('s1')
    ui.showProjectHome('p1')
    ui.pushHistory('s2')

    const back1 = ui.goBack()
    expect(back1).toMatchObject({ type: 'project', id: 'p1' })

    const back2 = ui.goBack()
    expect(back2).toEqual({ type: 'session', id: 's1' })

    const fwd1 = ui.goForward()
    expect(fwd1).toMatchObject({ type: 'project', id: 'p1' })

    const fwd2 = ui.goForward()
    expect(fwd2).toEqual({ type: 'session', id: 's2' })
  })

  it('showProjectHome includes viewMode and entryId', () => {
    ui.showProjectHome('p1', 'board')
    expect(ui.navHistory[0]).toEqual({ type: 'project', id: 'p1', viewMode: 'board', entryId: null })
  })

  it('showProjectHome defaults viewMode to chat', () => {
    ui.showProjectHome('p1')
    expect(ui.navHistory[0].viewMode).toBe('chat')
    expect(ui.navHistory[0].entryId).toBeNull()
  })

  it('pushProjectNav creates project entries from current projectHomeId', () => {
    ui.projectHomeId = 'p1'
    ui.pushProjectNav('knowledge', null)
    expect(ui.navHistory[0]).toEqual({ type: 'project', id: 'p1', viewMode: 'knowledge', entryId: null })
  })

  it('pushProjectNav with entryId', () => {
    ui.projectHomeId = 'p1'
    ui.pushProjectNav('board', 'entry_1')
    expect(ui.navHistory[0]).toEqual({ type: 'project', id: 'p1', viewMode: 'board', entryId: 'entry_1' })
  })

  it('pushProjectNav is no-op without projectHomeId', () => {
    ui.pushProjectNav('board', null)
    expect(ui.navHistory).toHaveLength(0)
  })

  it('deduplicates project entries including viewMode and entryId', () => {
    ui.showProjectHome('p1', 'board')
    ui.pushProjectNav('board', null)
    expect(ui.navHistory).toHaveLength(1)
  })

  it('different viewMode on same project creates new entry', () => {
    ui.showProjectHome('p1', 'chat')
    ui.pushProjectNav('board', null)
    expect(ui.navHistory).toHaveLength(2)
  })

  it('setNavigatingHistory blocks pushNavEntry', () => {
    ui.setNavigatingHistory(true)
    ui.pushHistory('s1')
    expect(ui.navHistory).toHaveLength(0)
    ui.setNavigatingHistory(false)
    ui.pushHistory('s1')
    expect(ui.navHistory).toHaveLength(1)
  })

  it('caps history at 100 entries', () => {
    for (let i = 0; i < 110; i++) {
      ui.pushHistory(`s${i}`)
    }
    expect(ui.navHistory).toHaveLength(100)
    expect(ui.navHistory[0]).toEqual({ type: 'session', id: 's10' })
    expect(ui.navHistory[99]).toEqual({ type: 'session', id: 's109' })
    expect(ui.historyIndex).toBe(99)
  })

  it('full project tab + entry round-trip', () => {
    ui.pushHistory('s1')
    ui.showProjectHome('p1')
    ui.pushProjectNav('board', null)
    ui.pushProjectNav('board', 'e1')

    expect(ui.navHistory).toHaveLength(4)

    const back1 = ui.goBack()
    expect(back1).toEqual({ type: 'project', id: 'p1', viewMode: 'board', entryId: null })

    const back2 = ui.goBack()
    expect(back2).toEqual({ type: 'project', id: 'p1', viewMode: 'chat', entryId: null })

    const back3 = ui.goBack()
    expect(back3).toEqual({ type: 'session', id: 's1' })

    const fwd = ui.goForward()
    expect(fwd).toMatchObject({ type: 'project', id: 'p1', viewMode: 'chat' })
  })
})
