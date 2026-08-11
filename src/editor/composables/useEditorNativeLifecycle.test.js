import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'

vi.mock('../../shared/platform.js', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('../nativeMenu.js', () => ({
  installNativeEditorMenu: vi.fn(async () => {}),
  shouldInstallNativeEditorMenu: () => false,
}))

import { useEditorNativeLifecycle } from './useEditorNativeLifecycle.js'

describe('useEditorNativeLifecycle update restart', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(confirm).mockReset()
    vi.mocked(confirm).mockResolvedValue(true)
  })

  function harness() {
    const requestClose = vi.fn(async () => true)
    const flush = vi.fn(async () => true)
    const lifecycle = useEditorNativeLifecycle({
      fileManager: { recentFiles: [] },
      editorSettings: { flush },
      windowCloseGuard: { requestClose },
      getActions: () => ({}),
      onError: vi.fn(),
    })
    return { lifecycle, requestClose, flush }
  }

  it('persists the editor and prepares native state before relaunch', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'meetings_snapshot') return { activeMeetingId: null }
      return undefined
    })
    const { lifecycle, requestClose, flush } = harness()

    await expect(lifecycle.prepareAppRelaunch()).resolves.toBe(true)

    expect(requestClose).toHaveBeenCalledWith({
      closeNative: false,
      revealBeforeConfirm: true,
    })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('app_prepare_relaunch')
  })

  it('keeps a recording active when the user cancels restart', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ activeMeetingId: 'meeting-1' })
    vi.mocked(confirm).mockResolvedValue(false)
    const { lifecycle } = harness()

    await expect(lifecycle.prepareAppRelaunch()).resolves.toBe(false)

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('preserve the recording before restart'),
      expect.objectContaining({ okLabel: 'Stop and restart' }),
    )
    expect(invoke).not.toHaveBeenCalledWith('app_prepare_relaunch')
  })
})
