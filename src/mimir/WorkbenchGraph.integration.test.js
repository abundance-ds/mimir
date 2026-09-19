import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { EditorView } from '@codemirror/view'
import WorkbenchApp from './WorkbenchApp.vue'
import { useFileStore } from '../stores/files.js'
import { useWorkbenchStore } from '../stores/workbench.js'
import { useProjectHomeStore } from '../stores/projectHome.js'
import { useBusinessGraphStore } from '../stores/businessGraph.js'

// Keep the complete Graph -> Activity -> Workbench -> Editor route real.
// These services need a desktop host but do not own that route.
vi.mock('../services/fileIndex.js', async importOriginal => ({
  ...(await importOriginal()),
  openWorkspaceIndex: vi.fn(async () => []),
  listIndexedFiles: vi.fn(async () => []),
  filterIndexedFiles: vi.fn(async () => []),
}))
vi.mock('../services/toolRuntime.js', () => ({
  createToolRuntime: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }),
}))
vi.mock('../editor/nativeMenu.js', () => ({
  installNativeEditorMenu: vi.fn(async () => true),
  shouldInstallNativeEditorMenu: () => false,
}))

const workspace = '/work'
const path = '/work/graph/issue-evidence.md'
const title = 'Review the evidence synthesis'
const body = 'Compare the trial populations and document the remaining uncertainty.'
const metadata = `---\ntitle: ${title}\nkind: issue\nstatus: plan\n---\n`
const source = {
  content: metadata + body,
  sourceRevision: 'revision-1',
  bodyFrom: metadata.length,
  node: {
    id: 'issue-evidence', kind: 'issue', title, body, summary: '', tags: [], relations: [],
    properties: { status: 'plan', priority: 'normal' },
    createdAt: '2026-09-13T08:00:00Z', updatedAt: '2026-09-13T08:00:00Z',
    provenance: { sourcePath: path, scopeId: 'project:atlas', scopeKind: 'project', sourceRevision: 'revision-1' },
  },
}
const graphStatus = {
  scopes: [{ id: 'project:atlas', kind: 'project', root: workspace }],
  graphRevision: 1, nodeCount: 1, diagnosticCount: 0,
}
const summary = {
  id: source.node.id, kind: 'issue', title, summary: '', tags: [], relations: [],
  status: 'plan', priority: 'normal', scopeId: 'project:atlas',
  sourceRevision: 'revision-1', updatedAt: source.node.updatedAt,
}

