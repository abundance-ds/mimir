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
    const save = vi.fn(() => Promise.resolve())
    const onError = vi.fn()
    const controller = createAutoSaveController({
      save,
      getFile: () => state.file,
      isAutoSaveEnabled: () => state.autoSaveEnabled,
      onError,
      delay: 1000,
    })
    return { controller, save, onError, state }
  }

  it('does not schedule saves when auto-save is off', async () => {
    const { controller, save } = setup({ autoSaveEnabled: false })

    controller.schedule()
    await vi.advanceTimersByTimeAsync(1200)

    expect(save).not.toHaveBeenCalled()
  })

  it('does not save untitled files', async () => {
    const { controller, save } = setup({
      file: { path: null, dirty: true },
    })

    controller.schedule()
    await vi.advanceTimersByTimeAsync(1200)

    expect(save).not.toHaveBeenCalled()
  })

  it('saves named dirty files after the pause delay', async () => {
    const { controller, save, state } = setup()

    controller.schedule()
    await vi.advanceTimersByTimeAsync(999)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledWith({ source: 'auto', file: state.file })
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
    state.file.dirty = false
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

  it('keeps the save bound to the edited file when another tab becomes active', async () => {
    const fileA = { id: 'a', path: '/tmp/a.md', dirty: true }
    const fileB = { id: 'b', path: '/tmp/b.md', dirty: true }
    const { controller, save, state } = setup({ file: fileA })

    controller.schedule()
    state.file = fileB
    await vi.advanceTimersByTimeAsync(1000)

    expect(save).toHaveBeenCalledWith({ source: 'auto', file: fileA })
  })

  it('retains stable file identity across tab reorder and ignores a later close cleanly', async () => {
    const file = { id: 'stable', path: '/tmp/a.md', dirty: true }
    const { controller, save, state } = setup({ file })

    controller.schedule()
    state.file = null
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledWith({ source: 'auto', file })

    save.mockClear()
    file.dirty = true
    state.file = file
    controller.schedule()
    file.path = null
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('cancels only the timer for the requested file', async () => {
    const fileA = { id: 'a', path: '/tmp/a.md', dirty: true }
    const fileB = { id: 'b', path: '/tmp/b.md', dirty: true }
    const { controller, save, state } = setup({ file: fileA })

    controller.schedule(fileA)
    expect(controller.clear(fileB)).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledWith({ source: 'auto', file: fileA })

    save.mockClear()
    state.file = fileB
    controller.schedule(fileA)
    expect(controller.clear(fileA)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
  })
})
