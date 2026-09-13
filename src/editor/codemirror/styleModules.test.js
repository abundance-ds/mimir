import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { StyleModule } from 'style-mod'

const require = createRequire(import.meta.url)

describe.each([
  ['ESM', StyleModule],
  ['CommonJS', require('style-mod').StyleModule],
])('style-mod patch (%s)', (_format, Module) => {
  it('skips identical CSS writes but applies new rules, ordering, nonce, and reattachment', () => {
    const root = document.implementation.createHTMLDocument('Style module test')
    const first = new Module({ '.probe': { color: 'red' } })
    const second = new Module({ '.probe': { color: 'blue' } })
    Module.mount(root, [first])
    const sheet = root.head.querySelector('style')
    expect(sheet.textContent).toBe(`${first.getRules()}\n`)
    const observer = new MutationObserver(() => {})
    observer.observe(sheet, { childList: true, characterData: true, subtree: true })
    try {
      Module.mount(root, [first])
      expect(observer.takeRecords()).toHaveLength(0)

      Module.mount(root, [first, second])
      expect(observer.takeRecords().length).toBeGreaterThan(0)
      expect(sheet.textContent).toBe(`${first.getRules()}\n${second.getRules()}\n`)
      expect(sheet.sheet.cssRules).toHaveLength(2)

      Module.mount(root, [second, first])
      expect(observer.takeRecords().length).toBeGreaterThan(0)
      expect(sheet.textContent).toBe(`${second.getRules()}\n${first.getRules()}\n`)
      expect(sheet.sheet.cssRules).toHaveLength(2)

      sheet.remove()
      Module.mount(root, [second, first], { nonce: 'test-nonce' })
      expect(sheet.parentNode).toBe(root.head)
      expect(sheet.getAttribute('nonce')).toBe('test-nonce')
      expect(observer.takeRecords()).toHaveLength(0)
    } finally {
      observer.disconnect()
    }
  })
})
