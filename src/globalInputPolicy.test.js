import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

describe('global input policy', () => {
  it('disables macOS writing suggestions at the document root', () => {
    const parsed = new DOMParser().parseFromString(appHtml, 'text/html')

    expect(parsed.documentElement.getAttribute('writingsuggestions')).toBe('false')
  })
})
