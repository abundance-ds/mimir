import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { graphDocumentState } from '../../../stores/graphDocuments.js'
import { buildInspectorSave } from './graphInspectorPersistence.js'
import { splitValues } from './graphInspectorModel.js'
import { invoke } from '@tauri-apps/api/core'
import GraphInspector from './GraphInspector.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphReferences from './GraphReferences.vue'
import { EditorView } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'

enableAutoUnmount(afterEach)

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
  createdAt: '2026-07-20T08:15:00Z',
  updatedAt: '2026-08-15T14:45:00Z',
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
    sourcePath: '/atlas/graph/evidence.md',
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

function makeDocumentFile(node) {
  return reactive({
    id: `graph:${node.id}`, kind: 'graph', path: node.provenance?.sourcePath,
    content: node.body || '', dirty: false, saveState: 'idle',
    graph: graphDocumentState({ node, sourceRevision: node.provenance?.sourceRevision, bodyFrom: 0 }),
  })
}

function mountInspector({ props, ...options }) {
  const { node = issue, documentFile = makeDocumentFile(node), ...rest } = props
  return mount(GraphInspector, {
    ...options,
    props: {
      ...rest, documentFile,
      onDraftChange: () => { documentFile.dirty = true; documentFile.graph.version += 1 },
    },
  })
}

function savePayload(wrapper) {
  const { node, draft } = wrapper.props('documentFile').graph
  return buildInspectorSave({ node, draft, nodes: wrapper.props('nodes'),
    tags: splitValues(node.kind === 'issue' ? draft.labels : draft.tags) })
}

async function replaceDocument(wrapper, node) {
  const file = wrapper.props('documentFile')
  file.graph = graphDocumentState({ node, sourceRevision: node.provenance?.sourceRevision, bodyFrom: 0 })
  file.id = `graph:${node.id}`
  file.content = node.body || ''
  file.dirty = false
  file.saveState = 'saved'
  await nextTick()
}

