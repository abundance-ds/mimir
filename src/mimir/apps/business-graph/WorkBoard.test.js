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

  it('puts missing, legacy, and unresolved projects in one No project column', async () => {
    const orphanIssues = [
      { id: 'missing', kind: 'issue', title: 'Unassigned task' },
      { id: 'legacy', kind: 'issue', title: 'Old task', projectId: 'FDE' },
      { id: 'deleted', kind: 'issue', title: 'Orphan task', projectId: 'deleted-project' },
    ]
    const allIssues = [issues[0], ...orphanIssues]
    const wrapper = render({ issues: allIssues, unfilteredIssues: allIssues, groupBy: 'project' })
    expect(wrapper.findAll('[data-board-column]').map(column => column.attributes('data-board-column')))
      .toEqual(['project-x', '__unassigned__'])
    const noProject = wrapper.get('[data-board-column="__unassigned__"]')
    expect(noProject.get('.board-column-name').text()).toBe('No project')
    expect(noProject.findAll('[data-board-card]').map(card => card.attributes('data-board-card')))
      .toEqual(['missing', 'legacy', 'deleted'])
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(allIssues.length)

    await wrapper.get('[data-board-card="legacy"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('move')[0][0]).toEqual({ issue: orphanIssues[1], projectId: 'project-x' })
    expect(orphanIssues[1].projectId).toBe('FDE')

    await wrapper.setProps({ issues: [issues[0]], searchQuery: 'evidence' })
    expect(wrapper.get('[data-board-column="__unassigned__"]').element).toBe(noProject.element)
    expect(noProject.get('.board-column-count').text()).toBe('0')
    wrapper.unmount()
  })

  it('omits No project when all tasks have a matching project', () => {
    const wrapper = render({ issues: [issues[0]], groupBy: 'project' })
    expect(wrapper.find('[data-board-column="__unassigned__"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-board-card]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('hides empty projects, keeps search columns stable, and reveals empty drop targets on request', async () => {
    const idle = { id: 'idle', kind: 'project', title: 'Idle project' }
    const wrapper = render({ issues: [issues[0]], unfilteredIssues: [issues[0]], projects: [project, idle], groupBy: 'project' })
    expect(wrapper.find('[data-board-column="idle"]').exists()).toBe(false)
    const column = wrapper.get('[data-board-column="project-x"]').element
    await wrapper.setProps({ issues: [], searchQuery: 'absent' })
    expect(wrapper.get('[data-board-column="project-x"]').element).toBe(column)
    expect(wrapper.get('.board-no-matches').text()).toBe('No matches')
    await wrapper.setProps({ showEmptyProjects: true })
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(2)
    expect(wrapper.find('[data-board-column="__unassigned__"]').exists()).toBe(false)
    await wrapper.setProps({ issues: [], unfilteredIssues: [], searchQuery: '' })
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(2)
    expect(wrapper.get('[data-board-column="idle"] .board-column-count').text()).toBe('0')
    await wrapper.setProps({ showEmptyProjects: false })
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(0)
    expect(wrapper.find('[data-graph-control="board-empty-create"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('does not hide status drop targets with the empty-project setting', async () => {
    const wrapper = render()
    const columns = wrapper.findAll('[data-board-column]').map(el => el.element)
    expect(wrapper.get('[data-board-column="done"]').findAll('[data-board-card]')).toHaveLength(0)
    await wrapper.setProps({ showEmptyProjects: true })
    expect(wrapper.findAll('[data-board-column]').map(el => el.element)).toEqual(columns)
    wrapper.unmount()
  })

  it('keeps a task without a status in Backlog', () => {
    const wrapper = render({ issues: [{ id: 'missing-status', kind: 'issue', title: 'New task' }] })
    expect(wrapper.get('[data-board-column="backlog"] [data-board-card]').attributes('data-board-card'))
      .toBe('missing-status')
    wrapper.unmount()
  })

  it('shows initials for everyone when no reader is configured', () => {
    const wrapper = render({ selfId: '' })
    expect(wrapper.get('[data-board-card="i1"] .board-row-owner').text()).toBe('PP')
    expect(wrapper.find('.board-row-owner-self').exists()).toBe(false)
  })

  it('does not run card actions from nested property controls', async () => {
    const wrapper = render()
    await wrapper.get('[data-card-priority="i1"]').trigger('keydown', { key: 'ArrowRight' })
    await wrapper.get('[data-card-due="i1"]').trigger('keydown', { key: 'p' })
    expect(wrapper.emitted('move')).toBeUndefined()
    expect(wrapper.emitted('patch')).toBeUndefined()
    wrapper.unmount()
  })

  it('drops hidden cards from selection before a bulk change', async () => {
    const wrapper = render()
    await wrapper.get('[data-board-card="i1"]').trigger('click', { metaKey: true })
    await wrapper.get('[data-board-card="i2"]').trigger('click', { metaKey: true })
    await wrapper.setProps({ issues: [issues[0]] })
    await wrapper.setProps({ issues })
    await wrapper.get('[data-board-card="i1"]').trigger('keydown', { key: 'p' })
    expect(wrapper.emitted('bulk-patch')).toBeUndefined()
    expect(wrapper.emitted('patch')[0][0].issue.id).toBe('i1')
    wrapper.unmount()
  })
})
