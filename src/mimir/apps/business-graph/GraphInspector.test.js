import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GraphInspector from './GraphInspector.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'

const project = {
  id: 'project-atlas',
  kind: 'project',
  title: 'Project Atlas',
  scopeId: 'project:atlas',
}
const person = {
  id: 'person-alex',
  kind: 'person',
  title: 'Alex Rivera',
  scopeId: 'team:main',
}
const issue = {
  id: 'issue-evidence',
  kind: 'issue',
  title: 'Synthesize evidence',
  body: '# Evidence synthesis\n\nReview the extraction.',
  tags: ['heor'],
  relations: [
    { relation: 'part_of', target: project.id },
    { relation: 'assigned_to', target: person.id },
  ],
  properties: {
    status: 'plan',
    priority: 'high',
    dueDate: '2026-08-01',
    labels: [{ name: 'review', color: 'blue' }],
    deliverables: [{ path: 'outputs/map.xlsx', label: 'Evidence map' }],
  },
  provenance: {
    scopeId: 'project:atlas',
    sourceRevision: 'revision-1',
    sourcePath: '/atlas/issues/evidence.md',
  },
}
const blocker = {
  id: 'issue-infra',
  kind: 'issue',
  title: 'Infra migration',
  scopeId: 'project:atlas',
}
const neighbors = [
  { relation: 'part_of', direction: 'outgoing', node: project },
  { relation: 'blocked_by', direction: 'outgoing', node: blocker },
]
const baseProps = {
  node: issue,
  neighbors,
  nodes: [issue, project, person, blocker],
  scopes: [
    { id: 'project:atlas', kind: 'project' },
    { id: 'team:main', kind: 'team' },
  ],
}

