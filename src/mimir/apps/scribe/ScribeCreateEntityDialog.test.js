import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ScribeCreateEntityDialog from './ScribeCreateEntityDialog.vue'

const scopes = [{ id: 'private', kind: 'private' }, { id: 'team', kind: 'team' }]

function openDialog() {
  return mount(ScribeCreateEntityDialog, {
    attachTo: document.body,
    props: { request: { kind: 'person', title: 'Maya', scopeId: 'private' }, scopes },
  })
}

it('uses the requested scope and submits a changed location', async () => {
  const wrapper = openDialog()
  await flushPromises()
  const dialog = new DOMWrapper(document.querySelector('[data-scribe-create-dialog]'))
  expect(dialog.text()).toContain('Private')
  await dialog.get('[role="combobox"]').trigger('click')
  await new DOMWrapper(document.querySelector('[data-graph-select-option="team"]')).trigger('click')
  await dialog.get('form').trigger('submit')
  expect(wrapper.emitted('submit')).toEqual([[{ kind: 'person', title: 'Maya', scopeId: 'team' }]])
  wrapper.unmount()
})

it('keeps focus in the dialog and restores the initiating control on close', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const wrapper = openDialog()
  await flushPromises()
  const dialog = new DOMWrapper(document.querySelector('[data-scribe-create-dialog]'))
  expect(document.activeElement).toBe(dialog.get('input').element)
  await dialog.get('input').trigger('keydown', { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(dialog.get('button[type="submit"]').element)
  await dialog.get('button[type="submit"]').trigger('keydown', { key: 'Tab' })
  expect(document.activeElement).toBe(dialog.get('input').element)
  await dialog.get('form').trigger('keydown', { key: 'Escape' })
  expect(wrapper.emitted('close')).toHaveLength(1)
  expect(wrapper.emitted('submit')).toBeUndefined()
  await wrapper.setProps({ request: null })
  await flushPromises()
  expect(document.activeElement).toBe(trigger)
  wrapper.unmount()
  trigger.remove()
})

it('requires a valid name and scope and prevents repeated submission while saving', async () => {
  const wrapper = openDialog()
  await flushPromises()
  const dialog = new DOMWrapper(document.querySelector('[data-scribe-create-dialog]'))
  await dialog.get('input').setValue('  ')
  expect(dialog.get('button[type="submit"]').element.disabled).toBe(true)
  await dialog.get('form').trigger('submit')
  expect(wrapper.emitted('submit')).toBeUndefined()
  await dialog.get('input').setValue('Maya')
  await wrapper.setProps({ scopes: [] })
  expect(dialog.get('button[type="submit"]').element.disabled).toBe(true)
  await wrapper.setProps({ scopes, busy: true })
  await dialog.get('form').trigger('submit')
  await dialog.get('form').trigger('keydown', { key: 'Escape' })
  expect(wrapper.emitted('submit')).toBeUndefined()
  expect(wrapper.emitted('close')).toBeUndefined()
  wrapper.unmount()
})
