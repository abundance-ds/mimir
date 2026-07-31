import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TrackerSettingsPanel from './TrackerSettingsPanel.vue'

const tracker = {
  enabled: true,
  armed: true,
  loading: false,
  error: '',
  mode: 'armed',
  status: {
    mode: 'armed',
    diagnostic: null,
    autostartDiagnostic: null,
    launchAtLoginActive: true,
    permissions: {
      accessibilityRequired: true,
      accessibility: true,
      notifications: 'granted',
    },
    config: {
      launchAtLogin: true,
      collectWindowTitles: true,
      collectBrowserDomains: false,
      classificationEnabled: true,
      includeWindowTitlesInAi: false,
      nudgesEnabled: true,
      timezone: 'Europe/Berlin',
      nudgeGraceMinutes: 5,
      dailyCostCapUsd: 1,
    },
  },
  initialize: vi.fn().mockResolvedValue(),
  setEnabled: vi.fn().mockResolvedValue(),
  setArmed: vi.fn().mockResolvedValue(),
  requestAccessibility: vi.fn().mockResolvedValue(),
  updateConfig: vi.fn().mockResolvedValue(),
  previewImport: vi.fn().mockResolvedValue(null),
  importArgus: vi.fn().mockResolvedValue(null),
  refresh: vi.fn().mockResolvedValue(),
}

vi.mock('../../../stores/tracker.js', () => ({
  useTrackerStore: () => tracker,
}))

describe('TrackerSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses Mimir switches and presents the system timezone without developer input', () => {
    const wrapper = mount(TrackerSettingsPanel)

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.findAll('[role="switch"]').length).toBeGreaterThan(1)
    expect(wrapper.get('[data-tracker-timezone]').text()).toContain('Europe/Berlin')
    expect(wrapper.get('[data-tracker-timezone]').find('input').exists()).toBe(false)
    wrapper.unmount()
  })

  it('restores a cleared numeric setting instead of coercing it to zero', async () => {
    const wrapper = mount(TrackerSettingsPanel)
    const grace = wrapper.get('[data-tracker-grace]')
    grace.element.value = ''
    await grace.trigger('change')

    expect(tracker.updateConfig).not.toHaveBeenCalled()
    expect(grace.element.value).toBe('5')
    wrapper.unmount()
  })
})
