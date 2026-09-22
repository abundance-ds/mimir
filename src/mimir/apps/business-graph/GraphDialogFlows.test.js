import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as graphService from '../../../services/businessGraph.js'
import { EditorView } from '@codemirror/view'
import { startCompletion, completionStatus } from '@codemirror/autocomplete'
import GraphConfirmDialog from './GraphConfirmDialog.vue'
import GraphCreateDialog from './GraphCreateDialog.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'

describe('Business Graph dialogs', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('creates a time sheet without a month, with a person and project', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: { open: true, initialKind: 'timesheet', initialProjectId: 'atlas', selfPersonId: 'alex',
        scopes: [{ id: 'team:main', kind: 'team' }],
        nodes: [{ id: 'atlas', kind: 'project', title: 'Atlas' }, { id: 'alex', kind: 'person', title: 'Alex' }],
      },
    })
    await flushPromises()
    const title = document.querySelector('[data-create-title]')
    title.value = 'Atlas 2026–2028'; title.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('[data-graph-control="create-time-period"]')).toBeNull()
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()
    expect(wrapper.emitted('create')[0][0]).toMatchObject({ kind: 'timesheet', title: 'Atlas 2026–2028',
      properties: { entries: [] },
      relations: [{ relation: 'part_of', target: 'atlas' }, { relation: 'assigned_to', target: 'alex' }],
    })
    expect(wrapper.emitted('create')[0][0].properties).not.toHaveProperty('period')
  })

  it.each(['title', 'description', 'project', 'date', 'link', 'options', 'body'])(
    'creates exactly once with Cmd+Return from %s', async target => {
      wrapper = mount(GraphCreateDialog, { attachTo: document.body,
        props: { open: true, scopes: [{ id: 'team:main', kind: 'team' }], projects: [{ id: 'atlas', title: 'Atlas' }] },
      })
      await flushPromises()
      const title = document.querySelector('[data-create-title]')
      title.value = 'Save this issue'
      title.dispatchEvent(new Event('input', { bubbles: true }))
      const editor = wrapper.findComponent(GraphMarkdownEditor)
      editor.vm.setValue('Keep this description unchanged.')
      await flushPromises()
      let element = title
      if (target === 'description') element = editor.get('.cm-content').element
      if (target === 'body') element = document.body
      if (target === 'project') {
        document.querySelector('[data-create-project]').click()
        await flushPromises()
        element = document.querySelector('[data-graph-select-search]')
      }
      if (target === 'date') {
        document.querySelector('[data-create-due]').click()
        await flushPromises()
        element = document.querySelector('[data-date-value]:not(:disabled)')
      }
      if (target === 'link' || target === 'options') {
        document.querySelector(target === 'link' ? '[data-graph-control="create-insert-link"]' : '[data-create-more]').click()
        await flushPromises()
        element = document.querySelector('[data-issue-popover] input')
      }
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
      expect(wrapper.emitted('create')).toHaveLength(1)
      expect(wrapper.emitted('create')[0][0]).toMatchObject({ title: 'Save this issue', body: 'Keep this description unchanged.' })
      await wrapper.setProps({ saving: true })
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
      expect(wrapper.emitted('create')).toHaveLength(1)
    },
  )

  it('closes an empty issue with Escape even when focus is on the body', async () => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body, props: { open: true } })
    await flushPromises()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(document.querySelector('[data-create-discard-confirmation]')).toBeNull()
  })

  it('asks before discarding entered text and keeps it when confirmation is cancelled', async () => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body, props: { open: true } })
    await flushPromises()
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    editor.vm.setValue('Unfinished evidence review')
    const content = editor.get('.cm-content').element
    content.focus()
    const view = EditorView.findFromDOM(editor.get('.cm-editor').element)
    startCompletion(view)
    expect(completionStatus(view.state)).toBe('pending')
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(document.activeElement).toBe(document.querySelector('[data-graph-control="create-keep-editing"]'))
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('[data-create-discard-confirmation]')).toBeNull()
    expect(editor.vm.getValue()).toBe('Unfinished evidence review')
    expect(document.activeElement).toBe(content)
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    document.querySelector('[data-graph-control="create-discard"]').click()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it.each(['project', 'due'])('closes the %s menu before the issue on Escape', async field => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body, props: { open: true } })
    await flushPromises()
    document.querySelector(`[data-create-${field}]`).click()
    await flushPromises()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('[data-graph-select-menu], [data-graph-date-popover]')).toBeNull()
    expect(wrapper.emitted('close')).toBeUndefined()
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
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
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    expect(editor.props('scopeIds')).toEqual(['team:main'])
    expect(editor.props('openLinks')).toBe(false)
    editor.get('.cm-content').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    editor.get('.cm-content').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('keeps issue context visible from the start', async () => {
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

    expect(document.querySelector('[data-graph-control="create-toggle-context"]')).toBeNull()
    expect(document.querySelector('[data-create-kind]')).toBeNull()
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
        initialKind: 'note',
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

  it('creates with the chosen project, owner, date, and visible Markdown context', async () => {
    wrapper = mount(GraphCreateDialog, {
      attachTo: document.body,
      props: { open: true, initialProjectId: 'atlas',
        scopes: [{ id: 'team:main', kind: 'team' }],
        projects: [{ id: 'atlas', title: 'Atlas' }, { id: 'beta', title: 'Beta' }],
        nodes: [{ id: 'anna', kind: 'person', title: 'Anna' }],
      },
    })
    await flushPromises()
    const title = document.querySelector('[data-create-title]')
    expect(document.activeElement).toBe(title)
    title.value = 'Check utility inputs'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('Compare with the source study.')
    document.querySelector('[data-create-project]').click()
    await flushPromises()
    const search = document.querySelector('[data-graph-select-search]')
    search.value = 'Beta'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('[data-create-project]'))
    document.querySelector('[data-create-owner]').click()
    await flushPromises()
    document.querySelector('[data-graph-select-option="anna"]').click()
    await flushPromises()
    document.querySelector('[data-create-due]').click()
    await flushPromises()
    const day = document.querySelector('[data-date-value]:not(:disabled)')
    const dueDate = day.getAttribute('data-date-value')
    day.click()
    await flushPromises()
    wrapper.findComponent(GraphMarkdownEditor).get('.cm-content').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.emitted('create')[0][0]).toMatchObject({
      title: 'Check utility inputs', body: 'Compare with the source study.',
      properties: { status: 'backlog', priority: 'normal', dueDate },
      relations: [{ relation: 'part_of', target: 'beta' }, { relation: 'assigned_to', target: 'anna' }],
    })
  })

  it('keeps an explicit No project selection when creating another issue', async () => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body,
      props: { open: true, initialProjectId: 'atlas', projects: [{ id: 'atlas', title: 'Atlas' }], scopes: [{ id: 'team:main', kind: 'team' }] },
    })
    await flushPromises()
    document.querySelector('[data-create-project]').click()
    await flushPromises()
    document.querySelector('[data-graph-select-option=""]').click()
    document.querySelector('[data-create-more]').click()
    await flushPromises()
    document.querySelector('[data-create-another]').click()
    const title = document.querySelector('[data-create-title]')
    title.value = 'Independent task'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.querySelector('[data-create-submit]').click()
    await flushPromises()
    const [value, controls] = wrapper.emitted('create')[0]
    expect(value.relations).toEqual([])
    expect(controls.another).toBe(true)
    controls.reset()
    await flushPromises()
    expect(document.querySelector('[data-create-project]').textContent).toContain('No project')
    expect(title.value).toBe('')
    expect(document.activeElement).toBe(title)
  })

  it('keeps the draft on a failed save and prevents dismissal while saving', async () => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body,
      props: { open: true, scopes: [{ id: 'team:main', kind: 'team' }] },
    })
    await flushPromises()
    const title = document.querySelector('[data-create-title]')
    title.value = 'Keep this draft'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.setProps({ saving: true })
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.setProps({ saving: false, error: 'Storage is unavailable' })
    expect(title.value).toBe('Keep this draft')
    expect(document.querySelector('[data-graph-create-error]').textContent).toContain('Storage is unavailable')
    document.querySelector('[data-graph-create-dialog]').click()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('opens link search without editing the description, and inserts only the selected entry', async () => {
    vi.spyOn(graphService, 'lookupGraph').mockResolvedValue([{ id: 'utility', kind: 'note', title: 'Utility extraction' }])
    wrapper = mount(GraphCreateDialog, { attachTo: document.body,
      props: { open: true, scopes: [{ id: 'team:main', kind: 'team' }], scopeIds: ['team:main'] },
    })
    await flushPromises()
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    editor.vm.setValue('Compare the source study.')
    const trigger = document.querySelector('[data-graph-control="create-insert-link"]')
    trigger.click()
    await flushPromises()
    expect(graphService.lookupGraph).toHaveBeenCalledWith('', { scopeIds: ['team:main'], limit: 12 })
    expect(editor.vm.getValue()).toBe('Compare the source study.')
    const search = document.querySelector('[data-graph-control="create-link-search"]')
    expect(document.activeElement).toBe(search)
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('[data-issue-popover]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(editor.vm.getValue()).toBe('Compare the source study.')
    trigger.click()
    await flushPromises()
    document.querySelector('[data-graph-control="create-link-result"]').click()
    await flushPromises()
    expect(editor.vm.getValue()).toContain('[Utility extraction](mimir://graph/utility)')
    expect(editor.vm.getValue()).not.toContain('@')
    expect(document.activeElement).toBe(editor.get('.cm-content').element)
  })

  it('keeps extra options outside the form layout and returns focus on Escape', async () => {
    wrapper = mount(GraphCreateDialog, { attachTo: document.body,
      props: { open: true, scopes: [{ id: 'team:main', kind: 'team' }] },
    })
    await flushPromises()
    const trigger = document.querySelector('[data-create-more]')
    trigger.click()
    await flushPromises()
    const menu = document.querySelector('[data-issue-popover]')
    expect(menu.closest('form')).toBeNull()
    expect(document.querySelector('.issue-composer .create-details')).toBeNull()
    const tags = menu.querySelector('[data-create-tags]')
    tags.value = 'heor'
    tags.dispatchEvent(new Event('input', { bubbles: true }))
    tags.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.activeElement).toBe(trigger)
    expect(wrapper.emitted('close')).toBeUndefined()
    trigger.click()
    await flushPromises()
    expect(document.querySelector('[data-create-tags]').value).toBe('heor')
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
