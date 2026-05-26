import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Tauri plugins
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}))

import { checkForUpdate } from './appUpdater.js'
import { check } from '@tauri-apps/plugin-updater'

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when no update available', async () => {
    check.mockResolvedValue(null)
    const result = await checkForUpdate()
    expect(result).toBeNull()
  })

  it('returns update info when available', async () => {
    check.mockResolvedValue({
      available: true,
      version: '0.0.2',
      body: 'Bug fixes',
      date: '2025-05-20',
      downloadAndInstall: vi.fn(),
    })
    const result = await checkForUpdate()
    expect(result.version).toBe('0.0.2')
    expect(typeof result.download).toBe('function')
  })

  it('returns null on error', async () => {
    check.mockRejectedValue(new Error('Network error'))
    const result = await checkForUpdate()
    expect(result).toBeNull()
  })
})
