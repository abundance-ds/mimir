import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { openFileDialog, openHtmlInBrowser, readBinaryFile } from './fileSystem.js'

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
  it.each(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'])('opens %s outside the workspace without a UTF-8 read', async extension => {
    open.mockResolvedValueOnce(`/outside/photo.${extension}`)
    invoke.mockRejectedValueOnce(new Error('Outside workspace'))
    const result = await openFileDialog()
    expect(result).toMatchObject({ path: `/outside/photo.${extension}`, content: '', kind: extension === 'pdf' ? 'pdf' : 'external' })
    expect(invoke).not.toHaveBeenCalledWith('read_text_file', expect.anything())
  })

  it('keeps SVG source available for editing', async () => {
    open.mockResolvedValueOnce('/outside/logo.svg')
    invoke.mockRejectedValueOnce(new Error('Outside workspace'))
    invoke.mockResolvedValueOnce({ path: '/outside/logo.svg', content: '<svg/>' })
    expect(await openFileDialog()).toMatchObject({ kind: 'text', content: '<svg/>' })
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

  it('passes the image byte limit to the native reader', async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([1]).buffer)
    await readBinaryFile('/w/photo.png', { maxBytes: 64 * 1024 * 1024 })
    expect(invoke).toHaveBeenCalledWith('read_binary_file', { path: '/w/photo.png', maxBytes: 64 * 1024 * 1024 })
  })

  it('accepts legacy base64 responses during upgrades', async () => {
    invoke.mockResolvedValueOnce('JVBERg==')

    await expect(readBinaryFile('/w/report.pdf')).resolves.toEqual(
      new Uint8Array([37, 80, 68, 70]),
    )
  })
})

describe('openHtmlInBrowser', () => {
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

  it('uses the HTML-only native command', async () => {
    await openHtmlInBrowser('/w/index.html')

    expect(invoke).toHaveBeenCalledWith('open_html_in_browser', {
      path: '/w/index.html',
    })
  })
})
