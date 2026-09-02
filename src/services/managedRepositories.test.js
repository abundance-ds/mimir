import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  disconnectGithub,
  installManagedSyncLifecycle,
  managedProjectStatus,
  moveTeamRepository,
  setupTeamRepository,
} from './managedRepositories.js'

describe('managed repositories service', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset()
  })

  it('signs out through the shared GitHub CLI login', async () => {
    vi.mocked(invoke).mockResolvedValue({ connected: false })

    await disconnectGithub()

    expect(invoke).toHaveBeenCalledWith('github_disconnect')
  })

  it('validates managed Project paths before invoking native code', () => {
    expect(() => managedProjectStatus('')).toThrow('Workspace path is required')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('requires a GitHub repository before Team setup', () => {
    expect(() => setupTeamRepository()).toThrow('GitHub repository URL is required')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('requires a GitHub repository before moving Team', () => {
    expect(() => moveTeamRepository('')).toThrow('GitHub repository URL is required')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('fetches on focus and surfaces only native sync errors', async () => {
    window.__TAURI_INTERNALS__ = {}
    const stopListener = vi.fn()
    let errorHandler
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      errorHandler = handler
      return stopListener
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    const onError = vi.fn()
    const stop = installManagedSyncLifecycle({ onError })
    await Promise.resolve()

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('managed_repositories_sync')

    errorHandler({ payload: { message: 'Reconnect GitHub.', root: '/team' } })
    expect(onError).toHaveBeenCalledWith(
      'Reconnect GitHub.',
      { message: 'Reconnect GitHub.', root: '/team' },
    )

    stop()
    expect(stopListener).toHaveBeenCalledOnce()
  })
})
