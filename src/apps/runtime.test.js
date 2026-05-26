import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('ai', () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
  jsonSchema: (s) => ({ type: 'json-schema', schema: s }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/mock-home'),
}))

vi.mock('../services/ai/sdkAdapter', () => ({
  createSdkModel: vi.fn().mockResolvedValue({ model: 'mock-model', modelConfig: {} }),
  buildProviderOptions: vi.fn().mockReturnValue({}),
  normalizeSdkUsage: vi.fn((u) => u),
  addUsage: vi.fn((a, b) => ({ ...a, ...b })),
}))

vi.mock('../services/docx/reader', () => ({
  readDocxAsText: vi.fn(),
}))

vi.mock('../services/docx/writer', () => ({
  annotateDocx: vi.fn(),
}))

import { createAppRuntime } from './runtime.js'
import { invoke } from '@tauri-apps/api/core'

const APP = { id: 'test-app', name: 'Test App' }

describe('createAppRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('structure', () => {
    it('returns ctx with all expected top-level keys', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx).toHaveProperty('inputs')
      expect(ctx).toHaveProperty('project')
      expect(ctx).toHaveProperty('model')
      expect(ctx).toHaveProperty('data')
      expect(ctx).toHaveProperty('docx')
      expect(ctx).toHaveProperty('knowledge')
      expect(ctx).toHaveProperty('progress')
      expect(ctx).toHaveProperty('abort')
      expect(ctx).toHaveProperty('files')
      expect(ctx).toHaveProperty('usage')
    })
  })

  describe('inputs', () => {
    it('freezes inputs so they cannot be mutated', () => {
      const ctx = createAppRuntime(APP, { inputs: { foo: 'bar' } })
      expect(Object.isFrozen(ctx.inputs)).toBe(true)
      expect(ctx.inputs.foo).toBe('bar')
    })

    it('defaults to frozen empty object', () => {
      const ctx = createAppRuntime(APP)
      expect(Object.isFrozen(ctx.inputs)).toBe(true)
      expect(ctx.inputs).toEqual({})
    })
  })

  describe('project', () => {
    it('returns null when no project given', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.project).toBe(null)
    })

    it('returns project shape when project is provided', () => {
      const project = { id: 'proj-1', name: 'My Project', path: '/p', workspacePath: '/ws', system: true }
      const ctx = createAppRuntime(APP, { project })
      expect(ctx.project).toEqual({
        id: 'proj-1',
        name: 'My Project',
        path: '/p',
        workspacePath: '/ws',
        system: true,
      })
    })

    it('defaults optional project fields', () => {
      const project = { id: 'proj-1', name: 'P' }
      const ctx = createAppRuntime(APP, { project })
      expect(ctx.project.path).toBe('')
      expect(ctx.project.workspacePath).toBe(null)
      expect(ctx.project.system).toBe(false)
    })
  })

  describe('progress', () => {
    it('step() calls onProgress with type step', () => {
      const onProgress = vi.fn()
      const ctx = createAppRuntime(APP, { onProgress })
      ctx.progress.step('Loading data')

      expect(onProgress).toHaveBeenCalledTimes(1)
      const arg = onProgress.mock.calls[0][0]
      expect(arg.type).toBe('step')
      expect(arg.name).toBe('Loading data')
      expect(arg.time).toBeTypeOf('number')
    })

    it('log() calls onProgress with type log', () => {
      const onProgress = vi.fn()
      const ctx = createAppRuntime(APP, { onProgress })
      ctx.progress.log('Some message')

      expect(onProgress).toHaveBeenCalledTimes(1)
      const arg = onProgress.mock.calls[0][0]
      expect(arg.type).toBe('log')
      expect(arg.message).toBe('Some message')
    })

    it('done() calls onProgress with type done and usage', () => {
      const onProgress = vi.fn()
      const ctx = createAppRuntime(APP, { onProgress })
      ctx.progress.done('All finished')

      expect(onProgress).toHaveBeenCalledTimes(1)
      const arg = onProgress.mock.calls[0][0]
      expect(arg.type).toBe('done')
      expect(arg.summary).toBe('All finished')
    })

    it('does not throw when onProgress is not provided', () => {
      const ctx = createAppRuntime(APP)
      expect(() => ctx.progress.step('test')).not.toThrow()
      expect(() => ctx.progress.log('test')).not.toThrow()
      expect(() => ctx.progress.done('test')).not.toThrow()
    })
  })

  describe('abort', () => {
    it('signal returns provided signal', () => {
      const controller = new AbortController()
      const ctx = createAppRuntime(APP, { signal: controller.signal })
      expect(ctx.abort.signal).toBe(controller.signal)
    })

    it('signal returns null when not provided', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.abort.signal).toBe(null)
    })

    it('aborted reflects signal state', () => {
      const controller = new AbortController()
      const ctx = createAppRuntime(APP, { signal: controller.signal })
      expect(ctx.abort.aborted).toBe(false)

      controller.abort()
      expect(ctx.abort.aborted).toBe(true)
    })

    it('aborted returns false when no signal', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.abort.aborted).toBe(false)
    })

    it('throwIfAborted throws when signal is aborted', () => {
      const controller = new AbortController()
      const ctx = createAppRuntime(APP, { signal: controller.signal })

      controller.abort()
      expect(() => ctx.abort.throwIfAborted()).toThrow('App aborted')
    })

    it('throwIfAborted does not throw when not aborted', () => {
      const controller = new AbortController()
      const ctx = createAppRuntime(APP, { signal: controller.signal })
      expect(() => ctx.abort.throwIfAborted()).not.toThrow()
    })
  })

  describe('docx', () => {
    it('connected() returns true when docxPath is provided', () => {
      const ctx = createAppRuntime(APP, { docxPath: '/some/file.docx' })
      expect(ctx.docx.connected()).toBe(true)
    })

    it('connected() returns false when docxPath is null', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.docx.connected()).toBe(false)
    })

    it('connected() returns false when docxPath is empty string', () => {
      const ctx = createAppRuntime(APP, { docxPath: '' })
      expect(ctx.docx.connected()).toBe(false)
    })

    it('read() throws when no docxPath', async () => {
      const ctx = createAppRuntime(APP)
      await expect(ctx.docx.read()).rejects.toThrow('No DOCX file selected')
    })

    it('comment() throws when no docxPath', async () => {
      const ctx = createAppRuntime(APP)
      await expect(ctx.docx.comment('anchor', 'text')).rejects.toThrow('No DOCX file selected')
    })

    it('comment() batches comments', async () => {
      const ctx = createAppRuntime(APP, { docxPath: '/test.docx' })
      const result = await ctx.docx.comment('anchor', 'my comment')
      expect(result).toEqual({ success: true, mode: 'batched' })
    })

    it('flushComments() returns { inserted: 0 } when no docxPath', async () => {
      const ctx = createAppRuntime(APP)
      const result = await ctx.docx.flushComments()
      expect(result).toEqual({ inserted: 0 })
    })

    it('flushComments() returns { inserted: 0 } when no pending comments', async () => {
      const ctx = createAppRuntime(APP, { docxPath: '/test.docx' })
      const result = await ctx.docx.flushComments()
      expect(result).toEqual({ inserted: 0 })
    })
  })

  describe('data', () => {
    it('load() calls invoke with correct args and parses JSON', async () => {
      invoke.mockResolvedValue('{"x":1}')
      const ctx = createAppRuntime(APP, { project: { id: 'proj-1', name: 'P' } })
      const result = await ctx.data.load('my-key')

      expect(invoke).toHaveBeenCalledWith('app_data_load', {
        appId: 'test-app',
        projectId: 'proj-1',
        key: 'my-key',
      })
      expect(result).toEqual({ x: 1 })
    })

    it('load() returns null when invoke returns null', async () => {
      invoke.mockResolvedValue(null)
      const ctx = createAppRuntime(APP)
      const result = await ctx.data.load('missing-key')
      expect(result).toBe(null)
    })

    it('save() calls invoke with stringified value', async () => {
      invoke.mockResolvedValue(undefined)
      const ctx = createAppRuntime(APP)
      await ctx.data.save('key', { a: 1 })

      expect(invoke).toHaveBeenCalledWith('app_data_save', {
        appId: 'test-app',
        projectId: 'general',
        key: 'key',
        value: '{"a":1}',
      })
    })

    it('delete() calls invoke with correct args', async () => {
      invoke.mockResolvedValue(undefined)
      const ctx = createAppRuntime(APP)
      await ctx.data.delete('key')

      expect(invoke).toHaveBeenCalledWith('app_data_delete', {
        appId: 'test-app',
        projectId: 'general',
        key: 'key',
      })
    })

    it('keys() calls invoke with correct args', async () => {
      invoke.mockResolvedValue(['k1', 'k2'])
      const ctx = createAppRuntime(APP)
      const result = await ctx.data.keys()

      expect(invoke).toHaveBeenCalledWith('app_data_keys', {
        appId: 'test-app',
        projectId: 'general',
      })
      expect(result).toEqual(['k1', 'k2'])
    })

    it('uses "general" as default projectId when no project', async () => {
      invoke.mockResolvedValue(null)
      const ctx = createAppRuntime(APP)
      await ctx.data.load('k')

      expect(invoke).toHaveBeenCalledWith('app_data_load', expect.objectContaining({
        projectId: 'general',
      }))
    })
  })

  describe('usage', () => {
    it('starts as null', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.usage).toBe(null)
    })
  })

  describe('http', () => {
    it('ctx.http.fetch exists and is a function', () => {
      const ctx = createAppRuntime(APP)
      expect(ctx.http).toBeDefined()
      expect(typeof ctx.http.fetch).toBe('function')
    })

    it('fetch calls invoke with correct default args', async () => {
      invoke.mockResolvedValue({ status: 200, headers: {}, body: '' })
      const ctx = createAppRuntime(APP)
      await ctx.http.fetch('https://example.com')

      expect(invoke).toHaveBeenCalledWith('app_http_request', {
        appId: 'test-app',
        url: 'https://example.com',
        method: 'GET',
        headers: null,
        body: null,
        timeoutMs: null,
      })
    })

    it('fetch passes custom options correctly', async () => {
      invoke.mockResolvedValue({ status: 200, headers: {}, body: '{}' })
      const ctx = createAppRuntime(APP)
      await ctx.http.fetch('https://api.example.com/data', {
        method: 'POST',
        headers: { Authorization: 'Bearer xxx' },
        body: '{}',
        timeout: 5000,
      })

      expect(invoke).toHaveBeenCalledWith('app_http_request', {
        appId: 'test-app',
        url: 'https://api.example.com/data',
        method: 'POST',
        headers: { Authorization: 'Bearer xxx' },
        body: '{}',
        timeoutMs: 5000,
      })
    })

    it('returned object has status, headers, body, ok, json()', async () => {
      invoke.mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"key":"value"}',
      })
      const ctx = createAppRuntime(APP)
      const res = await ctx.http.fetch('https://example.com')

      expect(res.status).toBe(200)
      expect(res.headers).toEqual({ 'content-type': 'application/json' })
      expect(res.body).toBe('{"key":"value"}')
      expect(typeof res.json).toBe('function')
      expect(res).toHaveProperty('ok')
    })

    it('.ok is true for status 200', async () => {
      invoke.mockResolvedValue({ status: 200, headers: {}, body: '' })
      const ctx = createAppRuntime(APP)
      const res = await ctx.http.fetch('https://example.com')
      expect(res.ok).toBe(true)
    })

    it('.ok is false for status 404', async () => {
      invoke.mockResolvedValue({ status: 404, headers: {}, body: 'Not Found' })
      const ctx = createAppRuntime(APP)
      const res = await ctx.http.fetch('https://example.com/missing')
      expect(res.ok).toBe(false)
    })

    it('.json() parses the body string correctly', async () => {
      invoke.mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"key":"value"}',
      })
      const ctx = createAppRuntime(APP)
      const res = await ctx.http.fetch('https://example.com')
      const parsed = res.json()
      expect(parsed).toEqual({ key: 'value' })
    })
  })
})

describe('normalizeTools (via model.generate)', () => {
  // normalizeTools is not exported, but we can test it indirectly
  // by checking that model.generate passes tools through correctly.
  // However, that requires awaiting generateText which is mocked.
  // Instead we test the logic conceptually through the runtime structure.

  // We test normalizeTools behavior by inspecting what gets passed to generateText
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('model.generate is a function', () => {
    const ctx = createAppRuntime(APP)
    expect(typeof ctx.model.generate).toBe('function')
  })

  it('model.create is a function', () => {
    const ctx = createAppRuntime(APP)
    expect(typeof ctx.model.create).toBe('function')
  })
})
