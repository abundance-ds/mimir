import { describe, expect, it, vi } from 'vitest'
import { completeNativeQuit } from './appQuit.js'

function harness({ guarded = true, settingsSaved = true } = {}) {
  const order = []
  const requestClose = vi.fn(async () => {
    order.push('documents')
    return guarded
  })
  const flushSettings = vi.fn(async () => {
    order.push('settings')
    return settingsSaved
  })
  const confirmQuit = vi.fn(async () => {
    order.push('quit')
  })
  return { order, requestClose, flushSettings, confirmQuit }
}

describe('completeNativeQuit', () => {
  it('persists documents/session, then settings, then confirms native quit', async () => {
    const h = harness()
    await expect(completeNativeQuit(h)).resolves.toBe(true)
    expect(h.order).toEqual(['documents', 'settings', 'quit'])
    expect(h.requestClose).toHaveBeenCalledWith({ closeNative: false })
  })

  it('does nothing after a cancelled dirty-document guard', async () => {
    const h = harness({ guarded: false })
    await expect(completeNativeQuit(h)).resolves.toBe(false)
    expect(h.order).toEqual(['documents'])
    expect(h.flushSettings).not.toHaveBeenCalled()
    expect(h.confirmQuit).not.toHaveBeenCalled()
  })

  it('does not exit when the final settings snapshot cannot be persisted', async () => {
    const h = harness({ settingsSaved: false })
    await expect(completeNativeQuit(h)).resolves.toBe(false)
    expect(h.order).toEqual(['documents', 'settings'])
    expect(h.confirmQuit).not.toHaveBeenCalled()
  })
})
