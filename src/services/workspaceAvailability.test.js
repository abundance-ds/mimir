import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspacePathStatuses } from './workspaceAvailability.js'

describe('workspace availability service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('checks unique paths in one native request', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { path: '/work/one', available: true },
      { path: '/work/gone', available: false },
    ])

    await expect(workspacePathStatuses([
      '/work/one',
      '/work/one',
      '',
      '/work/gone',
    ])).resolves.toEqual([
      { path: '/work/one', available: true },
      { path: '/work/gone', available: false },
    ])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('workspace_paths_status', {
      paths: ['/work/one', '/work/gone'],
    })
  })
})
