import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  importArgus,
  setTrackerEnabled,
  trackerQuery,
  trackerReport,
  updateTrackerClassification,
  updateTrackerConfig,
} from './tracker.js'

describe('tracker service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue({})
  })

  it('keeps every native command behind an explicit Tracker namespace', async () => {
    await setTrackerEnabled(true)
    await updateTrackerConfig({ enabled: true })
    await trackerReport({ startMs: 1, endMs: 2, timezone: 'Europe/Berlin' })
    await trackerQuery({ startMs: 1, endMs: 2 })
    await updateTrackerClassification({
      key: 'Safari | example.com',
      activity: 'Work',
      subcategory: 'Research',
      applyHistory: true,
    })
    await importArgus({ timezone: 'Europe/Berlin' })

    expect(invoke.mock.calls).toEqual([
      ['tracker_set_enabled', { enabled: true }],
      ['tracker_config_update', { config: { enabled: true } }],
      ['tracker_report', { startMs: 1, endMs: 2, timezone: 'Europe/Berlin' }],
      ['tracker_query', { query: { startMs: 1, endMs: 2 } }],
      ['tracker_classification_update', {
        update: {
          key: 'Safari | example.com',
          activity: 'Work',
          subcategory: 'Research',
          applyHistory: true,
        },
      }],
      ['tracker_import_argus', {
        request: { sourceDirectory: null, timezone: 'Europe/Berlin' },
      }],
    ])
  })
})
