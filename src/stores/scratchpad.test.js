import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { listen } from '@tauri-apps/api/event'
import { scratchpadSnapshot, saveScratchpad } from '../services/scratchpad.js'
import { useScratchpadStore } from './scratchpad.js'

vi.mock('../services/scratchpad.js', () => ({ scratchpadSnapshot: vi.fn(), saveScratchpad: vi.fn() }))
const snapshot = content => ({ path: '/home/.mimir/scratchpad.md', content, history: [{ time: 1, content }] })

beforeEach(() => vi.resetAllMocks())

describe('Scratchpad native state', () => {
  it('subscribes before reading state and rereads native text for notifications', async () => {
    let changed
    const stop = vi.fn()
    listen.mockImplementation(async (_name, callback) => { changed = callback; return stop })
    scratchpadSnapshot.mockImplementationOnce(async () => {
      expect(changed).toBeTypeOf('function')
      return snapshot('Before')
    }).mockResolvedValueOnce(snapshot('After'))
    const store = useScratchpadStore()
    const dispose = await store.listenForChanges()
    changed({ payload: 'Not authoritative text' })
    await flushPromises()
    expect(store.content).toBe('After')
    expect(store.externalChange).toBe(1)
    dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('removes its listener if the initial snapshot fails', async () => {
    const stop = vi.fn()
    listen.mockResolvedValue(stop)
    scratchpadSnapshot.mockRejectedValueOnce(new Error('Unreadable file'))
    await expect(useScratchpadStore().listenForChanges()).rejects.toThrow('Unreadable file')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('serializes refresh and save so a late snapshot cannot replace a successful save', async () => {
    let finishRead
    scratchpadSnapshot.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    saveScratchpad.mockResolvedValueOnce(snapshot('New text'))
    const store = useScratchpadStore()
    const reading = store.refresh()
    const saving = store.save('New text', 'Old text')
    await flushPromises()
    expect(saveScratchpad).not.toHaveBeenCalled()
    finishRead(snapshot('Old text'))
    await Promise.all([reading, saving])
    expect(store.content).toBe('New text')
  })

  it('refreshes after a failed save and lets the next save proceed', async () => {
    saveScratchpad.mockRejectedValueOnce(new Error('Text changed'))
      .mockResolvedValueOnce(snapshot('Human text'))
    scratchpadSnapshot.mockResolvedValueOnce(snapshot('Agent text'))
    const store = useScratchpadStore()
    await expect(store.save('Human text', 'Old text')).rejects.toThrow('Text changed')
    expect(store.content).toBe('Agent text')
    expect(store.error).toContain('Text changed')
    await store.save('Human text', 'Agent text')
    expect(store.content).toBe('Human text')
    expect(store.error).toBe('')
  })
})
