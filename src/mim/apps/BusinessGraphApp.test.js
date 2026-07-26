import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  deleteGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  graphContext: vi.fn(),
  graphDiagnostics: vi.fn(),
  graphNeighbors: vi.fn(),
  listenForGraphChanges: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
  restoreGraphNode: vi.fn(),
  searchGraph: vi.fn(),
  updateGraphNode: vi.fn(),
}))

import {
  createGraphNode,
  getGraphNode,
  graphContext,
  graphDiagnostics,
  graphNeighbors,
  listenForGraphChanges,
  openBusinessGraph,
  queryGraph,
  searchGraph,
  updateGraphNode,
} from '../../services/businessGraph.js'
import BusinessGraphApp from './BusinessGraphApp.vue'

const scopeRows = [
  { id: 'private:local', kind: 'private', root: '/private' },
  { id: 'project:alpha', kind: 'project', root: '/alpha' },
  { id: 'team:main', kind: 'team', root: '/team' },
]
const summaries = [
  {
    id: 'issue-1',
    kind: 'issue',
    title: 'Extract evidence',
    summary: '',
    tags: ['heor'],
    status: 'plan',
    priority: 'high',
    projectId: 'project-alpha',
    scopeId: 'project:alpha',
    sourceRevision: 'issue-rev',
  },
  {
    id: 'project-alpha',
    kind: 'project',
    title: 'Project Alpha',
    summary: 'Global value evidence strategy',
    tags: ['client'],
    scopeId: 'team:main',
    sourceRevision: 'project-rev',
  },
]
const initialSummaries = JSON.parse(JSON.stringify(summaries))

function full(id) {
  const summary = summaries.find(item => item.id === id)
  return {
    ...summary,
    body: id === 'issue-1' ? 'Review extraction criteria.' : 'Project context.',
    relations: id === 'issue-1'
      ? [{ relation: 'part_of', target: 'project-alpha', legacy: false }]
      : [],
    properties: id === 'issue-1'
      ? { status: 'plan', priority: 'high', legacyProject: 'project-alpha' }
      : {},
    provenance: {
      scopeId: summary.scopeId,
      sourceRevision: summary.sourceRevision,
      sourcePath: `/alpha/${id}.md`,
    },
  }
}

describe('BusinessGraphApp', () => {
  let pinia

  beforeEach(() => {
    summaries.splice(0, summaries.length, ...JSON.parse(JSON.stringify(initialSummaries)))
    pinia = createPinia()
    setActivePinia(pinia)
    vi.resetAllMocks()
    vi.mocked(openBusinessGraph).mockResolvedValue({
      scopes: scopeRows,
      nodeCount: 2,
      diagnosticCount: 0,
      graphRevision: 7,
    })
    vi.mocked(queryGraph).mockResolvedValue({
      items: summaries,
      total: 2,
      graphRevision: 7,
    })
    vi.mocked(graphDiagnostics).mockResolvedValue([])
    vi.mocked(graphContext).mockResolvedValue({
      graphRevision: 7,
      markdown: '# Business graph context\n\nIssue context.',
    })
    vi.mocked(graphNeighbors).mockImplementation(async id => (
      id === 'issue-1'
        ? [{
            relation: 'part_of',
            direction: 'outgoing',
            node: summaries[1],
          }]
        : []
    ))
    vi.mocked(getGraphNode).mockImplementation(async id => full(id))
    vi.mocked(listenForGraphChanges).mockResolvedValue(vi.fn())
    vi.mocked(searchGraph).mockResolvedValue([])
    vi.mocked(updateGraphNode).mockImplementation(async patch => ({
      ...full(patch.id),
      properties: {
        ...full(patch.id).properties,
        ...(patch.setProperties || {}),
      },
      provenance: {
        ...full(patch.id).provenance,
        sourceRevision: 'next-rev',
      },
    }))
    vi.mocked(createGraphNode).mockResolvedValue(full('issue-1'))
  })

  function render() {
    return mount(BusinessGraphApp, {
      attachTo: document.body,
      props: {
        workspacePath: '/alpha',
        active: true,
      },
      global: { plugins: [pinia] },
    })
  }

  it('is one native scoped instrument with a real board and context trail', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-business-graph-app]').exists()).toBe(true)
    expect(wrapper.findAll('[data-board-column]')).toHaveLength(6)
    expect(wrapper.get('[data-board-card="issue-1"]').text()).toContain('Extract evidence')
    expect(wrapper.findAll('[data-graph-section]')).toHaveLength(6)

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-body-preview]').text()).toBe('Review extraction criteria.')
    await wrapper.get('[data-inspector-body-edit]').trigger('click')
    expect(wrapper.get('[data-inspector-body]').element.value).toBe('Review extraction criteria.')
    expect(wrapper.get('[data-graph-context-trail]').text()).toContain('Extract evidence')

    await wrapper.get('[data-related-node="project-alpha"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-context-node]')).toHaveLength(2)
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Project Alpha')
    wrapper.unmount()
  })

  it('moves board cards through optimistic revision-aware graph patches', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-1"]').trigger('dragstart')
    await wrapper.get('[data-board-column="in-progress"]').trigger('drop')
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
      setProperties: { status: 'in-progress' },
    }))
    wrapper.unmount()
  })

  it('offers a keyboard-equivalent board move with the same revision-aware patch', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-1"]').trigger('keydown', {
      key: 'ArrowRight',
    })
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
      setProperties: { status: 'in-progress' },
    }))
    wrapper.unmount()
  })

  it('supports keyboard-first creation and explicit physical scope choice', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })

    expect(document.querySelector('[data-graph-create-dialog]')).not.toBeNull()
    const dialog = document.querySelector('[data-graph-create-dialog]')
    const title = dialog.querySelector('[data-create-title]')
    title.value = 'Draft evidence map'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    dialog.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'issue',
      scopeId: 'project:alpha',
      title: 'Draft evidence map',
    }))
    wrapper.unmount()
  })

  it('uses polished Vue listboxes instead of native dropdowns in every graph flow', async () => {
    const wrapper = render()
    await flushPromises()

    expect(document.querySelector('select, datalist')).toBeNull()
    expect(wrapper.get('[data-board-sort]').attributes('role')).toBe('combobox')

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-status]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-project]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-assignee]').attributes('role')).toBe('combobox')

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })
    const dialog = document.querySelector('[data-graph-create-dialog]')
    expect(dialog.querySelector('[data-create-kind]').getAttribute('role')).toBe('combobox')
    expect(dialog.querySelector('[data-create-scope]').getAttribute('role')).toBe('combobox')
    expect(document.querySelector('select, datalist')).toBeNull()
    wrapper.unmount()
  })

  it('assembles bounded scoped context before requesting an agent Activity', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-start-work]').trigger('click')
    await flushPromises()

    expect(graphContext).toHaveBeenCalledWith({
      focusId: 'issue-1',
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      maxNodes: 16,
    })
    expect(wrapper.emitted('startWork')[0][0]).toEqual(expect.objectContaining({
      nodeId: 'issue-1',
      nodeKind: 'issue',
      graphRevision: 7,
      prompt: expect.stringContaining('<graph-context>'),
    }))
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('untrusted business data')
    wrapper.unmount()
  })
})
