import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPDATE_PHASE, useAppUpdateStore } from './appUpdate.js'

const service = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  version: vi.fn(async () => '0.2.0'),
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
}))

vi.mock('../services/appUpdates.js', () => ({
  appUpdatesSupported: service.supported,
  installedAppVersion: service.version,
  checkForAppUpdate: service.check,
  downloadAndInstallAppUpdate: service.install,
  relaunchUpdatedApp: service.relaunch,
}))

describe('app update store', () => {
  beforeEach(() => {
    service.supported.mockReturnValue(true)
    service.version.mockResolvedValue('0.2.0')
    service.check.mockReset()
    service.install.mockReset()
    service.relaunch.mockReset()
  })

  it('checks once and exposes the available version to toast and Settings', async () => {
    const update = { available: true, version: '0.2.1', body: 'A useful fix.', date: '2026-08-11' }
    service.check.mockResolvedValue(update)
    const updates = useAppUpdateStore()

    const first = updates.checkForUpdate()
    const second = updates.checkForUpdate()
    await Promise.all([first, second])

    expect(service.check).toHaveBeenCalledTimes(1)
    expect(updates.phase).toBe(UPDATE_PHASE.AVAILABLE)
    expect(updates.handoff).toBe('v0.2.0 → v0.2.1')
    expect(updates.toastVisible).toBe(true)
  })

  it('tracks download progress and becomes ready only after install finishes', async () => {
    const update = { available: true, version: '0.2.1' }
    service.check.mockResolvedValue(update)
    service.install.mockImplementation(async (_update, onEvent) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 42 } })
      expect(useAppUpdateStore().progress).toBe(42)
      onEvent({ event: 'Finished' })
      expect(useAppUpdateStore().phase).toBe(UPDATE_PHASE.INSTALLING)
    })
    const updates = useAppUpdateStore()

    await updates.checkForUpdate()
    await expect(updates.installUpdate()).resolves.toBe(true)

    expect(service.install).toHaveBeenCalledWith(update, expect.any(Function))
    expect(updates.phase).toBe(UPDATE_PHASE.READY)
    expect(updates.progress).toBe(100)
  })

  it('keeps automatic check failures silent but gives manual failures a retry state', async () => {
    service.check.mockRejectedValue(new Error('offline'))
    const updates = useAppUpdateStore()

    await updates.checkForUpdate({ automatic: true })
    expect(updates.phase).toBe(UPDATE_PHASE.IDLE)
    expect(updates.errorMessage).toBe('')
    expect(updates.toastVisible).toBe(false)

    await updates.checkForUpdate()
    expect(updates.phase).toBe(UPDATE_PHASE.ERROR)
    expect(updates.errorStage).toBe('check')
    expect(updates.errorDetail).toBe('offline')
  })

  it('does not restart when the document or recording guard cancels', async () => {
    service.check.mockResolvedValue({ available: true, version: '0.2.1' })
    service.install.mockResolvedValue()
    const updates = useAppUpdateStore()
    updates.setRestartGuard(vi.fn(async () => false))
    await updates.checkForUpdate()
    await updates.installUpdate()

    await expect(updates.restartToUpdate()).resolves.toBe(false)

    expect(updates.phase).toBe(UPDATE_PHASE.READY)
    expect(service.relaunch).not.toHaveBeenCalled()
  })

  it('relaunches only after the restart guard succeeds', async () => {
    service.check.mockResolvedValue({ available: true, version: '0.2.1' })
    service.install.mockResolvedValue()
    service.relaunch.mockResolvedValue()
    const updates = useAppUpdateStore()
    const guard = vi.fn(async () => true)
    updates.setRestartGuard(guard)
    await updates.checkForUpdate()
    await updates.installUpdate()

    await expect(updates.restartToUpdate()).resolves.toBe(true)

    expect(guard).toHaveBeenCalledTimes(1)
    expect(service.relaunch).toHaveBeenCalledTimes(1)
  })
})
