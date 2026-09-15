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

  it('creates a time sheet with a month, person, and project', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: { open: true, initialKind: 'timesheet', initialProjectId: 'atlas', selfPersonId: 'alex',
        scopes: [{ id: 'team:main', kind: 'team' }],
        nodes: [{ id: 'atlas', kind: 'project', title: 'Atlas' }, { id: 'alex', kind: 'person', title: 'Alex' }],
      },
    })
    await flushPromises()
    const title = document.querySelector('[data-create-title]')
    title.value = 'Atlas September'; title.dispatchEvent(new Event('input', { bubbles: true }))
    const period = document.querySelector('[data-graph-control="create-time-period"]')
    period.value = '2026-09'; period.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()
    expect(wrapper.emitted('create')[0][0]).toMatchObject({ kind: 'timesheet', title: 'Atlas September',
      properties: { period: '2026-09', entries: [] },
      relations: [{ relation: 'part_of', target: 'atlas' }, { relation: 'assigned_to', target: 'alex' }],
    })
  })

  it('keeps Create link lookup within the active scopes and does not close during IME input', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: {
        open: true,
        scopes: [{ id: 'team:main', kind: 'team' }, { id: 'private:local', kind: 'private' }],
        scopeIds: ['team:main'],
      },
    })
    await flushPromises()
    document.querySelector('[data-graph-control="create-toggle-context"]').click()
    await flushPromises()
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    expect(editor.props('scopeIds')).toEqual(['team:main'])
    expect(editor.props('openLinks')).toBe(false)
    editor.get('.cm-content').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    editor.get('.cm-content').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
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

  it('routes shared business entities to Team by default', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: {
        open: true,
        scopes: [
          { id: 'private:local', kind: 'private', root: '/private' },
          { id: 'project:atlas', kind: 'project', root: '/atlas' },
          { id: 'team:main', kind: 'team', root: '/team' },
        ],
      },
    })
    await flushPromises()

    expect(document.querySelector('[data-create-scope]').textContent).toContain('Team')
    document.querySelector('[data-create-kind]').click()
    await flushPromises()
    document.querySelector('[data-graph-select-option="company"]').click()
    await flushPromises()
    expect(document.querySelector('[data-create-scope]').textContent).toContain('Team')

    const title = document.querySelector('[data-create-title]')
    title.value = 'Example client'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(wrapper.emitted('create')[0][0]).toEqual(expect.objectContaining({
      kind: 'company',
      scopeId: 'team:main',
      title: 'Example client',
    }))
  })

  it('creates a Project with lean business and context properties', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: {
        open: true,
        initialKind: 'project',
        scopes: [
          { id: 'private:local', kind: 'private', root: '/private' },
          { id: 'team:main', kind: 'team', root: '/team' },
        ],
      },
    })
    await flushPromises()

    const title = document.querySelector('[data-create-title]')
    title.value = 'New engagement'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(wrapper.emitted('create')[0][0]).toEqual(expect.objectContaining({
      kind: 'project',
      scopeId: 'team:main',
      properties: {
        projectStatus: 'planned',
      },
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