describe('GraphInspector', () => {
  it('edits the operational properties of an object directly in Peek', async () => {
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'peek' },
    })
    await flushPromises()

    for (const selector of [
      '[data-inspector-title]',
      '[data-inspector-status]',
      '[data-inspector-priority]',
      '[data-inspector-project]',
      '[data-inspector-assignee]',
      '[data-inspector-due]',
      '[data-inspector-waiting]',
      '[data-inspector-body]',
    ]) {
      expect(wrapper.find(selector).exists(), `missing ${selector}`).toBe(true)
    }
    const contextStrip = wrapper.get('[data-graph-relationship-line]')
    expect(contextStrip.text()).toContain('part of')
    expect(contextStrip.text()).toContain('blocked by')
    expect(wrapper.get('[data-related-node="project-atlas"]').text()).toBe('Project Atlas')
    expect(wrapper.get('[data-related-node="issue-infra"]').text()).toBe('Infra migration')
    expect(wrapper.get('[data-inspector-focus]').text()).toContain('Focus')

    await wrapper.get('[data-inspector-title]').setValue('Synthesize pivotal evidence')
    await wrapper.get('[data-inspector-waiting]').setValue('Client confirmation')
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('Reviewed in Peek.')
    await flushPromises()
    wrapper.vm.commitThen(() => {})

    const patch = wrapper.emitted('save')[0][0]
    expect(patch).toEqual(expect.objectContaining({
      id: issue.id,
      title: 'Synthesize pivotal evidence',
      body: 'Reviewed in Peek.',
      relations: expect.arrayContaining([
        { relation: 'part_of', target: project.id, legacy: false },
      ]),
      setProperties: expect.objectContaining({ waitingFor: 'Client confirmation' }),
    }))
    wrapper.unmount()
  })

  it('keeps a legacy project label out of the relation graph so the object stays savable', async () => {
    const legacyIssue = {
      ...issue,
      relations: [],
      properties: { ...issue.properties, legacyProject: 'fde', legacyAssignee: 'Paul' },
    }
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'peek', node: legacyIssue },
    })
    await flushPromises()

    expect(wrapper.get('[data-inspector-project]').text()).toBe('fde')
    expect(wrapper.get('[data-inspector-assignee]').text()).toBe('Paul')

    await wrapper.get('[data-inspector-waiting]').setValue('Anna')
    wrapper.vm.commitThen(() => {})

    const patch = wrapper.emitted('save')[0][0]
    expect(patch.relations).toEqual([])
    expect(patch.setProperties).toEqual(expect.objectContaining({
      legacyProject: 'fde',
      legacyAssignee: 'Paul',
    }))
    wrapper.unmount()
  })

  it('lets an explicit exit through after a rejected save instead of stranding the draft', async () => {
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'peek' },
    })
    await flushPromises()

    await wrapper.get('[data-inspector-waiting]').setValue('Anna')
    await wrapper.get('[data-graph-control="peek-close"]').trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()

    wrapper.emitted('save')[0][1].failed()
    await wrapper.get('[data-graph-control="peek-close"]').trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('dismisses the Peek action menu when attention moves elsewhere', async () => {
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'peek' },
    })
    const outside = document.createElement('button')
    document.body.append(outside)

    await wrapper.get('[data-graph-control="peek-more"]').trigger('click')
    expect(wrapper.find('[data-inspector-delete]').exists()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-inspector-delete]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('puts every issue property and syntax-aware Markdown editing in Focus', async () => {
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'focus' },
    })
    await flushPromises()

    for (const selector of [
      '[data-inspector-title]',
      '[data-inspector-status]',
      '[data-inspector-priority]',
      '[data-inspector-project]',
      '[data-inspector-assignee]',
      '[data-inspector-due]',
      '[data-inspector-reminder]',
      '[data-inspector-waiting]',
      '[data-inspector-snooze]',
      '[data-inspector-tags]',
      '[data-inspector-deliverables]',
      '[data-inspector-body]',
      '[data-inspector-save]',
    ]) {
      expect(wrapper.find(selector).exists(), `missing ${selector}`).toBe(true)
    }
    expect(wrapper.find('select, datalist, input[type="date"], input[type="datetime-local"]').exists()).toBe(false)

    await wrapper.get('[data-inspector-title]').setValue('Synthesize pivotal evidence')
    await wrapper.get('[data-inspector-waiting]').setValue('Client confirmation')
    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-deliverables]').setValue('outputs/map.xlsx | Final evidence map')
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('## Updated synthesis\n\nDecision-ready context.')
    await flushPromises()
    await wrapper.get('[data-inspector-save]').trigger('click')

    const patch = wrapper.emitted('save')[0][0]
    expect(patch).toEqual(expect.objectContaining({
      id: issue.id,
      title: 'Synthesize pivotal evidence',
      body: '## Updated synthesis\n\nDecision-ready context.',
      tags: ['review', 'client'],
      setProperties: expect.objectContaining({
        waitingFor: 'Client confirmation',
        labels: expect.arrayContaining([
          expect.objectContaining({ name: 'review' }),
          expect.objectContaining({ name: 'client' }),
        ]),
        deliverables: [{ path: 'outputs/map.xlsx', label: 'Final evidence map' }],
      }),
    }))
    wrapper.unmount()
  })

  it('keeps issue tags after the save and canonical reparse cycle', async () => {
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: { ...baseProps, mode: 'focus' },
    })
    await flushPromises()

    expect(wrapper.findAll('[data-inspector-tags]')).toHaveLength(1)
    expect(wrapper.find('[data-inspector-labels]').exists()).toBe(false)
    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-save]').trigger('click')

    const [patch, controls] = wrapper.emitted('save')[0]
    const canonicalNode = {
      ...issue,
      tags: ['review', 'client'],
      properties: {
        ...issue.properties,
        labels: [
          { name: 'review', color: 'blue' },
          { name: 'client', color: 'purple' },
        ],
      },
      provenance: {
        ...issue.provenance,
        sourceRevision: 'revision-2',
      },
    }
    expect(patch.tags).toEqual(['review', 'client'])
    expect(patch.setProperties.labels.map(label => label.name)).toEqual(['review', 'client'])

    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ node: canonicalNode })
    controls.done()
    await wrapper.setProps({ saving: false })
    await wrapper.setProps({
      node: {
        ...canonicalNode,
        provenance: {
          ...canonicalNode.provenance,
          sourceRevision: 'revision-3',
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-inspector-tags]').element.value).toBe('review, client')
    wrapper.unmount()
  })

  it('does not rewrite label colors on unrelated saves and preserves them when adding tags', async () => {
    const coloredIssue = {
      ...issue,
      properties: {
        ...issue.properties,
        labels: [{ name: 'review', color: 'red' }],
      },
    }
    const wrapper = mount(GraphInspector, {
      props: { ...baseProps, mode: 'focus', node: coloredIssue },
    })
    await flushPromises()

    await wrapper.get('[data-inspector-title]').setValue('Updated title only')
    await wrapper.get('[data-inspector-save]').trigger('click')
    expect(wrapper.emitted('save')[0][0].setProperties).not.toHaveProperty('labels')

    wrapper.emitted('save')[0][1].done()
    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-save]').trigger('click')
    const labels = wrapper.emitted('save')[1][0].setProperties.labels
    expect(labels.find(label => label.name === 'review')).toEqual({
      name: 'review',
      color: 'red',
    })
  })

  it('renders each deliverable path once in either inspector mode', async () => {
    const wrapper = mount(GraphInspector, {
      props: { ...baseProps, mode: 'peek' },
    })

    expect(wrapper.findAll('[data-deliverable-path="outputs/map.xlsx"] small')).toHaveLength(1)
    await wrapper.setProps({ mode: 'focus' })
    await flushPromises()
    expect(wrapper.findAll('[data-deliverable-path="outputs/map.xlsx"] small')).toHaveLength(1)
  })

  it('shows a spacious retrieval summary for non-issue objects', async () => {
    const wrapper = mount(GraphInspector, {
      props: {
        ...baseProps,
        mode: 'focus',
        node: {
          ...project,
          summary: 'Global value evidence strategy.',
          body: 'Project context.',
          relations: [],
          properties: {},
          provenance: issue.provenance,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-inspector-summary]').element.value).toBe('Global value evidence strategy.')
    expect(wrapper.find('[data-inspector-status]').exists()).toBe(false)
    expect(wrapper.get('[data-inspector-tags]').element.value).toBe('')
  })

  it('authors bounded ontology connections without exposing a generic schema form', async () => {
    const note = {
      id: 'note-private-context',
      kind: 'note',
      title: 'Private client context',
      summary: 'Local-only working context.',
      body: '',
      relations: [],
      properties: {},
      provenance: {
        scopeId: 'private:local',
        sourceRevision: 'note-revision-1',
        sourcePath: '/private/knowledge/note-private-context.md',
      },
    }
    const wrapper = mount(GraphInspector, {
      attachTo: document.body,
      props: {
        ...baseProps,
        mode: 'focus',
        node: note,
        nodes: [note, issue, project, person],
        scopes: [
          ...baseProps.scopes,
          { id: 'private:local', kind: 'private' },
        ],
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-inspector-connection-relation]').text()).toContain('Related to')
    await wrapper.get('[data-inspector-connection-target]').trigger('click')
    document.querySelector('[data-graph-select-option="project-atlas"]').click()
    await flushPromises()
    await wrapper.get('[data-graph-control="focus-connection-add"]').trigger('click')

    expect(wrapper.get('[data-graph-control="focus-connection-remove-0"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Project Atlas')
    await wrapper.get('[data-inspector-save]').trigger('click')
    expect(wrapper.emitted('save')[0][0].relations).toEqual([
      { relation: 'related_to', target: 'project-atlas', legacy: false },
    ])
    wrapper.unmount()
  })

  it('commits the latest edit before leaving Focus', async () => {
    const wrapper = mount(GraphInspector, {
      props: { ...baseProps, mode: 'focus' },
    })
    await flushPromises()

    await wrapper.get('[data-inspector-title]').setValue('Updated before leaving')
    await wrapper.get('[data-graph-control="focus-back"]').trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('back')).toBeUndefined()

    wrapper.emitted('save')[0][1].done()
    expect(wrapper.emitted('back')).toHaveLength(1)
  })
})
