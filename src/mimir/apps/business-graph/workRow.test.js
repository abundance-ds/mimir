import { describe, expect, it } from 'vitest'
import {
  assigneeDisplay,
  dueInfo,
  groupWorkRows,
  initials,
  waitingReason,
} from './workRow.js'

const now = new Date('2026-09-04T10:30:00')

describe('work row grammar', () => {
  it('spells due dates relative to today', () => {
    expect(dueInfo('', now)).toEqual({ state: 'none', days: null, label: '' })
    expect(dueInfo('not a date', now).state).toBe('none')
    expect(dueInfo('2026-09-01', now)).toEqual({ state: 'overdue', days: -3, label: '3d overdue' })
    expect(dueInfo('2026-09-04', now)).toEqual({ state: 'today', days: 0, label: 'due today' })
    expect(dueInfo('2026-09-05', now)).toEqual({ state: 'soon', days: 1, label: 'due tomorrow' })
    expect(dueInfo('2026-09-11', now)).toEqual({ state: 'soon', days: 7, label: 'due 7d' })
    expect(dueInfo('2026-09-22', now)).toEqual({ state: 'later', days: 18, label: 'due 22 Sep' })
    expect(dueInfo('2027-01-03', now).label).toBe('due 3 Jan 2027')
  })

  it('builds initials from first and last words', () => {
    expect(initials('Anna Berg')).toBe('AB')
    expect(initials('Paul van der Meer')).toBe('PM')
    expect(initials('paul')).toBe('PA')
    expect(initials('')).toBe('')
  })

  it('shows you for the configured person and initials for others', () => {
    const byId = new Map([['person-anna', { id: 'person-anna', title: 'Anna Berg' }]])
    expect(assigneeDisplay({ assigneeId: '' }, { byId })).toBeNull()
    expect(assigneeDisplay({ assigneeId: 'person-anna' }, { byId }))
      .toEqual({ label: 'AB', name: 'Anna Berg', self: false })
    expect(assigneeDisplay({ assigneeId: 'person-anna' }, { byId, selfId: 'person-anna' }))
      .toEqual({ label: 'you', name: 'Anna Berg', self: true })
    expect(assigneeDisplay({ assigneeId: 'Paul' }, { byId }))
      .toEqual({ label: 'PA', name: 'Paul', self: false })
  })

  it('names the waiting reason and folds human aliases into you', () => {
    expect(waitingReason({ waitingFor: '' })).toBe('')
    expect(waitingReason({ waitingFor: ' Client sign-off ' })).toBe('Client sign-off')
    expect(waitingReason({ waitingFor: 'me' })).toBe('you')
    expect(waitingReason({ waitingFor: 'Owner' })).toBe('you')
  })

  it('groups rows by status or project and drops empty groups', () => {
    const projects = [{ id: 'project-atlas', title: 'Atlas' }]
    const issues = [
      { id: 'a', status: 'plan', projectId: 'project-atlas', dueDate: '2026-09-01' },
      { id: 'b', status: 'in-progress', projectId: '' },
      { id: 'c', status: 'mystery', projectId: 'unknown', priority: 'urgent' },
    ]
    expect(groupWorkRows(issues, { groupBy: 'status' }).map(group => [group.label, group.items.map(item => item.id)]))
      .toEqual([['Backlog', ['c']], ['Plan', ['a']], ['In progress', ['b']]])
    expect(groupWorkRows(issues, { groupBy: 'project', projects }).map(group => [group.label, group.items.map(item => item.id)]))
      .toEqual([['Atlas', ['a']], ['No project', ['b', 'c']]])
  })
})
