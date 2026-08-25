import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openExternalUrl } from './externalLinks.js'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

describe('externalLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.__TAURI_INTERNALS__
  })

  it('uses the native opener inside Tauri', async () => {
    window.__TAURI_INTERNALS__ = {}
    await openExternalUrl('https://example.com/docs')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('rejects non-web schemes', async () => {
    await expect(openExternalUrl('javascript:alert(1)'))
      .rejects.toThrow("URL scheme 'javascript:' is not allowed.")
  })

  it('uses a separate browser tab during web development', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({})
    await openExternalUrl('http://localhost:4173/docs')
    expect(open).toHaveBeenCalledWith(
      'http://localhost:4173/docs',
      '_blank',
      'noopener,noreferrer',
    )
  })
})
