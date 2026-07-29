import { describe, expect, it, vi } from 'vitest'
import { createWindowCloseGuard } from './windowCloseGuard.js'

function harness({
  dirtyFiles = [],
  confirm = 'saved',
  awaitReady,
  beforeNativeClose,
  beforeNativeHide,
  hideOnClose = false,
} = {}) {
  let closeHandler = null
  const stop = vi.fn()
  const nativeWindow = {
    close: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async handler => {
      closeHandler = handler
      return stop
    }),
  }
  const flushContent = vi.fn()
  const flushSession = vi.fn(async () => {})
  const confirmFile = vi.fn(async () => confirm)
  const guard = createWindowCloseGuard({
    getWindow: async () => nativeWindow,
    flushContent,
    getDirtyFiles: () => dirtyFiles,
    confirmFile,
    flushSession,
    awaitReady,
    beforeNativeClose,
    beforeNativeHide,
    hideOnClose,
  })
  return {
    guard,
    nativeWindow,
    flushContent,
    flushSession,
    confirmFile,
    stop,
    closeEvent() {
      const preventDefault = vi.fn()
      closeHandler?.({ preventDefault })
      return preventDefault
    },
  }
}

describe('native Editor close guard', () => {
  async function flushMicrotasks() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }
  it('prevents native close synchronously, confirms every dirty file, flushes, then closes once', async () => {
    const files = [{ path: '/a.md', dirty: true }, { path: null, dirty: true }]
    const h = harness({ dirtyFiles: files })
    await h.guard.setup()

    const prevented = h.closeEvent()
    expect(prevented).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.nativeWindow.close).toHaveBeenCalledTimes(1))

    expect(h.flushContent).toHaveBeenCalledTimes(1)
    expect(h.confirmFile.mock.calls.map(call => call[0])).toEqual(files)
    expect(h.flushSession).toHaveBeenCalledTimes(1)
    expect(h.confirmFile.mock.invocationCallOrder[1])
      .toBeLessThan(h.flushSession.mock.invocationCallOrder[0])
    expect(h.flushSession.mock.invocationCallOrder[0])
      .toBeLessThan(h.nativeWindow.close.mock.invocationCallOrder[0])
  })

  it('hides on a macOS-style close request without closing or discarding dirty files', async () => {
    const h = harness({
      dirtyFiles: [{ path: '/draft.md', dirty: true }],
      hideOnClose: true,
    })
    await h.guard.setup()

    const prevented = h.closeEvent()
    expect(prevented).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.nativeWindow.hide).toHaveBeenCalledTimes(1))

    expect(h.flushContent).toHaveBeenCalledTimes(1)
    expect(h.flushSession).toHaveBeenCalledWith([])
    expect(h.confirmFile).not.toHaveBeenCalled()
    expect(h.nativeWindow.close).not.toHaveBeenCalled()
  })

  it('persists settings before hiding and leaves the window visible when that fails', async () => {
    const beforeNativeHide = vi.fn(async () => false)
    const h = harness({ hideOnClose: true, beforeNativeHide })
    await h.guard.setup()

    h.closeEvent()
    await vi.waitFor(() => expect(beforeNativeHide).toHaveBeenCalledTimes(1))

    expect(h.nativeWindow.hide).not.toHaveBeenCalled()
  })

  it('reveals a hidden window before asking about dirty files during app quit', async () => {
    const h = harness({ dirtyFiles: [{ path: '/draft.md', dirty: true }] })

    await h.guard.requestClose({
      closeNative: false,
      revealBeforeConfirm: true,
    })

    expect(h.nativeWindow.show).toHaveBeenCalledTimes(1)
    expect(h.nativeWindow.setFocus).toHaveBeenCalledTimes(1)
    expect(h.nativeWindow.show.mock.invocationCallOrder[0])
      .toBeLessThan(h.confirmFile.mock.invocationCallOrder[0])
  })

  it('leaves the window open when any dirty-file confirmation is cancelled', async () => {
    const h = harness({
      dirtyFiles: [{ path: '/manual-save.md', dirty: true }],
      confirm: 'cancel',
    })
    await h.guard.setup()

    const result = await h.guard.requestClose()

    expect(result).toBe(false)
    expect(h.nativeWindow.close).not.toHaveBeenCalled()
    expect(h.flushSession).not.toHaveBeenCalled()
  })

  it('passes discarded path-backed and untitled files into the final session flush', async () => {
    const files = [
      { path: '/dirty.md', dirty: true },
      { path: null, dirty: true },
    ]
    const h = harness({ dirtyFiles: files, confirm: 'discard' })

    await h.guard.requestClose()

    expect(h.flushSession).toHaveBeenCalledWith(files)
    expect(h.nativeWindow.close).toHaveBeenCalledTimes(1)
  })

  it('does not prompt again for a file already confirmed by Close Tab', async () => {
    const file = { path: '/a.md', dirty: true }
    const h = harness({ dirtyFiles: [file] })
    await h.guard.setup()

    await expect(h.guard.requestClose({ confirmedFiles: [file] })).resolves.toBe(true)

    expect(h.confirmFile).not.toHaveBeenCalled()
    expect(h.nativeWindow.close).toHaveBeenCalledTimes(1)
  })

  it('coalesces repeated close requests and releases its native listener', async () => {
    let release
    const h = harness()
    h.flushSession.mockReturnValue(new Promise(resolve => {
      release = resolve
    }))
    await h.guard.setup()

    const first = h.guard.requestClose()
    const second = h.guard.requestClose()
    await flushMicrotasks()
    expect(h.flushSession).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])
    expect(h.nativeWindow.close).toHaveBeenCalledTimes(1)

    h.guard.dispose()
    expect(h.stop).toHaveBeenCalledTimes(1)
  })

  it('awaits session hydration before inspecting dirty files or writing a close snapshot', async () => {
    let releaseHydration
    const order = []
    const h = harness({
      dirtyFiles: [],
      awaitReady: () => new Promise(resolve => {
        releaseHydration = () => {
          order.push('hydrated')
          resolve()
        }
      }),
    })
    h.flushContent.mockImplementation(() => order.push('content'))
    h.flushSession.mockImplementation(async () => order.push('session'))

    const closing = h.guard.requestClose()
    await flushMicrotasks()
    expect(h.flushContent).not.toHaveBeenCalled()
    expect(h.flushSession).not.toHaveBeenCalled()

    releaseHydration()
    await closing
    expect(order).toEqual(['hydrated', 'content', 'session'])
  })

  it('can validate and persist an application quit without closing the window first', async () => {
    const h = harness({ dirtyFiles: [{ path: '/a.md', dirty: true }] })

    await expect(h.guard.requestClose({ closeNative: false })).resolves.toBe(true)

    expect(h.confirmFile).toHaveBeenCalledTimes(1)
    expect(h.flushSession).toHaveBeenCalledTimes(1)
    expect(h.nativeWindow.close).not.toHaveBeenCalled()
  })

  it('flushes final window-owned settings before native close and aborts on failure', async () => {
    const order = []
    const h = harness({
      beforeNativeClose: vi.fn(async () => {
        order.push('settings')
        return false
      }),
    })
    h.flushSession.mockImplementation(async () => order.push('session'))

    await expect(h.guard.requestClose()).resolves.toBe(false)

    expect(order).toEqual(['session', 'settings'])
    expect(h.nativeWindow.close).not.toHaveBeenCalled()
  })
})
