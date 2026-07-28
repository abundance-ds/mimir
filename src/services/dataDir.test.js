import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  getDataDir,
  loadSettings,
  saveEditorSettings,
  saveSettings,
} from './dataDir.js'

describe('local data service', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retains the config-directory query for user-facing paths', async () => {
    invoke.mockResolvedValue('/home/me/.mimir')
    await expect(getDataDir()).resolves.toBe('/home/me/.mimir')
    expect(invoke).toHaveBeenCalledWith('ai_config_dir')
  })

  it('loads settings through native quarantine-aware persistence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      settings: { editor: { editorTheme: 'parchment' } },
      diagnostic: 'Invalid settings were moved aside.',
      quarantinedPath: '/home/me/.mimir/settings.json.corrupt-1',
    })

    await expect(loadSettings()).resolves.toEqual({
      editor: { editorTheme: 'parchment' },
    })
    expect(invoke).toHaveBeenCalledWith('settings_load')
    expect(warn).toHaveBeenCalledWith('[settings] Invalid settings were moved aside.')
  })

  it('saves one exact object through the atomic native writer', async () => {
    invoke.mockResolvedValue()
    const settings = { editor: { editorFontSize: 16 } }

    await saveSettings(settings)

    expect(invoke).toHaveBeenCalledWith('settings_save', { settings })
  })

  it('saves the editor section without a renderer load-mutate-save race', async () => {
    invoke.mockResolvedValue()
    const editor = { editorFontSize: 16 }

    await saveEditorSettings(editor)

    expect(invoke).toHaveBeenCalledWith('settings_save_editor', { editor })
  })
})
