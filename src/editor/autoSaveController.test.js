import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutoSaveController } from './autoSaveController.js'

describe('auto-save controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup({ autoSaveEnabled = true, file = { path: '/tmp/doc.md', dirty: true } } = {}) {
    const state = { autoSaveEnabled, file }
    const flush = vi.fn()
    const save = vi.fn(() => Promise.resolve())
    const onError = vi.fn()
    const controller = createAutoSaveController({
      flush,
      save,
      getFile: () => state.file,
      isAutoSaveEnabled: () => state.autoSaveEnabled,
      onError,
      delay: 1000,
    })
    return { controller, flush, save, onError, state }
  }

  it('does not schedule saves when auto-save is off', async () => {
    const { controller, flush, save } = setup({ autoSaveEnabled: false })

    controller.schedule()
    await vi.advanceTimersByTimeAsync(1200)

    expect(flush).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('does not save untitled files', async () => {
    const { controller, flush, save } = setup({
      file: { path: null, dirty: true },
    })

    controller.schedule()
    await vi.advanceTimersByTimeAsync(1200)

    expect(flush).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('saves named dirty files after the pause delay', async () => {
    const { controller, flush, save } = setup()

    controller.schedule()
    await vi.advanceTimersByTimeAsync(999)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(flush).toHaveBeenCalledWith({ bridge: 'flush' })
    expect(save).toHaveBeenCalledWith({ source: 'auto' })
  })

  it('debounces repeated edits', async () => {
    const { controller, save } = setup()

    controller.schedule()
    await vi.advanceTimersByTimeAsync(700)
    controller.schedule()
    await vi.advanceTimersByTimeAsync(700)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not save if the file is clean by the time the timer fires', async () => {
    const { controller, save, state } = setup()

    controller.schedule()
    state.file = { path: '/tmp/doc.md', dirty: false }
    await vi.advanceTimersByTimeAsync(1000)

    expect(save).not.toHaveBeenCalled()
  })

  it('reports save errors without throwing from the timer', async () => {
    const error = new Error('disk full')
    const { controller, save, onError } = setup()
    save.mockRejectedValue(error)

    controller.schedule()
    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledWith(error)
  })
})
