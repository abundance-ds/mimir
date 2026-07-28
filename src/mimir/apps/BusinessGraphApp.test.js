import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  deleteGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  graphContext: vi.fn(),
  graphDiagnostics: vi.fn(),
  graphEvents: vi.fn(),
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
  deleteGraphNode,
  getGraphNode,
  graphContext,
  graphDiagnostics,
  graphEvents,
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
      ? {
          status: 'plan',
          priority: 'high',
          legacyProject: 'project-alpha',
          labels: [{ name: 'heor', color: 'blue' }],
        }
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
    vi.mocked(graphEvents).mockResolvedValue({ items: [], total: 0 })
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
    vi.mocked(updateGraphNode).mockImplementation(async patch => {
      const current = full(patch.id)
      const editable = Object.fromEntries(
        ['title', 'summary', 'body', 'tags', 'relations']
          .filter(key => patch[key] !== undefined)
          .map(key => [key, patch[key]]),
      )
      return {
        ...current,
        ...editable,
        properties: {
          ...current.properties,
          ...(patch.setProperties || {}),
        },
        provenance: {
          ...current.provenance,
          sourceRevision: 'next-rev',
        },
      }
    })
    vi.mocked(createGraphNode).mockResolvedValue(full('issue-1'))
    vi.mocked(deleteGraphNode).mockResolvedValue({
      id: 'issue-1',
      undoToken: 'undo-issue-1',
    })
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
    expect(wrapper.findAll('[data-graph-section]')).toHaveLength(5)

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-body-preview]').text()).toBe('Review extraction criteria.')
    await wrapper.get('[data-inspector-body-edit]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('focus')
    expect(wrapper.get('[data-inspector-body] .cm-content').text()).toBe('Review extraction criteria.')
    expect(wrapper.find('[data-graph-context-trail]').exists()).toBe(false)

    await wrapper.get('[data-graph-relationship-line] [data-related-node="project-alpha"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-context-trail]').text()).toContain('Extract evidence')
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
      setProperties: expect.objectContaining({ status: 'in-progress' }),
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

  it('supports scan, Peek, and Focus entirely from the keyboard', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-business-graph-app]').trigger('keydown', {
      key: 'f',
      metaKey: true,
    })
    expect(document.activeElement).toBe(wrapper.get('[data-graph-search]').element)

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: '/' })
    expect(document.activeElement).toBe(wrapper.get('[data-dispatch-input]').element)

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'f' })
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('focus')

    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    wrapper.unmount()
  })

  it('keeps a real focus chain through board, Peek, Focus, Escape, and close', async () => {
    const wrapper = render()
    await flushPromises()

    const card = wrapper.get('[data-board-card="issue-1"]')
    card.element.focus()
    await card.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')

    const focusButton = wrapper.get('[data-inspector-focus]')
    focusButton.element.focus()
    await focusButton.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-graph-control="focus-back"]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    expect(document.activeElement).toBe(wrapper.get('[data-inspector-focus]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    expect(document.activeElement).toBe(wrapper.get('[data-board-card="issue-1"]').element)
    wrapper.unmount()
  })

  it('keeps dispatch focus usable after opening and closing a lookup result', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-dispatch-input]')
    input.element.focus()
    await input.setValue('Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()
    await input.trigger('keydown', { key: 'Tab' })
    await flushPromises()

    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('peek')
    expect(document.activeElement).toBe(input.element)
    input.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(wrapper.get('[data-business-graph-app]').attributes('data-graph-mode')).toBe('scan')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('filters the active projection through a persistent debounced search', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('evidence')

    expect(searchGraph).not.toHaveBeenCalled()
    expect(wrapper.get('.graph-searching').attributes('aria-label')).toBe('Searching the graph')

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()

    expect(searchGraph).toHaveBeenCalledWith('evidence', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    expect(wrapper.get('[data-graph-filter-banner]').text()).toContain('evidence')
    expect(wrapper.get('.graph-search-count').text()).toBe('1')

    await wrapper.get('[data-graph-control="clear-search"]').trigger('click')
    expect(input.element.value).toBe('')
    expect(wrapper.find('[data-graph-control="search-filter-clear"]').exists()).toBe(false)
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('keeps every character typed while replacing a committed search', async () => {
    const wrapper = render()
    await flushPromises()
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('b')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('b')

    for (const value of ['ba', 'ban', 'bank']) {
      await input.setValue(value)
      await flushPromises()
      expect(input.element.value).toBe(value)
    }

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('bank')
    expect(searchGraph).toHaveBeenLastCalledWith('bank', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    wrapper.unmount()
  })

  it('moves directly from search into the first or last result with arrow keys', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="all"]').trigger('click')
    vi.mocked(searchGraph).mockResolvedValue([
      { node: summaries[0] },
      { node: summaries[1] },
    ])

    const search = wrapper.get('[data-graph-search]')
    await search.setValue('evidence')
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()

    await search.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    const listbox = wrapper.get('[data-graph-entity-list]')
    expect(document.activeElement).toBe(listbox.element)
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-issue-1')

    search.element.focus()
    await search.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(document.activeElement).toBe(listbox.element)
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-project-alpha')
    await wrapper.get('[data-graph-section="work"]').trigger('click')
    wrapper.unmount()
  })

  it('ignores stale results without overwriting the newer input draft', async () => {
    let resolveFirstSearch
    const firstSearch = new Promise(resolve => {
      resolveFirstSearch = resolve
    })
    vi.mocked(searchGraph).mockImplementation(query => (
      query === 'b'
        ? firstSearch
        : Promise.resolve([{ node: summaries[0] }])
    ))
    const wrapper = render()
    await flushPromises()

    const input = wrapper.get('[data-graph-search]')
    await input.setValue('b')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(searchGraph).toHaveBeenCalledTimes(1)

    await input.setValue('ba')
    await flushPromises()
    expect(input.element.value).toBe('ba')

    resolveFirstSearch([{ node: summaries[1] }])
    await flushPromises()
    expect(input.element.value).toBe('ba')
    expect(wrapper.get('[data-graph-filter-banner]').text()).toContain('ba')
    expect(wrapper.find('.graph-search-count').exists()).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(input.element.value).toBe('ba')
    expect(searchGraph).toHaveBeenLastCalledWith('ba', {
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      limit: 100,
    })
    expect(wrapper.get('[data-graph-filter-banner]').text()).toContain('ba')
    wrapper.unmount()
  })

  it('synchronizes external find and clear commands with the search field', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])
    const wrapper = render()
    await flushPromises()

    const dispatch = wrapper.get('[data-dispatch-input]')
    await dispatch.setValue('/find evidence')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const search = wrapper.get('[data-graph-search]')
    expect(search.element.value).toBe('evidence')
    expect(wrapper.get('[data-graph-filter-banner]').text()).toContain('evidence')

    await wrapper.get('[data-graph-control="search-filter-clear"]').trigger('click')
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)

    await dispatch.setValue('/find evidence')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(search.element.value).toBe('evidence')

    await dispatch.setValue('/clear')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(search.element.value).toBe('')
    expect(wrapper.find('[data-graph-filter-banner]').exists()).toBe(false)

    const callsBeforePendingClear = searchGraph.mock.calls.length
    await search.setValue('bank')
    await dispatch.setValue('/clear')
    await dispatch.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(search.element.value).toBe('')
    expect(searchGraph).toHaveBeenCalledTimes(callsBeforePendingClear)
    wrapper.unmount()
  })

  it('dismisses custom scope and column menus when the user clicks elsewhere', async () => {
    const wrapper = render()
    await flushPromises()
    const outside = document.createElement('button')
    document.body.append(outside)

    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-graph-scope-menu]').exists()).toBe(false)

    await wrapper.get('[data-board-columns-trigger]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).not.toBeNull()
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-board-columns-menu]')).toBeNull()
    wrapper.unmount()
  })

  it('navigates scope and column menus with arrows and restores their triggers', async () => {
    const wrapper = render()
    await flushPromises()

    const scopeTrigger = wrapper.get('[data-graph-scope-trigger]')
    scopeTrigger.element.focus()
    await scopeTrigger.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-scope-option="private:local"]').element)

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'End',
      bubbles: true,
    }))
    expect(document.activeElement).toBe(wrapper.get('[data-scope-option="team:main"]').element)
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(document.activeElement).toBe(scopeTrigger.element)

    const columnsTrigger = wrapper.get('[data-board-columns-trigger]')
    columnsTrigger.element.focus()
    await columnsTrigger.trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    const columnItems = [...document.querySelectorAll(
      '[data-board-columns-menu] [role="menuitemcheckbox"]',
    )]
    expect(document.activeElement).toBe(columnItems.at(-1))
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await flushPromises()
    expect(document.activeElement).toBe(columnsTrigger.element)
    wrapper.unmount()
  })

  it('keeps create, save, and AI preparation errors inside the active surface', async () => {
    const wrapper = render()
    await flushPromises()

    vi.mocked(createGraphNode).mockRejectedValueOnce(new Error('Project source is read-only'))
    await wrapper.get('[data-business-graph-app]').trigger('keydown', { key: 'n' })
    const createDialog = document.querySelector('[data-graph-create-dialog]')
    const title = createDialog.querySelector('[data-create-title]')
    title.value = 'Cannot create this'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    createDialog.querySelector('[data-create-submit]').click()
    await flushPromises()
    expect(document.querySelector('[data-graph-create-error]').textContent).toContain('read-only')
    createDialog.querySelector('[data-graph-control="create-close"]').click()
    await flushPromises()

    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await flushPromises()
    vi.mocked(updateGraphNode).mockRejectedValueOnce(new Error('Write failed unexpectedly'))
    await wrapper.get('[data-inspector-title]').setValue('Conflicting title')
    await wrapper.get('[data-inspector-save]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-save-error]').text()).toContain('Write failed unexpectedly')

    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])
    vi.mocked(graphContext).mockRejectedValue(new Error('Context could not be assembled'))
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('work Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-dispatch-pack]').text()).toContain('Context could not be assembled')
    expect(wrapper.emitted('startWork')).toBeUndefined()
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
    expect(wrapper.find('[data-inspector-project]').exists()).toBe(false)

    await wrapper.get('[data-inspector-focus]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-inspector-project]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-assignee]').attributes('role')).toBe('combobox')
    expect(wrapper.get('[data-inspector-body] .cm-content').exists()).toBe(true)

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
    vi.mocked(searchGraph).mockResolvedValue([{ node: summaries[0] }])

    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('work Extract')
    await new Promise(resolve => setTimeout(resolve, 180))
    await flushPromises()

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(graphContext).toHaveBeenCalledWith({
      focusId: 'issue-1',
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      maxNodes: 16,
    })
    expect(wrapper.get('[data-dispatch-pack]').text()).toContain('Issue context.')

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('startWork')[0][0]).toEqual(expect.objectContaining({
      nodeId: 'issue-1',
      nodeKind: 'issue',
      graphRevision: 7,
      prompt: expect.stringContaining('<graph-context>'),
    }))
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('untrusted business data')
    expect(wrapper.emitted('startWork')[0][0].prompt).toContain('Objective:')
    wrapper.unmount()
  })

  it('commits a Focus draft before refreshing or changing physical scope', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await wrapper.get('[data-inspector-title]').setValue('Evidence extraction — reviewed')
    vi.mocked(queryGraph).mockClear()

    await wrapper.get('[data-graph-refresh]').trigger('click')
    await flushPromises()

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'issue-1',
      title: 'Evidence extraction — reviewed',
    }))
    expect(queryGraph).toHaveBeenCalled()
    expect(updateGraphNode.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryGraph.mock.invocationCallOrder[0])

    await wrapper.get('[data-inspector-title]').setValue('Evidence extraction — scoped')
    vi.mocked(queryGraph).mockClear()
    await wrapper.get('[data-graph-scope-trigger]').trigger('click')
    await wrapper.get('[data-scope-option="private:local"]').trigger('click')
    await flushPromises()

    expect(updateGraphNode).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'issue-1',
      title: 'Evidence extraction — scoped',
    }))
    expect(queryGraph).toHaveBeenCalled()
    expect(updateGraphNode.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryGraph.mock.invocationCallOrder[0])
    wrapper.unmount()
  })

  it('uses a recoverable in-product confirmation before deletion', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-board-card="issue-1"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-graph-control="peek-more"]').trigger('click')
    await wrapper.get('[data-inspector-delete]').trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-graph-confirm-dialog]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Move “Extract evidence” to Trash?')
    expect(deleteGraphNode).not.toHaveBeenCalled()
    dialog.querySelector('[data-graph-control="confirm-submit"]').click()
    await flushPromises()

    expect(deleteGraphNode).toHaveBeenCalledWith({
      id: 'issue-1',
      expectedRevision: 'issue-rev',
    })
    expect(document.querySelector('[data-graph-confirm-dialog]')).toBeNull()
    expect(wrapper.get('[data-graph-undo]').text()).toContain('Extract evidence')
    wrapper.unmount()
  })

  it('moves from project dashboard context to a correctly related decision', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-graph-section="projects"]').trigger('click')
    await wrapper.get('[data-project-card="project-alpha"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-inspector-focus]').trigger('click')
    await wrapper.get('[data-inspector-record-decision]').trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-graph-create-dialog]')
    expect(dialog.querySelector('[data-create-kind]').textContent).toContain('Decision')
    const title = dialog.querySelector('[data-create-title]')
    title.value = 'Use the matched cohort'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    dialog.querySelector('[data-create-submit]').click()
    await flushPromises()

    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'decision',
      title: 'Use the matched cohort',
      relations: [{
        relation: 'part_of',
        target: 'project-alpha',
        legacy: false,
      }],
    }))
    wrapper.unmount()
  })

  it('routes dispatched lines to a background agent Activity with graph context', async () => {
    const wrapper = render()
    await flushPromises()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('file the payer objection from the call')
    await new Promise(resolve => setTimeout(resolve, 180))
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(graphContext).toHaveBeenCalledWith(expect.objectContaining({
      scopeIds: ['private:local', 'project:alpha', 'team:main'],
      maxNodes: 12,
    }))
    const request = wrapper.emitted('startWork')[0][0]
    expect(request.background).toBe(true)
    expect(request.prompt).toContain('file the payer objection from the call')
    expect(request.prompt).toContain('untrusted business data')
    wrapper.unmount()
  })
})
