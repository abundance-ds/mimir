import { afterEach, expect, it } from 'vitest'
import { installTextInputPolicy, manualTextInputAttributes } from './textInputPolicy.js'

let stop
afterEach(() => { stop?.(); document.body.innerHTML = '' })
function expectManual(field) {
  for (const [name, value] of Object.entries(manualTextInputAttributes)) expect(field.getAttribute(name), name).toBe(value)
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

it('covers ordinary fields, native forms, contenteditable, and explicit autofill opt-ins', () => {
  document.body.innerHTML = '<form><input autocomplete="username"><textarea spellcheck="true"></textarea></form><div contenteditable="true"></div>'
  stop = installTextInputPolicy()
  for (const field of document.querySelectorAll('input, textarea, form, [contenteditable]')) expectManual(field)
})

it('protects dynamically created library fields before focus and restores changed attributes', async () => {
  stop = installTextInputPolicy()
  const field = document.createElement('textarea')
  field.autocorrect = 'off' // Boolean DOM properties must never be used for this policy.
  document.body.append(field)
  field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  expectManual(field)
  field.setAttribute('spellcheck', 'true')
  await settle()
  expectManual(field)
  const content = document.createElement('div')
  document.body.append(content)
  content.setAttribute('contenteditable', 'true')
  await settle()
  expectManual(content)
})
