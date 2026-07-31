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
  let emitTrackerChange

  beforeEach(() => {
    vi.clearAllMocks()
    emitTrackerChange = null
    vi.mocked(listenToTrackerChanges).mockImplementation(async (callback) => {
      emitTrackerChange = callback
      return vi.fn()
    })
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

  it('paginates the complete day timeline instead of silently stopping at 500 blocks', async () => {
    const blocks = Array.from({ length: 500 }, (_, index) => ({
      ...loadIpcFixture('tracker_query').blocks[0],
      id: index + 1,
      startMs: index * 1_000,
      endMs: index * 1_000 + 500,
    }))
    vi.mocked(trackerQuery).mockImplementation(async (query) => {
      if (query.limit !== 500) return loadIpcFixture('tracker_query')
      if (query.offset === 0) return { blocks, total: 501, offset: 0, limit: 500 }
      return {
        blocks: [{ ...blocks[0], id: 501, startMs: 501_000, endMs: 501_500 }],
        total: 501,
        offset: 500,
        limit: 500,
      }
    })

    const wrapper = mountTracker()
    await flushPromises()

    expect(trackerQuery).toHaveBeenCalledWith(expect.objectContaining({ offset: 500, limit: 500 }))
    expect(trackerQuery).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('keeps the classifications surface mounted so edits survive tab switches', async () => {
    const wrapper = mountTracker()
    await flushPromises()
    const classifications = wrapper.get('[data-classifications]').element

    await wrapper.get('[data-tracker-tab="classifications"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-tracker-tab="day"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-classifications]').element).toBe(classifications)
    wrapper.unmount()
  })

  it('does not rebuild lifetime reports for every live sampling revision', async () => {
    const wrapper = mountTracker()
    await flushPromises()
    await wrapper.get('[data-tracker-tab="all"]').trigger('click')
    await flushPromises()
    vi.mocked(trackerReport).mockClear()
    vi.mocked(trackerQuery).mockClear()

    emitTrackerChange({ status: enabledStatus({ revision: 99 }) })
    await flushPromises()

    expect(trackerReport).not.toHaveBeenCalled()
    expect(trackerQuery).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('names queued unknown activity as classification work in progress', async () => {
    vi.mocked(trackerStatus).mockResolvedValue(enabledStatus({
      queuedClassifications: 1,
      current: {
        ...enabledStatus().current,
        activity: 'UNKNOWN',
        appName: 'Ghostty',
        domain: null,
      },
    }))
    const wrapper = mountTracker()
    await flushPromises()

    expect(wrapper.text()).toContain('Classifying · Ghostty')
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
