import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkBoard from './WorkBoard.vue'

function isoOffset(days) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

describe('WorkBoard rows', () => {
  const project = { id: 'project-x', kind: 'project', title: 'Project X' }
  const anna = { id: 'person-anna', kind: 'person', title: 'Anna Berg' }
  const me = { id: 'person-me', kind: 'person', title: 'Paul Priorb' }
  const issues = [
    {
      id: 'i1',
      kind: 'issue',
      title: 'Extract evidence table',
      status: 'plan',
      priority: 'urgent',
      projectId: 'project-x',
      assigneeId: 'person-me',
      dueDate: isoOffset(-2),
    },
    {
      id: 'i2',
      kind: 'issue',
      title: 'Client sign-off on protocol',
      status: 'waiting',
      priority: 'normal',
      projectId: 'project-x',
      assigneeId: 'person-anna',
      waitingFor: 'Client sign-off',
      dueDate: isoOffset(3),
    },
    { id: 'i3', kind: 'issue', title: 'Loose end', status: 'backlog' },
  ]

  function render(props = {}) {
    return mount(WorkBoard, {
      props: {
        issues,
        nodes: [project, anna, me, ...issues],
        projects: [project],
        selfId: 'person-me',
        ...props,
      },
    })
  }

  it('spells every row in the shared grammar', () => {
    const wrapper = render()
    const first = wrapper.get('[data-board-card="i1"]')
    expect(first.get('.board-row-title').text()).toBe('Extract evidence table')
    expect(first.get('.meta-project').text()).toBe('Project X')
    expect(first.get('[data-card-due="i1"]').text()).toBe('2d overdue')
    expect(first.get('[data-card-due="i1"]').classes()).toContain('due-overdue')
    expect(first.get('.board-row-owner').text()).toBe('you')
    expect(first.get('.board-row-owner').classes()).toContain('board-row-owner-self')
    expect(first.attributes('aria-label')).toContain('2d overdue')
    expect(first.attributes('aria-label')).toContain('assigned to you')
    expect(first.find('[data-card-priority="i1"] .graph-select-chevron').exists()).toBe(false)

    const second = wrapper.get('[data-board-card="i2"]')
    expect(second.get('.meta-waiting').text()).toBe('waiting for Client sign-off')
    expect(second.get('[data-card-due="i2"]').text()).toBe('due 3d')
    expect(second.get('.board-row-owner').text()).toBe('AB')
    expect(second.get('.board-row-owner').attributes('title')).toBe('Assigned to Anna Berg')

    const third = wrapper.get('[data-board-card="i3"]')
    expect(third.find('.meta-project').exists()).toBe(false)
    expect(third.find('.board-row-owner').exists()).toBe(false)
    expect(third.get('[data-card-due="i3"]').text()).toBe('')
    expect(third.get('[data-card-due="i3"]').find('svg').exists()).toBe(true)
    expect(third.get('[data-card-due="i3"]').attributes('aria-label')).toContain('No date set')
    expect(wrapper.text()).not.toContain('set date')
  })

  it('omits the project slot when one project scopes the board', () => {
    const wrapper = render({ hideProject: true })
    expect(wrapper.find('.meta-project').exists()).toBe(false)
    expect(wrapper.get('[data-board-card="i1"] .board-row-owner').text()).toBe('you')
  })

  it('shows initials for everyone when no reader is configured', () => {
    const wrapper = render({ selfId: '' })
    expect(wrapper.get('[data-board-card="i1"] .board-row-owner').text()).toBe('PP')
    expect(wrapper.find('.board-row-owner-self').exists()).toBe(false)
  })
})
