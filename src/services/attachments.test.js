import { describe, it, expect } from 'vitest'
import {
  mediaTypeFromFilename,
  isImageType,
  isPdfType,
  toDataUrl,
  toFileUIParts,
  validateFileSize,
  isAttachmentPlaceholder,
} from './attachments.js'

describe('mediaTypeFromFilename', () => {
  it('returns image/png for .png', () => {
    expect(mediaTypeFromFilename('photo.png')).toBe('image/png')
  })

  it('returns image/jpeg for .jpg and .jpeg (case insensitive)', () => {
    expect(mediaTypeFromFilename('photo.jpg')).toBe('image/jpeg')
    expect(mediaTypeFromFilename('photo.JPEG')).toBe('image/jpeg')
  })

  it('returns image/gif for .gif', () => {
    expect(mediaTypeFromFilename('animation.gif')).toBe('image/gif')
  })

  it('returns image/webp for .webp', () => {
    expect(mediaTypeFromFilename('photo.webp')).toBe('image/webp')
  })

  it('returns application/pdf for .pdf', () => {
    expect(mediaTypeFromFilename('document.pdf')).toBe('application/pdf')
  })

  it('returns null for unsupported extension', () => {
    expect(mediaTypeFromFilename('file.docx')).toBe(null)
    expect(mediaTypeFromFilename('file.exe')).toBe(null)
  })

  it('returns text types for supported text extensions', () => {
    expect(mediaTypeFromFilename('file.txt')).toBe('text/plain')
    expect(mediaTypeFromFilename('notes.md')).toBe('text/markdown')
    expect(mediaTypeFromFilename('data.csv')).toBe('text/csv')
    expect(mediaTypeFromFilename('config.json')).toBe('application/json')
    expect(mediaTypeFromFilename('config.yaml')).toBe('text/yaml')
    expect(mediaTypeFromFilename('config.yml')).toBe('text/yaml')
    expect(mediaTypeFromFilename('data.xml')).toBe('text/xml')
  })

  it('returns null for no extension', () => {
    expect(mediaTypeFromFilename('noext')).toBe(null)
    expect(mediaTypeFromFilename('')).toBe(null)
  })
})

describe('isImageType', () => {
  it('returns true for image/* media types', () => {
    expect(isImageType('image/png')).toBe(true)
    expect(isImageType('image/jpeg')).toBe(true)
    expect(isImageType('image/gif')).toBe(true)
    expect(isImageType('image/webp')).toBe(true)
  })

  it('returns false for non-image types', () => {
    expect(isImageType('application/pdf')).toBe(false)
    expect(isImageType(null)).toBe(false)
    expect(isImageType(undefined)).toBe(false)
    expect(isImageType('')).toBe(false)
  })
})

describe('isPdfType', () => {
  it('returns true for application/pdf', () => {
    expect(isPdfType('application/pdf')).toBe(true)
  })

  it('returns false for other types', () => {
    expect(isPdfType('image/png')).toBe(false)
    expect(isPdfType(null)).toBe(false)
  })
})

describe('toDataUrl', () => {
  it('builds data URL from mediaType and base64', () => {
    expect(toDataUrl('image/png', 'abc123')).toBe('data:image/png;base64,abc123')
  })

  it('handles application/pdf', () => {
    expect(toDataUrl('application/pdf', 'JVBER')).toBe('data:application/pdf;base64,JVBER')
  })
})

describe('toFileUIParts', () => {
  it('converts attachments array to FileUIPart format', () => {
    const attachments = [
      { filename: 'photo.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc' },
      { filename: 'doc.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,xyz' },
    ]
    const result = toFileUIParts(attachments)
    expect(result).toEqual([
      { type: 'file', mediaType: 'image/png', filename: 'photo.png', url: 'data:image/png;base64,abc' },
      { type: 'file', mediaType: 'application/pdf', filename: 'doc.pdf', url: 'data:application/pdf;base64,xyz' },
    ])
  })

  it('returns empty array for empty input', () => {
    expect(toFileUIParts([])).toEqual([])
    expect(toFileUIParts(undefined)).toEqual([])
    expect(toFileUIParts(null)).toEqual([])
  })
})

describe('validateFileSize', () => {
  it('returns true for size under 20MB', () => {
    expect(validateFileSize(1024)).toBe(true)
    expect(validateFileSize(10 * 1024 * 1024)).toBe(true)
  })

  it('returns true for size exactly at 20MB', () => {
    expect(validateFileSize(20 * 1024 * 1024)).toBe(true)
  })

  it('returns false for size over 20MB', () => {
    expect(validateFileSize(20 * 1024 * 1024 + 1)).toBe(false)
    expect(validateFileSize(100 * 1024 * 1024)).toBe(false)
  })
})

describe('isAttachmentPlaceholder', () => {
  it('returns true for placeholder objects', () => {
    expect(isAttachmentPlaceholder({ _attachmentPlaceholder: true, filename: 'a.png', mediaType: 'image/png' })).toBe(true)
  })

  it('returns false for regular FileUIPart', () => {
    expect(isAttachmentPlaceholder({ type: 'file', mediaType: 'image/png', url: 'data:...' })).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isAttachmentPlaceholder(null)).toBe(false)
    expect(isAttachmentPlaceholder(undefined)).toBe(false)
  })
})

