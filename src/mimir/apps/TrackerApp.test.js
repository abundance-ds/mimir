import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { loadIpcFixture } from '../../test/ipcFixtures.js'
import {
  listenToTrackerChanges,
  listenToTrackerOpen,
  setTrackerEnabled,
  trackerQuery,
  trackerReport,
  trackerStatus,
} from '../../services/tracker.js'
import TrackerApp from './TrackerApp.vue'

vi.mock('../../services/tracker.js', () => ({
  endTrackerBreak: vi.fn(),
  importArgus: vi.fn(),
  listenToTrackerChanges: vi.fn(),
  listenToTrackerOpen: vi.fn(),
  previewArgusImport: vi.fn(),
  requestTrackerAccessibility: vi.fn(),
  setTrackerArmed: vi.fn(),
  setTrackerEnabled: vi.fn(),
  startTrackerBreak: vi.fn(),
  trackerClassifications: vi.fn(),
  trackerQuery: vi.fn(),
  trackerReport: vi.fn(),
  trackerStatus: vi.fn(),
  updateTrackerClassification: vi.fn(),
  updateTrackerConfig: vi.fn(),
  updateTrackerContext: vi.fn(),
}))

function enabledStatus(overrides = {}) {
  return { ...loadIpcFixture('tracker_status'), ...overrides }
}

function disabledStatus() {
  const fixture = enabledStatus()
  return {
    ...fixture,
    mode: 'disabled',
    config: { ...fixture.config, enabled: false },
    current: null,
  }
}

function mountTracker() {
  return mount(TrackerApp, {
    props: { active: true },
    global: {
      stubs: {
        TrackerTimeline: { template: '<div data-timeline />' },
        TrackerOverview: { template: '<div data-overview />' },
        TrackerLog: { template: '<div data-log />' },
        TrackerClassifications: { template: '<div data-classifications />' },
      },
    },
  })
}

describe('TrackerApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listenToTrackerChanges).mockResolvedValue(vi.fn())
    vi.mocked(listenToTrackerOpen).mockResolvedValue(vi.fn())
    vi.mocked(trackerStatus).mockResolvedValue(enabledStatus())
    vi.mocked(trackerQuery).mockResolvedValue(loadIpcFixture('tracker_query'))
    vi.mocked(trackerReport).mockResolvedValue(loadIpcFixture('tracker_report'))
    vi.mocked(setTrackerEnabled).mockResolvedValue(enabledStatus())
  })

  it('renders the native report surface from golden Rust response shapes', async () => {
    const wrapper = mountTracker()
    await flushPromises()

    expect(wrapper.get('[data-tracker-app]').attributes('data-tracker-mode')).toBe('armed')
    expect(wrapper.get('[data-tracker-report]').exists()).toBe(true)
    expect(wrapper.get('[data-timeline]').exists()).toBe(true)
    expect(trackerReport).toHaveBeenCalled()
    expect(trackerQuery).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('does no report work while disabled and can opt in from the empty state', async () => {
    vi.mocked(trackerStatus)
      .mockResolvedValueOnce(disabledStatus())
      .mockResolvedValue(enabledStatus())
    const wrapper = mountTracker()
    await flushPromises()

    expect(wrapper.get('[data-tracker-enable-empty]').text()).toContain('Enable Tracker')
    expect(trackerReport).not.toHaveBeenCalled()

    await wrapper.get('[data-tracker-enable-empty]').trigger('click')
    await flushPromises()

    expect(setTrackerEnabled).toHaveBeenCalledWith(true)
    expect(wrapper.find('[data-tracker-report]').exists()).toBe(true)

    wrapper.unmount()
  })
})
