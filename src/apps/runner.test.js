import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./runtime.js', () => ({
  createAppRuntime: vi.fn(() => ({
    usage: { inputTokens: 10, outputTokens: 20 },
  })),
}))

import { createAppHandle } from './runner.js'
import { createAppRuntime } from './runtime.js'

describe('createAppHandle', () => {
  const app = { id: 'test-app', name: 'Test App', entryPath: './fake-entry.js' }

  beforeEach(() => {
    vi.resetAllMocks()
    createAppRuntime.mockReturnValue({
      usage: { inputTokens: 10, outputTokens: 20 },
    })
  })

  it('returns object with start, cancel, and promise', () => {
    const handle = createAppHandle(app)
    expect(handle).toHaveProperty('start')
    expect(handle).toHaveProperty('cancel')
    expect(handle).toHaveProperty('promise')
    expect(typeof handle.start).toBe('function')
    expect(typeof handle.cancel).toBe('function')
  })

  it('promise is null before start()', () => {
    const handle = createAppHandle(app)
    expect(handle.promise).toBe(null)
  })

  it('start() returns and sets a promise', () => {
    const handle = createAppHandle(app)
    const p = handle.start()
    expect(p).toBeInstanceOf(Promise)
    expect(handle.promise).toBe(p)
  })

  describe('run flow (dynamic import fails)', () => {
    // In test env, dynamic import of a fake path will fail,
    // so we can reliably test the error/failure path.

    it('calls onProgress with initial Starting step', async () => {
      const onProgress = vi.fn()
      const handle = createAppHandle(app, { onProgress })
      await handle.start()

      // First onProgress call should be the "Starting" step
      expect(onProgress).toHaveBeenCalled()
      const firstCall = onProgress.mock.calls[0]
      expect(firstCall[0]).toMatchObject({ type: 'step', name: 'Starting' })
      expect(firstCall[0].time).toBeTypeOf('number')
    })

    it('returns failed summary when import fails', async () => {
      const handle = createAppHandle(app)
      const summary = await handle.start()

      expect(summary.appId).toBe('test-app')
      expect(summary.appName).toBe('Test App')
      expect(summary.status).toBe('failed')
      expect(summary.error).toBeTypeOf('string')
      expect(summary.events).toBeInstanceOf(Array)
      expect(summary.events.length).toBeGreaterThanOrEqual(1)
      expect(summary.startedAt).toBeTypeOf('number')
      expect(summary.completedAt).toBeTypeOf('number')
    })

    it('calls onError when import fails', async () => {
      const onError = vi.fn()
      const handle = createAppHandle(app, { onError })
      await handle.start()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0].status).toBe('failed')
    })

    it('does not call onComplete when run fails', async () => {
      const onComplete = vi.fn()
      const handle = createAppHandle(app, { onComplete })
      await handle.start()

      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  describe('abort path', () => {
    it('cancel() makes an in-flight run return aborted status', async () => {
      const handle = createAppHandle(app)

      // Cancel immediately — the dynamic import will fail anyway,
      // but the abort flag is checked in the catch block
      handle.cancel()
      const summary = await handle.start()

      expect(summary.status).toBe('aborted')
      expect(summary.error).toBe('App was cancelled')
    })

    it('calls onError with aborted summary', async () => {
      const onError = vi.fn()
      const handle = createAppHandle(app, { onError })
      handle.cancel()
      await handle.start()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0].status).toBe('aborted')
    })
  })

  describe('summary shape', () => {
    it('failed summary includes all expected fields', async () => {
      const handle = createAppHandle(app)
      const summary = await handle.start()

      expect(summary).toHaveProperty('appId')
      expect(summary).toHaveProperty('appName')
      expect(summary).toHaveProperty('status')
      expect(summary).toHaveProperty('error')
      expect(summary).toHaveProperty('events')
      expect(summary).toHaveProperty('startedAt')
      expect(summary).toHaveProperty('completedAt')
    })
  })
})
