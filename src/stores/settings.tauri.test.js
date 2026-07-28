import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveEditorSettings: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
}))

vi.mock('../services/dataDir.js', () => ({
  loadSettings: mocks.loadSettings,
  saveEditorSettings: mocks.saveEditorSettings,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
  emit: mocks.emit,
}))

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('settings store native persistence lifecycle', () => {
  let eventListen

  beforeEach(async () => {
    vi.resetModules()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    setActivePinia(createPinia())
    mocks.loadSettings.mockReset().mockResolvedValue({})
    mocks.saveEditorSettings.mockReset().mockResolvedValue()
    mocks.invoke.mockReset().mockResolvedValue()
    const eventApi = await import('@tauri-apps/api/event')
    eventListen = eventApi.listen
    eventListen.mockReset().mockResolvedValue(() => {})
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.useRealTimers()
  })

  async function createStore() {
    const { useSettingsStore } = await import('./settings.js')
    const store = useSettingsStore()
    await store.load()
    return store
  }

  it('serializes slow snapshots so the newest setting is persisted last', async () => {
    const first = deferred()
    const second = deferred()
    mocks.saveEditorSettings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const store = await createStore()

    store.set('editorFontSize', 17)
    const firstSave = store.save()
    store.set('editorFontSize', 19)
    const secondSave = store.save()

    await vi.waitFor(() => expect(mocks.saveEditorSettings).toHaveBeenCalledTimes(1))
    expect(mocks.saveEditorSettings.mock.calls[0][0].editorFontSize).toBe(17)
    first.resolve()
    await vi.waitFor(() => expect(mocks.saveEditorSettings).toHaveBeenCalledTimes(2))
    expect(mocks.saveEditorSettings.mock.calls[1][0].editorFontSize).toBe(19)
    second.resolve()

    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual([true, true])
  })

  it('flushes the latest debounced snapshot exactly once', async () => {
    vi.useFakeTimers()
    const store = await createStore()
    store.set('editorFontSize', 21)

    await expect(store.flush()).resolves.toBe(true)
    expect(mocks.saveEditorSettings).toHaveBeenCalledTimes(1)
    expect(mocks.saveEditorSettings.mock.calls[0][0].editorFontSize).toBe(21)

    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.saveEditorSettings).toHaveBeenCalledTimes(1)
  })

  it('releases its cross-window listener lease on unmount', async () => {
    const unlisten = vi.fn()
    eventListen.mockResolvedValue(unlisten)
    const store = await createStore()

    const release = store.startSync()
    await vi.waitFor(() => expect(eventListen).toHaveBeenCalledWith(
      'mimir://settings-changed',
      expect.any(Function),
    ))
    release()
    release()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
