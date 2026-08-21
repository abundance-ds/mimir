import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import WorkspaceSetupDialog from './WorkspaceSetupDialog.vue'

describe('WorkspaceSetupDialog', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('defaults an unknown workspace to no Project and Team storage', async () => {
    wrapper = mount(WorkspaceSetupDialog, {
      attachTo: document.body,
      props: {
        open: true,
        workspacePath: '/work/general',
        projects: [{ id: 'vandage', title: 'Vandage' }],
      },
    })
    await flushPromises()

    const projectSelect = document.querySelector('[data-workspace-project]')
    expect(projectSelect.textContent).toContain('None')
    expect(document.activeElement).toBe(projectSelect)
    expect(document.querySelector('[data-workspace-scope="team"]').getAttribute('aria-checked')).toBe('true')

    document.querySelector('[data-workspace-setup-continue]').click()
    expect(wrapper.emitted('save')[0][0]).toEqual({
      project: '',
      newProjectTitle: '',
      graphScope: 'team',
    })
  })

  it('creates a named Project and can select Workspace storage', async () => {
    wrapper = mount(WorkspaceSetupDialog, {
      attachTo: document.body,
      props: { open: true, workspacePath: '/work/new-client' },
    })
    await flushPromises()

    document.querySelector('[data-workspace-project]').click()
    await flushPromises()
    document.querySelector('[data-graph-select-option="__new_project__"]').click()
    await flushPromises()

    const input = document.querySelector('[data-workspace-new-project]')
    input.value = 'New client engagement'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    document.querySelector('[data-workspace-scope="workspace"]').click()
    await flushPromises()
    document.querySelector('[data-workspace-setup-continue]').click()
    await flushPromises()

    expect(wrapper.emitted('save')[0][0]).toEqual({
      project: '',
      newProjectTitle: 'New client engagement',
      graphScope: 'workspace',
    })
  })

  it('puts New Project below None and sorts existing Projects alphabetically', async () => {
    wrapper = mount(WorkspaceSetupDialog, {
      attachTo: document.body,
      props: {
        open: true,
        workspacePath: '/work/client',
        projects: [
          { id: 'zeta', title: 'Zeta' },
          { id: 'alpha', title: 'alpha' },
        ],
      },
    })
    await flushPromises()

    document.querySelector('[data-workspace-project]').click()
    await flushPromises()

    const options = [...document.querySelectorAll('[data-graph-select-option]')]
    expect(options.map(option => option.dataset.graphSelectOption)).toEqual([
      '',
      '__new_project__',
      'alpha',
      'zeta',
    ])
    const separator = document.querySelector('[data-graph-select-menu] [role="separator"]')
    expect(separator.previousElementSibling.dataset.graphSelectOption).toBe('__new_project__')
    expect(document.querySelectorAll('.graph-select-option-hint')).toHaveLength(0)
    const search = document.querySelector('[data-graph-select-search]')
    search.value = 'alp'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(search.value).toBe('alp')
    expect(document.querySelectorAll('[data-graph-select-option]')).toHaveLength(1)
    expect(document.querySelector('[data-graph-select-option]').dataset.graphSelectOption).toBe('alpha')
  })
})
