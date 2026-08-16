import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SettingsDialog from './SettingsDialog.vue'

const AppsSettingsStub = defineComponent({
  emits: ['launchApp', 'openDefinition'],
  setup(_, { expose }) {
    const input = ref(null)
    expose({ focusInitial: () => input.value?.focus() })
    return { input }
  },
  template: `
    <div>
      <input ref="input" data-apps-search-stub>
      <button data-apps-settings @click="$emit('launchApp', { activity: { id: 'app:ledger' } })">Apps</button>
      <button data-app-definition @click="$emit('openDefinition', '/apps/ledger/app.toml')">Definition</button>
    </div>
  `,
})

describe('SettingsDialog Apps ownership', () => {
  function render(initialSection = 'appearance', attachTo = null) {
    return mount(SettingsDialog, {
      props: { open: true, initialSection },
      attachTo,
      global: {
        stubs: {
          Teleport: true,
          Transition: false,
          AppearanceSection: true,
          EditorSection: true,
          AISection: true,
          ConnectionsSettingsSection: true,
          TrackerSettingsPanel: {
            template: '<div data-tracker-settings-stub>Tracker controls</div>',
          },
          LaunchersSection: true,
          AppsSettingsSection: AppsSettingsStub,
          ShortcutsSection: true,
          AboutSection: true,
        },
      },
    })
  }

  it('owns Apps as a first-class Settings section rather than a shell row', async () => {
    const wrapper = render()

    await wrapper.get('[data-settings-section="apps"]').trigger('click')

    expect(wrapper.get('[data-apps-settings]').exists()).toBe(true)
    await wrapper.get('[data-apps-settings]').trigger('click')
    expect(wrapper.emitted('launchApp')).toEqual([[{ activity: { id: 'app:ledger' } }]])
    await wrapper.get('[data-app-definition]').trigger('click')
    expect(wrapper.emitted('openDefinition')).toEqual([['/apps/ledger/app.toml']])
  })

  it('accepts an Apps deep link and puts keyboard focus in its catalog', async () => {
    const wrapper = render('apps', document.body)
    await flushPromises()

    expect(wrapper.get('[data-apps-settings]').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-apps-search-stub]').element)
    wrapper.unmount()
  })

  it('owns Tracker as a direct Settings section', async () => {
    const wrapper = render('tracker')
    await flushPromises()

    expect(wrapper.get('[data-settings-section="tracker"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-tracker-settings-stub]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('moves through section navigation with arrows and keeps focus inside the modal', async () => {
    const wrapper = render('appearance', document.body)
    await flushPromises()
    const appearance = wrapper.get('[data-settings-section="appearance"]')
    expect(document.activeElement).toBe(appearance.element)

    await appearance.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(wrapper.get('[data-settings-section="editor"]').element)
    expect(wrapper.get('[data-settings-section="editor"]').attributes('aria-current')).toBe('page')

    const close = wrapper.get('[aria-label="Close settings"]')
    close.element.focus()
    await close.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('[data-settings-section="appearance"]').element)
    wrapper.unmount()
  })

  it('restores the invoker after closing', async () => {
    const invoker = document.createElement('button')
    document.body.append(invoker)
    invoker.focus()
    const wrapper = render('appearance', document.body)
    await flushPromises()

    await wrapper.setProps({ open: false })
    await flushPromises()

    expect(document.activeElement).toBe(invoker)
    wrapper.unmount()
    invoker.remove()
  })
})
