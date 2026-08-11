import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateToast from './UpdateToast.vue'
import { UPDATE_PHASE, useAppUpdateStore } from '../../stores/appUpdate.js'

describe('UpdateToast', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offers the automatic update without taking focus or forcing restart', async () => {
    const updates = useAppUpdateStore()
    updates.currentVersion = '0.2.0'
    updates.updateVersion = '0.2.1'
    updates.phase = UPDATE_PHASE.AVAILABLE
    updates.toastVisible = true
    updates.installUpdate = vi.fn()
    mount(UpdateToast)

    expect(document.body.textContent).toContain('v0.2.1 is available')
    const action = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent.includes('Update'))
    action.click()
    await Promise.resolve()
    expect(updates.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('states that work is saved before restart', () => {
    const updates = useAppUpdateStore()
    updates.updateVersion = '0.2.1'
    updates.phase = UPDATE_PHASE.READY
    updates.toastVisible = true
    mount(UpdateToast)

    expect(document.body.textContent).toContain('Restart when you are ready')
    expect(document.body.textContent).toContain('save your work first')
  })
})