describe('GraphInspector', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('opens the primary project and owner without duplicate relation rows, including targets outside the loaded page', async () => {
    const wrapper = mountInspector({ props: {
      ...baseProps, nodes: [issue], neighbors: [
        { relation: 'part_of', direction: 'outgoing', node: project },
        { relation: 'assigned_to', direction: 'outgoing', node: person },
      ],
    } })
    expect(wrapper.get('[data-inspector-project]').text()).toContain(project.title)
    expect(wrapper.get('[data-inspector-assignee]').text()).toContain(person.title)
    expect(wrapper.find('[aria-label="Related entries"]').exists()).toBe(false)
    await wrapper.get('[data-graph-control="entry-open-project"]').trigger('click')
    await wrapper.get('[data-graph-control="entry-open-owner"]').trigger('click')
    expect(wrapper.emitted('openNode')).toEqual([[project.id], [person.id]])
  })

  it('uses Escape to dismiss More and the relation composer before requesting tab close', async () => {
    const wrapper = mountInspector({ attachTo: document.body, props: baseProps })
    const title = wrapper.get('[data-inspector-title]')
    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    await title.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.object-more-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-graph-control="focus-more"]').element)
    expect(wrapper.emitted('closeRequest')).toBeUndefined()
    await wrapper.get('[data-graph-control="entry-add-relation"]').trigger('click')
    await title.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.connection-composer').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-graph-control="entry-add-relation"]').element)
    expect(wrapper.emitted('closeRequest')).toBeUndefined()
    await title.trigger('keydown', { key: 'Escape', isComposing: true })
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    title.element.dispatchEvent(handled)
    expect(wrapper.emitted('closeRequest')).toBeUndefined()
    await title.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('closeRequest')).toHaveLength(1)
  })

  it('keeps a focused waiting reason editable after clearing it, then hides an empty reason on blur', async () => {
    const wrapper = mountInspector({ attachTo: document.body, props: {
      ...baseProps, node: { ...issue, properties: { ...issue.properties, waitingFor: 'Client review' } },
    } })
    const waiting = wrapper.get('[data-inspector-waiting]')
    waiting.element.focus()
    await waiting.setValue('')
    expect(wrapper.get('[data-inspector-waiting]').element).toBe(waiting.element)
    expect(document.activeElement).toBe(waiting.element)
    await waiting.setValue('Updated client review')
    expect(wrapper.props('documentFile').graph.draft.waitingFor).toBe('Updated client review')
    await waiting.setValue('')
    wrapper.get('[data-inspector-title]').element.focus()
    await nextTick()
    expect(wrapper.find('[data-inspector-waiting]').exists()).toBe(false)
  })

  it('lets Escape dismiss a pending graph link menu before it can close Details', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'graph_lookup') return new Promise(() => {})
      return []
    })
    const wrapper = mountInspector({ attachTo: document.body, props: baseProps })
    await wrapper.get('[data-graph-insert-link]').trigger('click')
    const view = EditorView.findFromDOM(wrapper.get('.cm-editor').element)
    expect(completionStatus(view.state)).not.toBeNull()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(completionStatus(view.state)).toBeNull()
    expect(wrapper.emitted('closeRequest')).toBeUndefined()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('closeRequest')).toHaveLength(1)
  })

  describe('field sizing as the Editor opens and resizes', () => {
    let observers
    beforeEach(() => {
      observers = []
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback) {
          this.callback = callback
          this.observe = vi.fn()
          this.disconnect = vi.fn()
          observers.push(this)
        }
      })
    })
    afterEach(() => { vi.unstubAllGlobals() })

    function sizingInspector({ width = 44, hidden = true } = {}) {
      const wrapper = mountInspector({
        attachTo: document.body,
        props: { ...baseProps, node: { ...issue, kind: 'person', summary: 'Current summary' } },
        global: { stubs: { GraphMarkdownEditor: true, GraphReferences: true } },
      })
      const inputs = ['title', 'summary'].map(field => wrapper.get(`[data-inspector-${field}]`).element)
      // happy-dom has no text layout. These are browser measurements before
      // and after expansion, including the oversized values from the report.
      const layout = { width, heights: [292, 1913] }
      const reads = inputs.map((input, index) => {
        input.style.minHeight = index === 0 ? '48px' : '40px'
        input.style.visibility = hidden ? 'hidden' : 'visible'
        const read = vi.fn(() => layout.heights[index])
        Object.defineProperty(input, 'clientWidth', { configurable: true, get: () => layout.width })
        Object.defineProperty(input, 'scrollHeight', { configurable: true, get: read })
        return read
      })
      function resize(width, heights, hidden = false) {
        layout.width = width
        layout.heights = heights
        inputs.forEach(input => { input.style.visibility = hidden ? 'hidden' : 'visible' })
        const root = wrapper.get('[data-graph-inspector]').element
        const observer = observers.find(candidate => candidate.observe.mock.calls.some(([element]) => element === root))
        expect(observer, 'Details width observer').toBeDefined()
        observer.callback([{ target: root, contentRect: { width } }])
        return observer
      }
      return { wrapper, inputs, reads, layout, resize }
    }

    it('skips hidden first-load measurements and sizes the unchanged draft when the pane opens', async () => {
      const { wrapper, inputs, reads, resize } = sizingInspector()
      await flushPromises()
      expect(inputs.map(input => input.style.height)).toEqual(['', ''])
      reads.forEach(read => { expect(read).not.toHaveBeenCalled() })
      resize(44, [292, 1913], true)
      resize(520, [38, 32])
      expect(inputs.map(input => input.style.height)).toEqual(['48px', '40px'])
      expect(wrapper.emitted('draftChange')).toBeUndefined()
      expect(wrapper.emitted('save')).toBeUndefined()
    })

    it('shrinks narrow measurements at a wider width without a height feedback loop', async () => {
      const { inputs, reads, resize } = sizingInspector({ hidden: false })
      await flushPromises()
      expect(inputs.map(input => input.style.height)).toEqual(['292px', '1913px'])
      resize(520, [60, 80])
      expect(inputs.map(input => input.style.height)).toEqual(['60px', '80px'])
      reads.forEach(read => { read.mockClear() })
      resize(520, [60, 80])
      reads.forEach(read => { expect(read).not.toHaveBeenCalled() })
      resize(800, [38, 32])
      expect(inputs.map(input => input.style.height)).toEqual(['48px', '40px'])
    })

    it('resizes for same-entry source refreshes and typing, including text removal', async () => {
      const { wrapper, inputs, layout } = sizingInspector({ width: 520, hidden: false })
      await flushPromises()
      const file = wrapper.props('documentFile')
      layout.heights = [38, 32]
      file.graph.draft.title = 'Short title'
      file.graph.draft.summary = 'Short summary'
      await nextTick()
      expect(inputs.map(input => input.style.height)).toEqual(['48px', '40px'])
      expect(wrapper.emitted('draftChange')).toBeUndefined()
      layout.heights[1] = 160
      await wrapper.get('[data-inspector-summary]').setValue('A long summary. '.repeat(20))
      expect(inputs[1].style.height).toBe('160px')
      layout.heights[1] = 32
      await wrapper.get('[data-inspector-summary]').setValue('')
      expect(inputs[1].style.height).toBe('40px')
    })

    it('waits for nonzero width and disconnects when Details closes', async () => {
      const { wrapper, inputs, reads, resize } = sizingInspector({ width: 0, hidden: false })
      await flushPromises()
      expect(inputs.map(input => input.style.height)).toEqual(['', ''])
      reads.forEach(read => { expect(read).not.toHaveBeenCalled() })
      const observer = resize(520, [38, 32])
      expect(inputs.map(input => input.style.height)).toEqual(['48px', '40px'])
      wrapper.unmount()
      expect(observer.disconnect).toHaveBeenCalledOnce()
    })
  })

  it('keeps draft ownership in the Editor file while opening links and backlinks', async () => {
    const wrapper = mountInspector({ props: { ...baseProps, scopeIds: ['team:main'], graphRevision: 4 } })
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    const file = wrapper.props('documentFile')
    expect(editor.props('scopeIds')).toEqual(['team:main'])
    expect(editor.props('graphRevision')).toBe(4)
    editor.vm.setValue('Changed [Jon](mimir://graph/jon)')
    await flushPromises()
    expect(file.graph.draft.body).toBe('Changed [Jon](mimir://graph/jon)')
    expect(file.dirty).toBe(true)
    editor.vm.$emit('open-graph', 'jon')
    expect(wrapper.emitted('openNode')).toEqual([['jon']])
    const request = { id: 'source', targetId: issue.id, sourceRevision: 'source-1', from: 8, to: 40 }
    wrapper.findComponent(GraphReferences).vm.$emit('open', request)
    expect(wrapper.emitted('openNode')[1]).toEqual([request])
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(file.graph.draft.body).toContain('mimir://graph/jon')
  })

  it('keeps typing available during a file save and emits save requests without payloads', async () => {
    const wrapper = mountInspector({ props: baseProps })
    const file = wrapper.props('documentFile')
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    editor.vm.setValue('First edit')
    await flushPromises()
    editor.vm.$emit('save')
    expect(wrapper.emitted('save')).toEqual([[]])
    file.saveState = 'saving'
    await nextTick()
    expect(editor.get('.cm-content').attributes('contenteditable')).toBe('true')
    editor.vm.setValue('First edit plus more typing')
    await flushPromises()
    file.graph.node = { ...issue, body: 'First edit', provenance: { ...issue.provenance, sourceRevision: 'revision-2' } }
    file.graph.sourceRevision = 'revision-2'
    file.saveState = 'idle'
    await nextTick()
    expect(editor.vm.getValue()).toBe('First edit plus more typing')
    expect(file.dirty).toBe(true)
    editor.vm.$emit('save')
    expect(wrapper.emitted('save')).toEqual([[], []])
    expect(savePayload(wrapper).payload.body).toBe('First edit plus more typing')
  })

  it('retains a failed file draft through navigation and Details remount', async () => {
    const wrapper = mountInspector({ props: baseProps })
    const file = wrapper.props('documentFile')
    const editor = wrapper.findComponent(GraphMarkdownEditor)
    editor.vm.setValue('Unsaved link [Jon](mimir://graph/jon)')
    await flushPromises()
    file.saveState = 'failed'
    await wrapper.setProps({ error: 'The file changed on disk.' })
    expect(wrapper.text()).toContain('Save failed')
    expect(wrapper.text()).toContain('The file changed on disk.')
    editor.vm.$emit('open-graph', 'jon')
    expect(wrapper.emitted('openNode')).toEqual([['jon']])
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.unmount()
    const reopened = mountInspector({ props: { ...baseProps, documentFile: file } })
    expect(reopened.findComponent(GraphMarkdownEditor).vm.getValue()).toContain('Unsaved link')
    expect(file.dirty).toBe(true)
  })

  it('opens highlighted note links while keeping the note editor enabled', async () => {
    const wrapper = mountInspector({
      props: {
        ...baseProps,
        node: { ...issue, body: 'Read https://example.com/docs then update the note.' },
      },
    })
    const editor = wrapper.findComponent(GraphMarkdownEditor)

    expect(editor.props('openLinks')).toBe(true)
    expect(editor.get('.cm-content').attributes('contenteditable')).toBe('true')
    expect(editor.get('.cm-graph-link').text()).toBe('https://example.com/docs')
    editor.vm.$emit('open-url', 'https://example.com/docs')
    editor.vm.$emit('open-file', 'outputs/map.xlsx')

    expect(wrapper.emitted('openUrl')).toEqual([['https://example.com/docs']])
    expect(wrapper.emitted('openFile')).toEqual([[
      { path: 'outputs/map.xlsx', nodeId: issue.id },
    ]])

    await flushPromises()
    await flushPromises()
    expect(wrapper.findComponent(GraphMarkdownEditor).props('openLinks')).toBe(true)
  })

  it('keeps timestamps available in More properties through source refreshes', async () => {
    const wrapper = mountInspector({
      props: { ...baseProps, },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-inspector-created]').text()).toContain('2026')
    expect(wrapper.get('[data-inspector-updated]').text()).toContain('2026')

    await flushPromises()
    await flushPromises()
    expect(wrapper.get('[data-inspector-created]').text()).toContain('2026')
    expect(wrapper.get('[data-inspector-updated]').text()).toContain('2026')
    expect(wrapper.find('.focus-source-section').exists()).toBe(false)

    await replaceDocument(wrapper, { ...issue, createdAt: '', updatedAt: '' })
    expect(wrapper.get('[data-inspector-created]').text()).toBe('Unknown')
    expect(wrapper.get('[data-inspector-updated]').text()).toBe('Unknown')
  })

  it('uses the same labeled primary metadata grammar in Details', async () => {
    const wrapper = mountInspector({
      props: { ...baseProps, },
    })
    const expected = [
      'Status',
      'Priority',
      'Project',
      'Owner',
      'Due date',
    ]

    expect(wrapper.findAll('.focus-hero .object-metadata-field > span').map(item => item.text()))
      .toEqual(expected)

    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('.focus-hero .object-metadata-field > span').map(item => item.text()))
      .toEqual(expected)
  })

  it('keeps macOS autocorrect out of every editable Details text field', async () => {
    const wrapper = mountInspector({
      props: { ...baseProps, },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    const expectManualText = (control, { structured = false } = {}) => {
      const field = wrapper.get(`[data-graph-control="${control}"]`)
      expect(field.attributes('autocorrect')).toBe('off')
      expect(field.attributes('autocapitalize')).toBe('off')
      if (structured) expect(field.attributes('spellcheck')).toBe('false')
    }

    expectManualText('focus-title')
    expectManualText('entry-waiting-extra', { structured: true })

    await flushPromises()
    await flushPromises()
    expectManualText('focus-title')
    expectManualText('entry-waiting-extra', { structured: true })
    expectManualText('focus-tags', { structured: true })
    expectManualText('focus-deliverables', { structured: true })

    const company = { ...issue, id: 'company-vandage', kind: 'company', relations: [] }
    await replaceDocument(wrapper, company)
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    expectManualText('focus-summary')
    expectManualText('focus-company-roles', { structured: true })

    await flushPromises()
    await flushPromises()
    expectManualText('focus-summary')
    expectManualText('focus-company-roles', { structured: true })
  })

  it('edits the operational properties of an object directly in Details', async () => {
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    for (const selector of [
      '[data-inspector-title]',
      '[data-inspector-status]',
      '[data-inspector-priority]',
      '[data-inspector-project]',
      '[data-inspector-assignee]',
      '[data-inspector-due]',
      '[data-inspector-waiting-extra]',
      '[data-inspector-body]',
    ]) {
      expect(wrapper.find(selector).exists(), `missing ${selector}`).toBe(true)
    }
    expect(wrapper.find('[data-related-node="project-atlas"]').exists()).toBe(false)
    expect(wrapper.find('[data-related-node="issue-infra"]').exists()).toBe(false)
    expect(wrapper.find('[data-inspector-focus]').exists()).toBe(false)

    await wrapper.get('[data-inspector-title]').setValue('Synthesize pivotal evidence')
    await wrapper.get('[data-inspector-waiting-extra]').setValue('Client confirmation')
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('Reviewed in Details.')
    await flushPromises()
    await wrapper.get('[data-inspector-save]').trigger('click')

    const { payload: patch } = savePayload(wrapper)
    expect(patch).toEqual(expect.objectContaining({
      id: issue.id,
      title: 'Synthesize pivotal evidence',
      body: 'Reviewed in Details.',
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
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, node: legacyIssue },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('[data-inspector-project]').text()).toBe('fde')
    expect(wrapper.get('[data-inspector-assignee]').text()).toBe('Paul')

    await wrapper.get('[data-inspector-waiting-extra]').setValue('Anna')
    await wrapper.get('[data-inspector-save]').trigger('click')

    const { payload: patch } = savePayload(wrapper)
    expect(patch.relations).toEqual([])
    expect(patch.setProperties).toEqual(expect.objectContaining({
      legacyProject: 'fde',
      legacyAssignee: 'Paul',
    }))
    wrapper.unmount()
  })

  it('offers active team members for task ownership without losing the current owner', async () => {
    const activeTeamMember = {
      id: 'person-paul',
      kind: 'person',
      title: 'Paul Schneider',
      properties: { teamMember: true, status: 'active' },
      scopeId: 'team:main',
    }
    const externalContact = {
      id: 'person-client',
      kind: 'person',
      title: 'Client Contact',
      properties: { status: 'active' },
      scopeId: 'team:main',
    }
    const formerTeamMember = {
      id: 'person-former',
      kind: 'person',
      title: 'Former Teammate',
      properties: { teamMember: true, status: 'former' },
      scopeId: 'team:main',
    }
    const wrapper = mountInspector({
      attachTo: document.body,
      props: {
        ...baseProps,
        nodes: [...baseProps.nodes, activeTeamMember, externalContact, formerTeamMember],
      },
    })
    await wrapper.get('[data-inspector-assignee]').trigger('click')
    await flushPromises()

    expect(document.querySelector('[data-graph-select-option="person-alex"]')).not.toBeNull()
    expect(document.querySelector('[data-graph-select-option="person-paul"]')).not.toBeNull()
    expect(document.querySelector('[data-graph-select-option="person-client"]')).toBeNull()
    expect(document.querySelector('[data-graph-select-option="person-former"]')).toBeNull()
    wrapper.unmount()
  })

  it('normalizes Project properties when the inspector saves', async () => {
    const projectNode = {
      ...project,
      summary: 'Client delivery context.',
      tags: ['client'],
      body: '',
      createdAt: '2026-07-20T08:15:00Z',
      updatedAt: '2026-08-15T14:45:00Z',
      relations: [],
      properties: { status: 'pipeline-warm' },
      provenance: {
        scopeId: 'team:main',
        sourceRevision: 'project-revision-1',
        sourcePath: '/team/graph/project-atlas.md',
      },
    }
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, node: projectNode, },
    })
    expect(wrapper.findComponent({ name: 'ProjectStanding' }).exists()).toBe(false)
    const overview = wrapper.get('details.entry-project-overview')
    overview.element.open = true
    await overview.trigger('toggle')
    expect(wrapper.findComponent({ name: 'ProjectStanding' }).exists()).toBe(true)
    expect(wrapper.props('documentFile').dirty).toBe(false)
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()

    await wrapper.get('[aria-label="Project type"]').trigger('click')
    document.querySelector('[data-graph-select-option="client-engagement"]').click()
    await flushPromises()
    await wrapper.get('[aria-label="Project status"]').trigger('click')
    document.querySelector('[data-graph-select-option="active"]').click()
    await flushPromises()
    await wrapper.get('[data-inspector-save]').trigger('click')

    expect(savePayload(wrapper).payload).toEqual(expect.objectContaining({
      setProperties: {
        projectType: 'client-engagement',
        projectStatus: 'active',
      },
      removeProperties: ['status'],
    }))
  })

  it('dismisses the entry action menu when attention moves elsewhere', async () => {
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, },
    })
    const outside = document.createElement('button')
    document.body.append(outside)

    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    expect(wrapper.find('[data-inspector-delete]').exists()).toBe(true)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-inspector-delete]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses one action header in Details without repeating the relationship strip', async () => {
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, },
    })
    await flushPromises()

    const header = wrapper.get('.focus-header')
    expect(header.find('[data-inspector-save]').exists()).toBe(true)
    expect(header.find('[data-graph-control="entry-source"]').exists()).toBe(true)
    expect(header.find('[data-graph-control="focus-more"]').exists()).toBe(true)
    expect(header.find('[data-graph-control="focus-close"]').exists()).toBe(false)
    expect(header.find('[data-graph-control="focus-back"]').exists()).toBe(false)
    expect(wrapper.find('.focus-footer').exists()).toBe(false)
    expect(wrapper.find('[data-graph-relationship-line]').exists()).toBe(false)

    await header.get('[data-graph-control="focus-more"]').trigger('click')
    expect(wrapper.get('[data-inspector-next-action]').text()).toContain('Create next action')
    expect(wrapper.get('[data-inspector-delete]').text()).toContain('Move to Trash')
    wrapper.unmount()
  })

  it('opens a saved graph version through the Editor history diff', async () => {
    vi.mocked(invoke).mockImplementation(command => {
      if (command === 'git_file_history_available') return Promise.resolve(true)
      if (command === 'git_file_history') return Promise.resolve([{
        hash: 'abcdef123456',
        shortHash: 'abcdef12',
        message: 'Mimir sync',
        authoredAt: '2026-08-15T14:45:00Z',
        author: 'Mimir',
        binary: false,
        size: 120,
      }])
      return Promise.resolve(null)
    })
    const wrapper = mountInspector({
      props: { ...baseProps, },
    })
    await flushPromises()

    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    await wrapper.get('[data-inspector-file-history]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-file-history-version="abcdef123456"]').trigger('click')

    expect(invoke).toHaveBeenCalledWith('git_file_history', {
      path: issue.provenance.sourcePath,
      limit: 50,
    })
    expect(wrapper.emitted('openFile')).toEqual([[
      {
        path: issue.provenance.sourcePath,
        nodeId: issue.id,
        history: {
          hash: 'abcdef123456',
          shortHash: 'abcdef12',
          label: 'Mimir sync',
          timestamp: '2026-08-15T14:45:00Z',
        },
      },
    ]])
  })

  it('offers orphan Team files only on a Team Resource object', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'git_file_history_available') return Promise.resolve(false)
      if (command === 'team_resource_list') {
        return Promise.resolve([
          { path: 'resources/linked.csv', size: 12 },
          { path: 'resources/orphan.html', size: 42 },
        ])
      }
      return undefined
    })
    const resource = {
      id: 'resource-proposal-template',
      kind: 'resource',
      title: 'Proposal template',
      relations: [],
      properties: { files: [{ path: 'resources/linked.csv', label: 'Data' }] },
      provenance: {
        scopeId: 'team:main',
        sourceRevision: 'resource-revision-1',
        sourcePath: '/team/graph/proposal-template.md',
      },
    }
    const wrapper = mountInspector({
      props: {
        ...baseProps,
        node: resource,
        nodes: [resource],
      },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.find('[data-unlinked-resource="resources/linked.csv"]').exists()).toBe(false)
    await wrapper.get('[data-unlinked-resource="resources/orphan.html"]').trigger('click')
    expect(wrapper.get('[data-inspector-files]').element.value).toContain('resources/orphan.html')
  })

  it('edits occasional properties through disclosure while retaining the note', async () => {
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    for (const selector of [
      '[data-inspector-title]',
      '[data-inspector-status]',
      '[data-inspector-priority]',
      '[data-inspector-project]',
      '[data-inspector-assignee]',
      '[data-inspector-due]',
      '[data-inspector-reminder]',
      '[data-inspector-waiting-extra]',
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
    await wrapper.get('[data-inspector-waiting-extra]').setValue('Client confirmation')
    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-deliverables]').setValue('outputs/map.xlsx | Final evidence map')
    wrapper.findComponent(GraphMarkdownEditor).vm.setValue('## Updated synthesis\n\nDecision-ready context.')
    await flushPromises()
    await wrapper.get('[data-inspector-save]').trigger('click')

    const { payload: patch } = savePayload(wrapper)
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
    const wrapper = mountInspector({
      attachTo: document.body,
      props: { ...baseProps, },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.findAll('[data-inspector-tags]')).toHaveLength(1)
    expect(wrapper.find('[data-inspector-labels]').exists()).toBe(false)
    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-save]').trigger('click')

    const { payload: patch } = savePayload(wrapper)
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

    await replaceDocument(wrapper, canonicalNode)
    await replaceDocument(wrapper, {
      ...canonicalNode,
      provenance: { ...canonicalNode.provenance, sourceRevision: 'revision-3' },
    })

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
    const wrapper = mountInspector({
      props: { ...baseProps, node: coloredIssue },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    await wrapper.get('[data-inspector-title]').setValue('Updated title only')
    await wrapper.get('[data-inspector-save]').trigger('click')
    expect(savePayload(wrapper).payload.setProperties).not.toHaveProperty('labels')

    await wrapper.get('[data-inspector-tags]').setValue('review, client')
    await wrapper.get('[data-inspector-save]').trigger('click')
    const labels = savePayload(wrapper).payload.setProperties.labels
    expect(labels.find(label => label.name === 'review')).toEqual({
      name: 'review',
      color: 'red',
    })
  })

  it('renders each deliverable path once in Details', async () => {
    const wrapper = mountInspector({
      props: { ...baseProps, },
    })

    expect(wrapper.findAll('[data-deliverable-path="outputs/map.xlsx"] small')).toHaveLength(1)
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('[data-deliverable-path="outputs/map.xlsx"] small')).toHaveLength(1)
  })

  it('keeps a plain description for non-issue entries', async () => {
    const wrapper = mountInspector({
      props: {
        ...baseProps,
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
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
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
        sourcePath: '/private/graph/note-private-context.md',
      },
    }
    const wrapper = mountInspector({
      attachTo: document.body,
      props: {
        ...baseProps,
        node: note,
        nodes: [note, issue, project, person],
        scopes: [
          ...baseProps.scopes,
          { id: 'private:local', kind: 'private' },
        ],
      },
    })
    await flushPromises()

    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    expect(wrapper.find('[data-inspector-file-history]').exists()).toBe(false)
    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')

    await wrapper.get('[data-graph-control="entry-add-relation"]').trigger('click')
    expect(wrapper.get('[data-inspector-connection-relation]').text()).toContain('Related to')
    await wrapper.get('[data-inspector-connection-target]').trigger('click')
    document.querySelector('[data-graph-select-option="project-atlas"]').click()
    await flushPromises()
    await wrapper.get('[data-graph-control="focus-connection-add"]').trigger('click')

    expect(wrapper.get('[data-graph-control="focus-connection-remove-0"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Project Atlas')
    await wrapper.get('[data-inspector-save]').trigger('click')
    expect(savePayload(wrapper).payload.relations).toEqual([
      { relation: 'related_to', target: 'project-atlas', legacy: false },
    ])
    wrapper.unmount()
  })

  it('edits filed meeting context and opens the exact Scribe source', async () => {
    const filedMeeting = {
      id: 'meeting-1',
      kind: 'meeting',
      title: 'Launch review',
      summary: 'Ship Friday.',
      body: '- Ship Friday.\n\n## User notes\nAsk about rollout.',
      tags: [],
      createdAt: '2026-08-28T10:00:00Z',
      updatedAt: '2026-08-28T10:45:00Z',
      relations: [
        { relation: 'part_of', target: project.id, legacy: false },
        { relation: 'attended_by', target: person.id, legacy: false },
      ],
      properties: {
        sourceMeetingId: 'meeting-1',
        occurredAt: '2026-08-28T10:00:00Z',
        durationMs: 2_700_000,
      },
      provenance: {
        scopeId: 'team:main',
        sourceRevision: 'meeting-revision-1',
        sourcePath: '/team/graph/meeting-1.md',
      },
    }
    const wrapper = mountInspector({
      attachTo: document.body,
      props: {
        ...baseProps,
        node: filedMeeting,
        nodes: [filedMeeting, project],
        neighbors: [{ relation: 'attended_by', direction: 'outgoing', node: person }],
        scopes: [
          ...baseProps.scopes,
          { id: 'private:local', kind: 'private' },
        ],
      },
    })
    await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('[data-inspector-meeting-project]').text()).toContain('Project Atlas')
    expect(wrapper.text()).toContain('45 min')
    expect(wrapper.text()).toContain('Alex Rivera')
    await wrapper.get('[data-graph-control="entry-open-person-person-alex"]').trigger('click')
    expect(wrapper.emitted('openNode')).toEqual([[person.id]])
    await wrapper.get('[data-graph-control="focus-meeting-transcript"]').trigger('click')
    expect(wrapper.emitted('openMeeting')).toEqual([['meeting-1']])

    await wrapper.get('[data-inspector-meeting-scope]').trigger('click')
    document.querySelector('[data-graph-select-option="private:local"]').click()
    await wrapper.get('[data-graph-control="focus-meeting-person-remove-person-alex"]').trigger('click')
    await wrapper.get('[data-inspector-save]').trigger('click')

    const { payload: patch, targetScopeId } = savePayload(wrapper)
    expect(patch.relations).toEqual([
      { relation: 'part_of', target: 'project-atlas', legacy: false },
    ])
    expect(targetScopeId).toBe('private:local')
    wrapper.unmount()
  })
  describe('quiet Details disclosures', () => {
    const emptyLinks = { outgoing: [], backlinks: [], sourceRevision: 'note-1' }
    const note = {
      id: 'note-context', kind: 'note', title: 'Research context', summary: 'A short description.',
      body: 'Working notes remain the main content.', tags: [], relations: [], properties: {},
      createdAt: issue.createdAt, updatedAt: issue.updatedAt,
      provenance: { ...issue.provenance, sourceRevision: 'note-1' },
    }

    it('keeps empty sections and optional property fields out of the initial document', async () => {
      vi.mocked(invoke).mockResolvedValue(emptyLinks)
      const wrapper = mountInspector({ props: { ...baseProps, node: note, nodes: [note], neighbors: [] } })
      await flushPromises()

      expect(wrapper.get('[data-inspector-title]').element.value).toBe(note.title)
      expect(wrapper.findComponent(GraphMarkdownEditor).vm.getValue()).toBe(note.body)
      expect(wrapper.find('.entry-related').exists()).toBe(false)
      expect(wrapper.find('.graph-references').exists()).toBe(false)
      expect(wrapper.find('.connection-composer').exists()).toBe(false)
      expect(wrapper.find('[data-inspector-tags]').exists()).toBe(false)
      expect(wrapper.find('[data-inspector-files]').exists()).toBe(false)
      expect(wrapper.find('[data-inspector-created]').exists()).toBe(false)
      const disclosure = wrapper.get('[data-graph-control="entry-properties"]')
      expect(disclosure.attributes('aria-expanded')).toBe('false')
      await disclosure.trigger('click')
      expect(disclosure.attributes('aria-expanded')).toBe('true')
      expect(wrapper.get('[aria-label="More properties"]').attributes('id')).toBe(disclosure.attributes('aria-controls'))
      expect(wrapper.get('[data-inspector-tags]').element.value).toBe('')
      expect(wrapper.get('[data-inspector-files]').element.value).toBe('')
      expect(wrapper.get('[data-inspector-created]').text()).toContain('2026')
      await disclosure.trigger('click')
      expect(wrapper.find('[aria-label="More properties"]').exists()).toBe(false)
      expect(wrapper.props('documentFile').dirty).toBe(false)
      expect(wrapper.emitted('draftChange')).toBeUndefined()
    })

    it('resets optional controls when a preview tab is reused for another entry', async () => {
      const wrapper = mountInspector({ props: { ...baseProps, node: note, nodes: [note], neighbors: [] } })
      await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
      await wrapper.get('[data-graph-control="entry-add-relation"]').trigger('click')
      const file = wrapper.props('documentFile')
      // Preview replacement keeps the Editor tab id, but changes Graph identity.
      file.graph = graphDocumentState({ node: { ...note, id: 'note-next' }, sourceRevision: 'note-2', bodyFrom: 0 })
      await nextTick()
      expect(wrapper.find('[aria-label="More properties"]').exists()).toBe(false)
      expect(wrapper.find('.connection-composer').exists()).toBe(false)
    })

    it('checks Git History only after the action menu opens and reads versions only on History', async () => {
      vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'graph_references') return emptyLinks
        if (command === 'git_file_history_available') return true
        if (command === 'git_file_history') return [{ hash: 'version-1', shortHash: 'version', message: 'Saved context', authoredAt: issue.updatedAt }]
        return null
      })
      const wrapper = mountInspector({ props: { ...baseProps, node: note, nodes: [note], neighbors: [] } })
      await flushPromises()
      expect(invoke).not.toHaveBeenCalledWith('git_file_history_available', expect.anything())
      expect(invoke).not.toHaveBeenCalledWith('git_file_history', expect.anything())

      await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
      await flushPromises()
      expect(invoke).toHaveBeenCalledWith('git_file_history_available', { path: note.provenance.sourcePath })
      expect(invoke).not.toHaveBeenCalledWith('git_file_history', expect.anything())
      await wrapper.get('[data-inspector-file-history]').trigger('click')
      await flushPromises()
      expect(invoke).toHaveBeenCalledWith('git_file_history', { path: note.provenance.sourcePath, limit: 50 })
      expect(wrapper.get('[data-inspector-file-history-panel]').text()).toContain('Saved context')
      expect(wrapper.props('documentFile').dirty).toBe(false)
    })

    it('lists Team resource files only inside More properties and attaches them to the draft', async () => {
      const resource = {
        ...note, id: 'resource-context', kind: 'resource',
        provenance: { ...note.provenance, scopeId: 'team:main' },
      }
      vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'graph_references') return emptyLinks
        if (command === 'team_resource_list') return [{ path: 'resources/context.pdf', size: 128 }]
        return null
      })
      const wrapper = mountInspector({ props: { ...baseProps, node: resource, nodes: [resource], neighbors: [] } })
      await flushPromises()
      expect(invoke).not.toHaveBeenCalledWith('team_resource_list')
      expect(wrapper.find('[data-inspector-unlinked-resources]').exists()).toBe(false)
      await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
      await flushPromises()
      expect(invoke).toHaveBeenCalledWith('team_resource_list')
      await wrapper.get('[data-unlinked-resource="resources/context.pdf"]').trigger('click')
      expect(wrapper.props('documentFile').graph.draft.files).toBe('resources/context.pdf')
      expect(wrapper.get('[data-resource-path="resources/context.pdf"]').text()).toContain('context.pdf')
      expect(wrapper.find('[data-unlinked-resource="resources/context.pdf"]').exists()).toBe(false)
      await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
      await wrapper.get('[data-inspector-title]').setValue('Updated resource title')
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'team_resource_list')).toHaveLength(1)
      expect(wrapper.props('documentFile').dirty).toBe(true)
    })

    it('keeps explicit incoming relations in Related and derived body references in Backlinks', async () => {
      const explicit = { id: 'decision-explicit', kind: 'decision', title: 'Recorded decision', relations: [{ relation: 'related_to', target: note.id }] }
      const bodyOnly = { id: 'note-body', kind: 'note', title: 'Body reference', relations: [] }
      vi.mocked(invoke).mockImplementation(async command => command === 'graph_references' ? {
        ...emptyLinks,
        backlinks: [explicit, bodyOnly].map((source, index) => ({
          source, sourceRevision: `${source.id}-revision`,
          occurrences: [{ targetId: note.id, label: note.title, from: index + 3, to: index + 45 }],
        })),
      } : null)
      const wrapper = mountInspector({ props: {
        ...baseProps, node: note, nodes: [note],
        neighbors: [
          { relation: 'related_to', direction: 'incoming', node: explicit },
          { relation: 'references', direction: 'incoming', node: explicit },
          { relation: 'references', direction: 'incoming', node: bodyOnly },
        ],
      } })
      await flushPromises()
      const related = wrapper.get('[aria-label="Related entries"]')
      expect(related.findAll('[data-related-node]')).toHaveLength(1)
      expect(related.get('[data-related-node="decision-explicit"]').text()).toContain('Recorded decision')
      expect(related.text()).not.toContain('Body reference')
      const backlinks = wrapper.get('[data-graph-reference-group="backlinks"]')
      expect(backlinks.get('summary').attributes('aria-label')).toBe('Backlinks, 2')
      backlinks.element.open = true
      await backlinks.trigger('toggle')
      expect(backlinks.findAll('[data-graph-backlink]')).toHaveLength(2)
      await related.get('[data-related-node="decision-explicit"]').trigger('click')
      await backlinks.get('[data-graph-control="note-backlink-note-body"]').trigger('click')
      expect(wrapper.emitted('openNode')).toEqual([
        ['decision-explicit'],
        [{ id: 'note-body', targetId: note.id, sourceRevision: 'note-body-revision', from: 4, to: 46 }],
      ])
    })

    it('updates attachment rows from the draft and keeps duplicate output labels and identity', async () => {
      const source = {
        ...issue,
        properties: {
          ...issue.properties,
          files: [{ path: './outputs/map.xlsx' }, { path: 'resources/reference.pdf', label: 'Readout' }],
        },
      }
      vi.mocked(invoke).mockResolvedValue(emptyLinks)
      const wrapper = mountInspector({ props: { ...baseProps, node: source } })
      await flushPromises()
      const files = () => wrapper.get('section[aria-label="Files"]')
      expect(files().findAll('.object-link-row')).toHaveLength(2)
      expect(files().get('[data-deliverable-path="outputs/map.xlsx"]').text()).toContain('Evidence map')
      await wrapper.get('[data-graph-control="entry-properties"]').trigger('click')
      await wrapper.get('[data-inspector-deliverables]').setValue('outputs/updated.xlsx | Revised evidence')
      await wrapper.get('[data-inspector-files]').setValue('outputs/updated.xlsx\nresources/reference.pdf | Revised readout')
      expect(files().findAll('.object-link-row')).toHaveLength(2)
      expect(files().find('[data-deliverable-path="outputs/map.xlsx"]').exists()).toBe(false)
      expect(files().get('[data-deliverable-path="outputs/updated.xlsx"]').text()).toContain('Revised evidence')
      expect(files().get('[data-resource-path="resources/reference.pdf"]').text()).toContain('Revised readout')
      await files().get('[data-deliverable-path="outputs/updated.xlsx"]').trigger('click')
      expect(wrapper.emitted('openFile')).toEqual([[{ path: 'outputs/updated.xlsx', nodeId: issue.id }]])
      expect(wrapper.props('documentFile').graph.node.properties.deliverables).toEqual(issue.properties.deliverables)
      expect(wrapper.props('documentFile').dirty).toBe(true)
    })
  })

})
