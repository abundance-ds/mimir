import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  listenToTrackerChanges,
  listenToTrackerOpen,
  setTrackerEnabled,
  trackerStatus,
  updateTrackerConfig,
} from '../services/tracker.js'
import { loadIpcFixture } from '../test/ipcFixtures.js'
import { DEFAULT_TRACKER_CONFIG, useTrackerStore } from './tracker.js'

vi.mock('../services/tracker.js', async importOriginal => ({
  ...(await importOriginal()),
  listenToTrackerChanges: vi.fn(),
  listenToTrackerOpen: vi.fn(),
  setTrackerEnabled: vi.fn(),
  trackerStatus: vi.fn(),
  updateTrackerConfig: vi.fn(),
}))

function status(overrides = {}) {
  const fixture = loadIpcFixture('tracker_status')
  return {
    ...fixture,
    mode: 'disabled',
    config: { ...fixture.config, enabled: false },
    permissions: { ...fixture.permissions, accessibility: false, notifications: null },
    current: null,
    ...overrides,
  }
}

describe('tracker store', () => {
  let changed
  let open

  beforeEach(() => {
    setActivePinia(createPinia())
    changed = null
    open = null
    vi.mocked(listenToTrackerChanges).mockReset().mockImplementation(async callback => {
      changed = callback
      return vi.fn()
    })
    vi.mocked(listenToTrackerOpen).mockReset().mockImplementation(async callback => {
      open = callback
      return vi.fn()
    })
    vi.mocked(trackerStatus).mockReset().mockResolvedValue(status())
    vi.mocked(setTrackerEnabled).mockReset()
    vi.mocked(updateTrackerConfig).mockReset()
  })

  it('initializes disabled and consumes native status and tray-open events', async () => {
    const tracker = useTrackerStore()
    await tracker.initialize()

    expect(tracker.enabled).toBe(false)
    changed({ status: status({
      mode: 'armed',
      revision: 2,
      config: { ...DEFAULT_TRACKER_CONFIG, enabled: true },
    }) })
    open()

    expect(tracker.enabled).toBe(true)
    expect(tracker.mode).toBe('armed')
    expect(tracker.openRequestRevision).toBe(1)
  })

  it('sends a complete normalized config so one field cannot erase privacy choices', async () => {
    vi.mocked(trackerStatus).mockResolvedValue(status({
      config: {
        ...DEFAULT_TRACKER_CONFIG,
        collectBrowserDomains: true,
        includeWindowTitlesInAi: false,
      },
    }))
    vi.mocked(updateTrackerConfig).mockImplementation(async config => status({
      mode: 'armed',
      config,
    }))
    const tracker = useTrackerStore()
    await tracker.initialize()
    await tracker.updateConfig({ nudgeGraceMinutes: 9 })

    expect(updateTrackerConfig).toHaveBeenCalledWith(expect.objectContaining({
      collectBrowserDomains: true,
      includeWindowTitlesInAi: false,
      nudgeGraceMinutes: 9,
      pollIntervalSeconds: 15,
    }))
  })
})
