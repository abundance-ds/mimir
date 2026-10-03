import { afterEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { checkSpelling, spellingSuggestions } from './spelling.js'

afterEach(() => { delete window.__TAURI_INTERNALS__; vi.mocked(invoke).mockReset() })

it('uses no native request in browser-only previews', async () => {
  delete window.__TAURI_INTERNALS__
  expect(await checkSpelling('mispelled')).toEqual([])
  expect(await spellingSuggestions('mispelled')).toEqual([])
  expect(invoke).not.toHaveBeenCalled()
})

it('serializes checks and skips canceled queued text', async () => {
  window.__TAURI_INTERNALS__ = {}
  let finish
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = checkSpelling('😀 mispelled')
  const controller = new AbortController()
  const second = checkSpelling('old document', { signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  finish([{ from: 3, to: 12 }, { from: -1, to: 5 }, { from: 0, to: 999 }])
  expect(await first).toEqual([{ from: 3, to: 12 }])
  expect(await second).toEqual([])
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('recovers after a native error without disabling later checks', async () => {
  window.__TAURI_INTERNALS__ = {}
  vi.mocked(invoke).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([])
  await expect(checkSpelling('one')).rejects.toThrow('unavailable')
  await expect(checkSpelling('two')).resolves.toEqual([])
})
