import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
import MoveActivityDialog from './MoveActivityDialog.vue'

const activity = { id: 'a', title: 'Fix the build', workspacePath: '/old', host: { type: 'pty' }, status: 'working' }
let wrapper
async function render(props = {}) {
  wrapper = mount(MoveActivityDialog, {
    attachTo: document.body,
    props: { activity, recentWorkspaces: [
      { name: 'Old', path: '/old' },
      { name: 'Next', path: '/next' },
      { name: 'Missing', path: '/missing', missing: true },
    ], ...props },
  })
  await flushPromises()
}
function button(text) { return [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text) }
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.clearAllMocks() })

describe('Move Activity dialog', () => {
  it('selects a recent workspace with the keyboard and requires an explicit stop-and-move action', async () => {
    await render()
    const selector = document.querySelector('[role=combobox]')
    expect(document.activeElement).toBe(selector)
    selector.click()
    await flushPromises()
    expect(document.querySelector('[data-graph-select-option="/old"]')).toBeNull()
    expect(document.querySelector('[data-graph-select-option="/missing"]').disabled).toBe(true)
    const search = document.querySelector('[data-graph-select-search]')
    search.value = 'Next'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('move')).toBeUndefined()
    expect(document.querySelector('form').textContent).toContain('/next')
    button('Stop and move').click()
    await flushPromises()
    expect(wrapper.emitted('move')).toEqual([['/next']])
  })

  it('uses the native folder picker and ignores its cancellation', async () => {
    await render({ activity: { ...activity, status: 'stopped' } })
    open.mockResolvedValueOnce(null).mockResolvedValueOnce('/picked')
    button('Choose folder…').click()
    await flushPromises()
    expect(button('Move and resume').disabled).toBe(true)
    button('Choose folder…').click()
    await flushPromises()
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Move to workspace' })
    button('Move and resume').click()
    await flushPromises()
    expect(wrapper.emitted('move')).toEqual([['/picked']])
  })

  it('rejects the current folder and shows a folder-picker failure', async () => {
    await render()
    open.mockResolvedValueOnce('/old/').mockRejectedValueOnce(new Error('Picker failed'))
    button('Choose folder…').click()
    await flushPromises()
    expect(document.querySelector('[role=alert]').textContent).toContain('different')
    expect(button('Stop and move').disabled).toBe(true)
    button('Choose folder…').click()
    await flushPromises()
    expect(document.querySelector('[role=alert]').textContent).toContain('Picker failed')
  })

  it('blocks dismissal while moving and retains a visible error on failure', async () => {
    await render({ busy: true })
    const form = document.querySelector('form')
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(button('Cancel').disabled).toBe(true)
    expect(document.querySelector('[role=status]').textContent).toContain('Moving')
    await wrapper.setProps({ busy: false, error: 'The session did not stop.' })
    expect(document.querySelector('[role=alert]').textContent).toContain('did not stop')
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
