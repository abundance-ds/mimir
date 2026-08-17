import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { openFileDialog, readBinaryFile } from './fileSystem.js'

describe('openFileDialog', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  it('starts the native chooser at the requested project path', async () => {
    open.mockResolvedValueOnce(null)

    await expect(openFileDialog('/work/current-project')).resolves.toBeNull()

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      multiple: false,
      defaultPath: '/work/current-project',
    }))
  })

  it('lets the native chooser select its folder when no project is active', async () => {
    open.mockResolvedValueOnce(null)

    await expect(openFileDialog()).resolves.toBeNull()

    expect(open).toHaveBeenCalledWith(expect.not.objectContaining({
      defaultPath: expect.anything(),
    }))
  })
})

describe('readBinaryFile', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  it('uses the raw IPC byte response without a base64 copy', async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([37, 80, 68, 70]).buffer)

    await expect(readBinaryFile('/w/report.pdf')).resolves.toEqual(
      new Uint8Array([37, 80, 68, 70]),
    )
    expect(invoke).toHaveBeenCalledWith('read_binary_file', { path: '/w/report.pdf' })
  })

  it('accepts legacy base64 responses during upgrades', async () => {
    invoke.mockResolvedValueOnce('JVBERg==')

    await expect(readBinaryFile('/w/report.pdf')).resolves.toEqual(
      new Uint8Array([37, 80, 68, 70]),
    )
  })
})
