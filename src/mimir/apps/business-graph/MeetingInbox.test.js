import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MeetingInbox from './MeetingInbox.vue'

const meeting = {
  id: 'meeting-1',
  title: 'Launch review',
  startedAt: '2026-08-28T10:00:00.000Z',
  durationMs: 2_700_000,
  summary: '- Ship Friday.\n- Ana owns rollout.\n\n## User notes\nAsk about support.',
}

describe('MeetingInbox', () => {
  it('keeps project explicit, defaults scope to Team, and files concise context', async () => {
    const wrapper = mount(MeetingInbox, {
      attachTo: document.body,
      props: {
        meetings: [meeting],
        projects: [{ id: 'project-atlas', title: 'Project Atlas' }],
        people: [{ id: 'person-ana', title: 'Ana' }],
        scopes: [
          { id: 'project:atlas', kind: 'project' },
          { id: 'team:main', kind: 'team' },
          { id: 'private:local', kind: 'private' },
        ],
      },
    })

    await wrapper.get('[data-meeting-inbox-row="meeting-1"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['meeting-1']])
    expect(wrapper.get('.meeting-summary').text()).toContain('Ship Friday')
    expect(wrapper.get('[data-meeting-file]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-meeting-scope]').text()).toContain('Team')

    await wrapper.get('[data-meeting-project]').trigger('click')
    document.querySelector('[data-graph-select-option="__none__"]').click()
    await wrapper.get('[data-meeting-person-add]').trigger('click')
    document.querySelector('[data-graph-select-option="person-ana"]').click()
    await flushPromises()
    expect(wrapper.emitted('change').at(-1)[0]).toEqual({
      meetingId: 'meeting-1',
      graphDraft: {
        projectResolved: true,
        projectId: null,
        peopleIds: ['person-ana'],
        scopeId: 'team:main',
      },
    })
    await wrapper.get('[data-meeting-file]').trigger('click')

    expect(wrapper.emitted('file')).toEqual([[
      {
        meetingId: 'meeting-1',
        scopeId: 'team:main',
        projectId: null,
        peopleIds: ['person-ana'],
      },
    ]])
    await wrapper.get('[data-meeting-open-transcript]').trigger('click')
    expect(wrapper.emitted('openMeeting')).toEqual([['meeting-1']])
    wrapper.unmount()
  })

  it('prefills the current workspace Project when it is linked', async () => {
    const wrapper = mount(MeetingInbox, {
      props: {
        meetings: [meeting],
        projects: [{ id: 'project-atlas', title: 'Project Atlas' }],
        scopes: [{ id: 'team:main', kind: 'team' }],
        defaultProjectId: 'project-atlas',
      },
    })

    await wrapper.get('[data-meeting-inbox-row="meeting-1"]').trigger('click')
    expect(wrapper.get('[data-meeting-project]').text()).toContain('Project Atlas')
    expect(wrapper.get('[data-meeting-file]').attributes('disabled')).toBeUndefined()
  })

  it('restores context saved while the meeting was prepared', async () => {
    const wrapper = mount(MeetingInbox, {
      props: {
        meetings: [{
          ...meeting,
          graphDraft: {
            projectResolved: true,
            projectId: 'project-atlas',
            peopleIds: ['person-ana'],
            scopeId: 'private:local',
          },
        }],
        projects: [{ id: 'project-atlas', title: 'Project Atlas' }],
        people: [{ id: 'person-ana', title: 'Ana' }],
        scopes: [
          { id: 'team:main', kind: 'team' },
          { id: 'private:local', kind: 'private' },
        ],
      },
    })

    await wrapper.get('[data-meeting-inbox-row="meeting-1"]').trigger('click')
    expect(wrapper.get('[data-meeting-project]').text()).toContain('Project Atlas')
    expect(wrapper.get('[data-meeting-scope]').text()).toContain('Private')
    expect(wrapper.text()).toContain('Ana')
    expect(wrapper.get('[data-meeting-file]').attributes('disabled')).toBeUndefined()
  })
})