describe('Graph Details through Workbench', () => {
  let wrapper
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    const storage = new Map([['mimir:editor:settings:v1', JSON.stringify({ mimirWorkspaceFolder: workspace })]])
    vi.stubGlobal('localStorage', {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    })
    delete window.__TAURI_INTERNALS__
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 })
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'app_catalog') return {
        directory: '/home/me/.mimir/apps', diagnostics: [],
        apps: [{ id: 'business-graph', title: 'Graph', mode: 'rust-helper', helper: 'business-graph', builtin: true, tools: [] }],
      }
      if (command === 'app_resolve') return { mode: 'rust-helper', appId: 'business-graph', helper: 'business-graph' }
      if (command === 'graph_open' || command === 'graph_status') return structuredClone(graphStatus)
      if (command === 'graph_query') return { items: [structuredClone(summary)], total: 1, graphRevision: 1 }
      if (command === 'graph_source') return args.path === path ? structuredClone(source) : null
      if (command === 'graph_get') return args.id === source.node.id ? structuredClone(source.node) : null
      if (command === 'graph_references') return { outgoing: [], backlinks: [], sourceRevision: source.sourceRevision }
      if (command === 'graph_events') return { items: [], total: 0, offset: 0 }
      if (command === 'graph_neighbors' || command === 'graph_diagnostics' || command === 'graph_link_targets'
        || command === 'activity_list' || command === 'workspace_file_list_directory') return []
      if (command === 'chat_config') return { enabled: false }
      if (command === 'chat_status') return { state: 'disabled' }
      return null
    })
  })

  afterEach(async () => {
    for (const file of useFileStore().openFiles) useFileStore().pauseGraphSave(file)
    wrapper?.unmount()
    await flushPromises()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens Home in Main without touching Editor and retains it while a task opens', async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()
    const project = {
      ...structuredClone(source.node), id: 'project-atlas', kind: 'project', title: 'Atlas',
      body: '**Deliverable:** Evidence review.\n\n## Key resources\n\n- [Protocol](https://example.org/protocol)',
      properties: { projectStatus: 'active', home: { canvas: 'Canvas text.' } },
      provenance: { ...source.node.provenance, sourcePath: '/work/graph/project-atlas.md' },
    }
    const header = '---\ntitle: Atlas\nkind: project\n---\n'
    const projectSource = { node: project, content: header + project.body, bodyFrom: header.length, sourceRevision: 'revision-1' }
    const task = { ...summary, status: 'review', projectId: project.id, relations: [{ relation: 'part_of', target: project.id }] }
    const projectSummary = { ...project, scopeId: 'project:atlas' }
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'graph_query') {
        const items = args.query.projectIds?.length ? [task] : [projectSummary, task]
        return { items: structuredClone(items), total: items.length, graphRevision: 1 }
      }
      if (command === 'graph_source' && args.path === project.provenance.sourcePath) return structuredClone(projectSource)
      if (command === 'graph_get' && args.id === project.id) return structuredClone(project)
      if (command === 'graph_update' && args.patch.id === project.id) {
        Object.assign(project.properties, args.patch.setProperties)
        projectSource.sourceRevision = project.provenance.sourceRevision = 'revision-2'
        return structuredClone(project)
      }
      return fallback(command, args)
    })
    wrapper = mount(WorkbenchApp, { attachTo: document.body, global: { plugins: [pinia],
      stubs: { EmbeddedAppHost: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true },
    } })
    await flushPromises()
    await wrapper.get('[data-sidebar-row="tool:app:business-graph"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    const files = useFileStore(), graph = useBusinessGraphStore()
    graph.setWorkspaceConfiguration({ project: project.id })
    const previousFile = files.currentFile
    const editorState = useWorkbenchStore().paneLayout.editor.state
    await wrapper.get('[data-graph-section="home"]').trigger('click')
    await flushPromises()
    const home = wrapper.get('[data-graph-home]')
    expect(home.text()).toContain('Evidence review.')
    expect(files.currentFile).toBe(previousFile)
    expect(useWorkbenchStore().paneLayout.editor.state).toBe(editorState)
    expect(wrapper.find('[data-graph-inspector]').exists()).toBe(false)

    home.element.scrollTop = 180
    await wrapper.get('[data-graph-control="project-task-issue-evidence"]').trigger('click')
    await flushPromises()
    expect(files.currentFile.path).toBe(path)
    expect(graph.section).toBe('home')
    expect(wrapper.get('[data-graph-home]').element).toBe(home.element)
    expect(home.element.scrollTop).toBe(180)
    const taskFile = files.currentFile

    await wrapper.get('[data-graph-control="project-open-work"]').trigger('click')
    await flushPromises()
    expect(graph.section).toBe('work')
    expect(graph.workProjectId).toBe(project.id)
    expect(wrapper.find('[data-board-card="issue-evidence"]').exists()).toBe(true)
    expect(files.currentFile).toBe(taskFile)
    await wrapper.get('[data-graph-control="work-open-project"]').trigger('click')
    await flushPromises()
    expect(graph.section).toBe('home')
    expect(wrapper.get('[data-graph-home]').element).toBe(home.element)
    expect(home.element.scrollTop).toBe(180)
    expect(files.currentFile).toBe(taskFile)
    const canvas = EditorView.findFromDOM(home.get('.cm-editor').element)
    canvas.dispatch({ changes: { from: canvas.state.doc.length, insert: ' More text.' } })
    await flushPromises()
    const homeStore = useProjectHomeStore()
    await homeStore.save(homeStore.entries[project.provenance.sourcePath])
    expect(project.properties.home.canvas).toBe('Canvas text. More text.')
    expect(project.body).toContain('Evidence review.')
    expect(files.currentFile).toBe(taskFile)
    expect(graph.section).toBe('home')
    expect(home.get('.project-home-project-context').attributes('open')).toBeUndefined()
    expect(wrapper.find('[data-workbench-diagnostic]').exists()).toBe(false)
  })

  it('opens real Details from a Board row and keeps its draft until close is confirmed', async () => {
    wrapper = mount(WorkbenchApp, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: { EmbeddedAppHost: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true },
      },
    })
    await flushPromises()
    await wrapper.get('[data-sidebar-row="tool:app:business-graph"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    const workbench = useWorkbenchStore()
    workbench.setPaneState('editor', 'rail')
    await nextTick()
    const row = wrapper.get('[data-board-card="issue-evidence"]')
    row.element.focus()

    await row.trigger('click')
    await flushPromises()

    const files = useFileStore()
    expect(files.currentFile.path).toBe(path)
    expect(files.currentFile.kind).toBe('graph')
    expect(wrapper.get('[data-inspector-title]').element.value).toBe(title)
    const note = wrapper.get('[data-graph-markdown-editor] .cm-editor')
    expect(EditorView.findFromDOM(note.element).state.doc.toString()).toBe(body)
    expect(wrapper.get('[data-graph-inspector]').isVisible()).toBe(true)
    expect(workbench.paneLayout.editor.state).toBe('expanded')
    expect(workbench.activeActivityId).toBe('app:business-graph')
    expect(wrapper.get('[data-board-card="issue-evidence"]').element).toBe(row.element)
    expect(wrapper.find('[data-workbench-diagnostic]').exists()).toBe(false)

    const file = files.currentFile
    await wrapper.get('[data-inspector-title]').setValue('Review the evidence before the client meeting')
    await wrapper.get('[data-inspector-title]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(document.querySelector('#close-confirm-title')).not.toBeNull()
    document.querySelector('.btn-cancel').click()
    await flushPromises()
    expect(files.currentFile).toBe(file)
    expect(file.dirty).toBe(true)
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Review the evidence before the client meeting')
    expect(wrapper.get('[data-board-card="issue-evidence"]').element).toBe(row.element)

    await wrapper.get('[data-inspector-title]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    document.querySelector('.btn-discard').click()
    await flushPromises()

    expect(files.openFiles.some(file => file.path === path)).toBe(false)
    expect(workbench.activeActivityId).toBe('app:business-graph')
    expect(document.activeElement).toBe(row.element)
  })
})
