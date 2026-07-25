import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../stores/workbench.js'
import AppHeader from './AppHeader.vue'

describe('embedded editor header', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    return mount(AppHeader, {
      props: {
        embedded: true,
        hideSidebar: true,
        tabs: [],
      },
      global: { plugins: [pinia] },
    })
  }

  it('matches the 44px workbench header and owns left-rail restores', async () => {
    const wrapper = render()
    const workbench = useWorkbenchStore()
    expect(wrapper.classes()).toContain('h-11')

    workbench.setPaneState('sidebar', 'rail')
    workbench.setPaneState('activity', 'rail')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-editor-action="restore-sidebar"]').exists()).toBe(true)
    await wrapper.get('[data-editor-action="restore-activity"]').trigger('click')
    expect(workbench.paneLayout.activity.state).toBe('expanded')
  })
})
