import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { loadAppData, saveAppData } from '../services/appsCatalog.js'
import { archiveTodayEntry } from '../mimir/apps/todayJournal.js'
import { useTodayStore } from './today.js'

vi.mock('../mimir/apps/todayJournal.js', () => ({ archiveTodayEntry: vi.fn() }))

vi.mock('../services/appsCatalog.js', () => ({ loadAppData: vi.fn(), saveAppData: vi.fn() }))

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const saved = { date: '2026-09-06', text: 'Draft', updatedAt: '2026-09-06T08:00:00Z' }

describe('Today shared state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 6, 12))
    loadAppData.mockReset().mockResolvedValue(JSON.stringify(saved))
    saveAppData.mockReset().mockResolvedValue()
    archiveTodayEntry.mockReset().mockResolvedValue()
  })
  afterEach(() => {
    useTodayStore().$dispose()
    vi.useRealTimers()
  })

  it('returns the saved addition without rereading the scratchpad', async () => {
    const today = useTodayStore()
    const result = await today.append('- [ ] test')
    expect(result).toEqual({
      date: '2026-09-06', updatedAt: new Date().toISOString(),
      contextBefore: 'Draft', appended: '\n\n- [ ] test',
    })
    expect(saved.text + result.appended).toBe(JSON.parse(saveAppData.mock.lastCall[2]).text)
    expect(JSON.parse(saveAppData.mock.calls[0][2]).text).toBe('Draft\n\n- [ ] test')
    expect(await today.read()).toMatchObject({ content: 'Draft\n\n- [ ] test', dirty: false, live: false })
    await today.restore()
    expect(loadAppData).toHaveBeenCalledTimes(1)
  })

  it('returns two nearby context lines without the rest of TODAY', async () => {
    loadAppData.mockResolvedValue(JSON.stringify({ ...saved, text: '# TODAY\n\n## MISC\n- [ ] Existing\n\n' }))
    const result = await useTodayStore().append('- [ ] test')
    expect(result.contextBefore).toBe('## MISC\n- [ ] Existing')
    expect(result.appended).toBe('- [ ] test')
    expect(result.contextBefore).not.toContain('# TODAY')
  })

  it('returns empty context for an empty scratchpad', async () => {
    loadAppData.mockResolvedValue(JSON.stringify({ ...saved, text: '' }))
    expect(await useTodayStore().append('- [ ] test')).toMatchObject({
      contextBefore: '', appended: '- [ ] test',
    })
  })

  it('restores a saved append after the store is recreated', async () => {
    const today = useTodayStore()
    await today.append('- [ ] test')
    const persisted = saveAppData.mock.lastCall[2]
    today.$dispose()
    setActivePinia(createPinia())
    loadAppData.mockResolvedValue(persisted)
    saveAppData.mockClear()
    expect(await useTodayStore().read()).toMatchObject({
      date: '2026-09-06', content: 'Draft\n\n- [ ] test', dirty: false,
    })
    expect(saveAppData).not.toHaveBeenCalled()
  })

  it('preserves existing whitespace and Markdown indentation', async () => {
    loadAppData.mockResolvedValue(JSON.stringify({ ...saved, text: 'Line  \n' }))
    const today = useTodayStore()
    const result = await today.append('    code\n')
    expect(result.appended).toBe('\n    code\n')
    expect(today.text).toBe('Line  \n\n    code\n')
  })

  it('serializes appends with a pending autosave and newer user edits', async () => {
    const gate = deferred()
    saveAppData.mockReturnValueOnce(gate.promise)
    const today = useTodayStore()
    await today.restore()
    today.text = 'User edit'
    today.todayDirty = true
    today.markDirty()
    await vi.advanceTimersByTimeAsync(350)
    today.text += ' still typing'
    today.markDirty()
    const first = today.append('First')
    const second = today.append('Second')
    await flushPromises()
    expect(saveAppData).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([first, second])
    expect(today.text).toBe('User edit still typing\n\nFirst\n\nSecond')
    expect(JSON.parse(saveAppData.mock.lastCall[2]).text).toBe(today.text)
    expect(today.dirty).toBe(false)
  })

  it('finishes autosave when a newer edit arrives during a slow write', async () => {
    const gate = deferred()
    saveAppData.mockReturnValueOnce(gate.promise)
    const today = useTodayStore()
    await today.restore()
    today.text = 'First edit'
    today.todayDirty = true
    today.markDirty()
    await vi.advanceTimersByTimeAsync(350)
    today.text = 'Latest edit'
    today.markDirty()
    await vi.advanceTimersByTimeAsync(350)
    gate.resolve()
    await flushPromises()
    expect(JSON.parse(saveAppData.mock.lastCall[2]).text).toBe('Latest edit')
    expect(today.dirty).toBe(false)
  })

  it('promotes tomorrow and retains the previous day when closed across midnight', async () => {
    loadAppData.mockResolvedValue(JSON.stringify({
      ...saved, date: '2026-09-05', text: '- [ ] Yesterday',
      tomorrow: { date: '2026-09-06', text: 'Planned' },
    }))
    const today = useTodayStore()
    await today.append('Added')
    expect(today.documentDate).toBe('2026-09-06')
    expect(today.text).toBe('Planned\n\nAdded')
    expect(today.previous).toMatchObject({ date: '2026-09-05', text: '- [ ] Yesterday', carryPending: true, archivePending: false })
    expect(today.tomorrow).toBeNull()
    expect(archiveTodayEntry).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-05', text: '- [ ] Yesterday' }))
  })

  it('keeps a failed Journal filing queued without failing the append', async () => {
    loadAppData.mockResolvedValue(JSON.stringify({ ...saved, date: '2026-09-05' }))
    archiveTodayEntry.mockRejectedValue(new Error('offline'))
    const today = useTodayStore()
    await expect(today.append('Added')).resolves.toMatchObject({ date: '2026-09-06' })
    await flushPromises()
    expect(today.previous).toMatchObject({ date: '2026-09-05', text: 'Draft', archivePending: true })
    expect(today.journalIssue).toContain('offline')
    expect(JSON.parse(saveAppData.mock.lastCall[2])).toMatchObject({ text: 'Added', previous: { archivePending: true } })
  })

  it('rejects invalid input without loading or writing', async () => {
    const today = useTodayStore()
    for (const input of [undefined, 1, '', ' \n\t', 'x'.repeat(50001)]) {
      await expect(today.append(input)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(loadAppData).not.toHaveBeenCalled()
    expect(saveAppData).not.toHaveBeenCalled()
  })

  it('does not write after a restore failure and can retry the restore', async () => {
    loadAppData.mockRejectedValueOnce(new Error('unreadable'))
    const today = useTodayStore()
    await expect(today.append('Added')).rejects.toThrow('unreadable')
    expect(saveAppData).not.toHaveBeenCalled()
    await today.append('Added')
    expect(today.text).toBe('Draft\n\nAdded')
  })

  it('reports an applied but unsaved append and retains it for save retry', async () => {
    saveAppData.mockRejectedValueOnce(new Error('disk busy'))
    const today = useTodayStore()
    await expect(today.append('Added')).rejects.toMatchObject({ data: { applied: true, saved: false } })
    expect(await today.read()).toMatchObject({ content: 'Draft\n\nAdded', dirty: true })
    expect(await today.saveNow()).toBe(true)
    expect(JSON.parse(saveAppData.mock.lastCall[2]).text).toBe('Draft\n\nAdded')
  })

  it('cancels an append that is still queued', async () => {
    const gate = deferred()
    saveAppData.mockReturnValueOnce(gate.promise)
    const today = useTodayStore()
    const first = today.append('First')
    const abort = new AbortController()
    const second = today.append('Second', { signal: abort.signal })
    const rejected = expect(second).rejects.toMatchObject({ code: 'cancelled' })
    await flushPromises()
    abort.abort()
    gate.resolve()
    await first
    await rejected
    expect(today.text).toBe('Draft\n\nFirst')
  })

  it('finishes an applied append after cancellation during its save', async () => {
    const gate = deferred()
    saveAppData.mockReturnValueOnce(gate.promise)
    const today = useTodayStore()
    const abort = new AbortController()
    const result = today.append('Added', { signal: abort.signal })
    await flushPromises()
    abort.abort()
    gate.resolve()
    await result
    expect(await today.read()).toMatchObject({ content: 'Draft\n\nAdded', dirty: false })
  })
})
