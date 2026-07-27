import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GraphConfirmDialog from './GraphConfirmDialog.vue'
import GraphCreateDialog from './GraphCreateDialog.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'

describe('Business Graph dialogs', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('keeps creation fast and reveals rich Markdown context progressively', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: {
        open: true,
        scopes: [
          { id: 'private:local', kind: 'private', root: '/private' },
          { id: 'project:atlas', kind: 'project', root: '/atlas' },
        ],
      },
    })
    await flushPromises()

    expect(document.querySelector('[data-create-body]')).toBeNull()
    document.querySelector('[data-graph-control="create-toggle-context"]').click()
    await flushPromises()
    expect(document.querySelector('[data-create-body] .cm-content')).not.toBeNull()
    expect(document.querySelector('select, datalist')).toBeNull()

    const title = document.querySelector('[data-create-title]')
    title.value = 'Prepare evidence map'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('## Acceptance\n\nDecision-ready map.')
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(wrapper.emitted('create')[0][0]).toEqual(expect.objectContaining({
      title: 'Prepare evidence map',
      scopeId: 'project:atlas',
      body: '## Acceptance\n\nDecision-ready map.',
    }))
  })

  it('replaces browser confirmation with a focused, recoverable graph action', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    wrapper = mount(GraphConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Move “Evidence extraction” to Trash?',
        copy: 'Its relationships leave the active graph until restored.',
      },
    })
    await flushPromises()

    const first = document.querySelector('[data-graph-control="confirm-close"]')
    const last = document.querySelector('[data-graph-control="confirm-submit"]')
    expect(document.activeElement).toBe(first)
    last.focus()
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)

    last.click()
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })
})
