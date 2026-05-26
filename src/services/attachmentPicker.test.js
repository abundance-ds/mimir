import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickAndReadAttachment } from './attachmentPicker.js'

// The test setup already mocks @tauri-apps/plugin-dialog and @tauri-apps/api/core
const { open } = await import('@tauri-apps/plugin-dialog')
const { invoke } = await import('@tauri-apps/api/core')

describe('pickAndReadAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls open with image filters for type=image', async () => {
    open.mockResolvedValue(null)
    await pickAndReadAttachment('image')
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
  })

  it('calls open with broad file filters for type=file', async () => {
    open.mockResolvedValue(null)
    await pickAndReadAttachment('file')
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'Files', extensions: expect.arrayContaining(['pdf', 'md', 'txt', 'csv', 'json']) }],
    })
  })

  it('returns null when user cancels', async () => {
    open.mockResolvedValue(null)
    const result = await pickAndReadAttachment('image')
    expect(result).toBe(null)
  })

  it('reads file and returns attachment object', async () => {
    open.mockResolvedValue('/path/to/photo.png')
    invoke.mockResolvedValue('iVBORw0KGgo=') // small base64
    const result = await pickAndReadAttachment('image')
    expect(invoke).toHaveBeenCalledWith('read_binary_file', { path: '/path/to/photo.png' })
    expect(result).toEqual({
      filename: 'photo.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      size: expect.any(Number),
    })
  })

  it('extracts basename from path', async () => {
    open.mockResolvedValue('/Users/test/Documents/report.pdf')
    invoke.mockResolvedValue('JVBER')
    const result = await pickAndReadAttachment('pdf')
    expect(result.filename).toBe('report.pdf')
    expect(result.mediaType).toBe('application/pdf')
  })

  it('returns null on read_binary_file failure', async () => {
    open.mockResolvedValue('/path/to/photo.png')
    invoke.mockRejectedValue(new Error('file not found'))
    const result = await pickAndReadAttachment('image')
    expect(result).toBe(null)
  })

  it('returns error object for oversized files', async () => {
    open.mockResolvedValue('/path/to/huge.png')
    // Create a base64 string that represents >20MB (base64 is ~4/3 size)
    const bigBase64 = 'A'.repeat(28 * 1024 * 1024) // ~21MB when decoded
    invoke.mockResolvedValue(bigBase64)
    const result = await pickAndReadAttachment('image')
    expect(result).toEqual({ error: 'File exceeds 20MB limit' })
  })

  it('handles path object from dialog (not just string)', async () => {
    open.mockResolvedValue({ path: '/some/file.jpg', name: 'file.jpg' })
    invoke.mockResolvedValue('abc123')
    const result = await pickAndReadAttachment('image')
    expect(result.filename).toBe('file.jpg')
  })
})
