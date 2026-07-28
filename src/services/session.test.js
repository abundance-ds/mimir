import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { loadSession, saveSession } from './session.js'

describe('editor session service', () => {
  beforeEach(() => {
    invoke.mockReset()
    window.__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.restoreAllMocks()
  })

  it('uses the dedicated atomic native session writer', async () => {
    invoke.mockResolvedValue()
    const session = {
      openFiles: [{ path: '/work/a.md', content: 'draft', dirty: true }],
      activeFileIndex: 0,
    }

    await saveSession(session)

    expect(invoke).toHaveBeenCalledWith('session_save', { session })
  })

  it('returns native session state and reports quarantine diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = { openFiles: [] }
    invoke.mockResolvedValue({
      session,
      diagnostic: 'Invalid editor session was moved aside.',
      quarantinedPath: '/home/me/.mimir/session.json.corrupt-1',
    })

    await expect(loadSession()).resolves.toEqual(session)
    expect(warn).toHaveBeenCalledWith(
      '[session] Invalid editor session was moved aside.',
    )
  })

  it('returns null for a missing session without hiding filesystem errors', async () => {
    invoke.mockResolvedValueOnce({ session: null, diagnostic: null })
    await expect(loadSession()).resolves.toBeNull()

    invoke.mockRejectedValueOnce(new Error('permission denied'))
    await expect(loadSession()).rejects.toThrow('permission denied')
  })

  it('is inert outside the desktop runtime', async () => {
    delete window.__TAURI_INTERNALS__

    await expect(loadSession()).resolves.toBeNull()
    await expect(saveSession({ openFiles: [] })).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })
})
