import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ScribeMeetingContext from './ScribeMeetingContext.vue'

const scopes = [
  { id: 'project:work', kind: 'project' },
  { id: 'team:main', kind: 'team' },
]

describe('ScribeMeetingContext', () => {
  it('keeps blank, None, and an exact Project as distinct choices', async () => {
    const wrapper = mount(ScribeMeetingContext, {
      attachTo: document.body,
      props: {
        modelValue: {
          projectResolved: false,
          projectId: null,
          peopleIds: [],
          scopeId: 'team:main',
        },
        projects: [{ id: 'project-alpha', title: 'Project Alpha' }],
        scopes,
      },
    })

    await wrapper.get('[data-scribe-meeting-project]').trigger('click')
    const none = [...document.querySelectorAll('[data-graph-select-option]')]
      .find(option => option.textContent.includes('None'))
    none.click()
    expect(wrapper.emitted('change').at(-1)[0]).toMatchObject({
      projectResolved: true,
      projectId: null,
    })

    await wrapper.setProps({
      modelValue: {
        projectResolved: true,
        projectId: null,
        peopleIds: [],
        scopeId: 'team:main',
      },
    })
    await wrapper.get('[data-scribe-meeting-project]').trigger('click')
    const alpha = [...document.querySelectorAll('[data-graph-select-option]')]
      .find(option => option.textContent.includes('Project Alpha'))
    alpha.click()
    expect(wrapper.emitted('change').at(-1)[0]).toMatchObject({
      projectResolved: true,
      projectId: 'project-alpha',
    })
  })

  it('searches People and offers one direct create action for a missing name', async () => {
    const wrapper = mount(ScribeMeetingContext, {
      attachTo: document.body,
      props: {
        modelValue: {
          projectResolved: false,
          projectId: null,
          peopleIds: [],
          scopeId: 'team:main',
        },
        people: [{ id: 'person-ana', title: 'Ana Smith' }],
        scopes,
      },
    })

    await wrapper.get('[data-scribe-meeting-person]').trigger('click')
    const search = document.querySelector('[data-graph-select-search]')
    search.value = 'New Person'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    document.querySelector('[data-graph-select-create]').click()

    expect(wrapper.emitted('createEntity')).toEqual([[{
      kind: 'person',
      title: 'New Person',
    }]])
  })

  it('keeps several People and adds another without replacing them', async () => {
    const wrapper = mount(ScribeMeetingContext, {
      attachTo: document.body,
      props: {
        modelValue: {
          projectResolved: false,
          projectId: null,
          peopleIds: ['person-ana', 'person-paul'],
          scopeId: 'team:main',
        },
        people: [
          { id: 'person-ana', title: 'Ana Smith' },
          { id: 'person-paul', title: 'Paul Miller' },
          { id: 'person-chris', title: 'Chris Reed' },
        ],
        scopes,
      },
    })

    expect(wrapper.findAll('[data-scribe-meeting-person-value]').map(person => person.text()))
      .toEqual(['Ana Smith', 'Paul Miller'])
    await wrapper.get('[data-scribe-meeting-person]').trigger('click')
    const chris = [...document.querySelectorAll('[data-graph-select-option]')]
      .find(option => option.textContent.includes('Chris Reed'))
    chris.click()

    expect(wrapper.emitted('change').at(-1)[0].peopleIds)
      .toEqual(['person-ana', 'person-paul', 'person-chris'])
  })
})
