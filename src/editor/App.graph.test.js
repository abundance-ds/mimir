import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { startCompletion } from '@codemirror/autocomplete'
import App from './App.vue'
import EditorSurface from './components/workspace/EditorSurface.vue'
import GraphEditorTab from './components/workspace/GraphEditorTab.vue'
import { useFileStore } from '../stores/files.js'
import { useBusinessGraphStore } from '../stores/businessGraph.js'

vi.mock('../services/session.js', () => ({ loadSession: vi.fn(async () => null), saveSession: vi.fn(async () => {}) }))
vi.mock('./nativeMenu.js', () => ({ installNativeEditorMenu: vi.fn(async () => true), shouldInstallNativeEditorMenu: () => false }))
enableAutoUnmount(afterEach)
afterEach(() => { for (const file of useFileStore().openFiles) useFileStore().pauseGraphSave(file) })

const path = '/work/graph/jon.md'
function source(body = 'Working with [Jolo](mimir://graph/jolo).', revision = 'r1', title = 'Jon Minton') {
  const metadata = `---\ntitle: ${title}\nkind: person\n---\n`
  return {
    content: metadata + body,
    sourceRevision: revision,
    bodyFrom: metadata.length,
    node: { id: 'jon', kind: 'person', title, body, summary: '', tags: [], relations: [], properties: {}, provenance: { sourcePath: path, scopeId: 'team:main', sourceRevision: revision } },
  }
}

let disk
beforeEach(() => {
  disk = source()
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'graph_get') return args.id === 'jon' ? disk.node : null
    if (command === 'graph_source') return args.path === path ? structuredClone(disk) : null
    if (command === 'read_text_file') return { content: args.path === path ? disk.content : 'Ordinary note' }
    if (command === 'graph_lookup') return [{ id: 'jolo', title: 'Jolo', kind: 'company', scopeId: 'team:main' }]
    if (command === 'graph_link_targets') return (args.ids || []).map(id => ({ id, title: 'Jolo', status: 'resolved' }))
    if (command === 'graph_neighbors') return []
    if (command === 'graph_references') return { outgoing: [], incoming: [] }
    if (command === 'graph_update') {
      expect(args.patch.expectedSourcePath).toBe(path)
      expect(args.patch.expectedRevision).toBe(disk.sourceRevision)
      disk = source(args.patch.body, 'r2', args.patch.title)
      return structuredClone(disk.node)
    }
    if (command === 'graph_source_save') {
      expect(args.request.expectedRevision).toBe(disk.sourceRevision)
      disk = { ...disk, content: args.request.content, sourceRevision: 'r3' }
      return structuredClone(disk)
    }
    return null
  })
  const graph = useBusinessGraphStore()
  graph.status = { graphRevision: 1, scopes: [{ id: 'team:main', kind: 'team', root: '/work' }] }
  graph.activeScopeIds = ['team:main']
  graph.nodes = [{ id: 'jon', kind: 'person', title: disk.node.title, scopeId: 'team:main', sourceRevision: 'r1' }]
})

async function editor(props = {}) {
  const wrapper = mount(App, {
    props: { embedded: true, ...props },
    global: { stubs: { AppHeader: true, AppFooter: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true } },
  })
  await flushPromises()
  return wrapper
}

describe('Graph entry Editor tabs', () => {
  it('opens a listed entry with one native source read and revisits its exact draft without open-path IPC', async () => {
    const wrapper = await editor()
    vi.mocked(invoke).mockClear()
    await wrapper.vm.mimirOpenGraph('jon')
    const openCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => ['graph_get', 'graph_source'].includes(command))
    expect(openCalls().map(([command]) => command)).toEqual(['graph_source'])
    const file = useFileStore().currentFile
    await wrapper.get('[data-inspector-title]').setValue('Keep the current draft')
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    vi.mocked(invoke).mockClear()
    await wrapper.vm.mimirOpenGraph('jon')
    expect(openCalls()).toEqual([])
    expect(useFileStore().currentFile).toBe(file)
    expect(file.graph.draft.title).toBe('Keep the current draft')
    expect(file.graph.sourceRevision).toBe('r1')
  })

  it('uses the native node lookup for a link target outside the loaded summaries', async () => {
    const wrapper = await editor()
    useBusinessGraphStore().nodes = []
    vi.mocked(invoke).mockClear()
    await wrapper.vm.mimirOpenGraph('jon')
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => ['graph_get', 'graph_source'].includes(command)).map(([command]) => command))
      .toEqual(['graph_get', 'graph_source'])
  })

  it('revisits a dirty Graph tab while its save is still pending', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const files = useFileStore()
    const file = files.currentFile
    await wrapper.get('[data-inspector-title]').setValue('Saving this title')
    let finish
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_update'
      ? new Promise(resolve => { finish = () => resolve(normalInvoke(command, args)) }) : normalInvoke(command, args))
    const saving = files.save(file)
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    vi.mocked(invoke).mockClear()
    await wrapper.vm.mimirOpenGraph('jon')
    expect(files.currentFile).toBe(file)
    expect(file.saveState).toBe('saving')
    expect(vi.mocked(invoke).mock.calls.some(([command]) => ['graph_get', 'graph_source'].includes(command))).toBe(false)
    finish()
    await saving
    expect(file.dirty).toBe(false)
  })

  it.each(['unavailable', 'read error'])('recovers a moved source through native lookup when the listed path returns %s', async failure => {
    const wrapper = await editor()
    const moved = structuredClone(disk)
    moved.node.provenance.sourcePath = '/team/graph/jon.md'
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'graph_get') return moved.node
      if (command === 'graph_source') {
        if (args.path === moved.node.provenance.sourcePath) return moved
        return failure === 'read error' ? Promise.reject(new Error('Source moved during read')) : null
      }
      return normalInvoke(command, args)
    })
    vi.mocked(invoke).mockClear()
    await wrapper.vm.mimirOpenGraph('jon')
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => ['graph_get', 'graph_source'].includes(command)))
      .toEqual([['graph_source', { path }], ['graph_get', { id: 'jon' }], ['graph_source', { path: '/team/graph/jon.md' }]])
    expect(useFileStore().currentFile.path).toBe('/team/graph/jon.md')
  })

  it('preserves the source read error when native lookup confirms the same path', async () => {
    const wrapper = await editor()
    const failure = new Error('Source permission denied')
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source' ? Promise.reject(failure) : normalInvoke(command, args))
    await expect(wrapper.vm.mimirOpenGraph('jon')).rejects.toBe(failure)
  })

  it('does not reuse a same-id draft from another mounted root', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const previous = useFileStore().currentFile
    await wrapper.get('[data-inspector-title]').setValue('Previous root draft')
    const moved = structuredClone(disk)
    moved.node.provenance.sourcePath = '/next/graph/jon.md'
    moved.node.title = 'Current root entry'
    moved.node.provenance.scopeId = 'project:next'
    const graph = useBusinessGraphStore()
    graph.status = { graphRevision: 1, scopes: [{ id: 'project:next', kind: 'project', root: '/next' }] }
    graph.nodes = [{ id: 'jon', kind: 'person', scopeId: 'project:next' }]
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source' && args.path === '/next/graph/jon.md' ? moved : normalInvoke(command, args))
    await wrapper.vm.mimirOpenGraph('jon')
    expect(useFileStore().currentFile.path).toBe('/next/graph/jon.md')
    expect(useFileStore().currentFile).not.toBe(previous)
    expect(previous.graph.draft.title).toBe('Previous root draft')
    expect(previous.dirty).toBe(true)
  })

  it('never opens a hinted source with the wrong native node identity', async () => {
    const wrapper = await editor()
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source'
      ? { ...disk, node: { ...disk.node, id: 'another-entry' } } : normalInvoke(command, args))
    await expect(wrapper.vm.mimirOpenGraph('jon')).rejects.toThrow('unavailable')
    expect(useFileStore().openFiles.some(file => file.graph)).toBe(false)
  })

  it('closes clean Details through the normal tab guard and requests Graph focus', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    wrapper.findComponent(GraphEditorTab).vm.$emit('closeRequest')
    await flushPromises()
    expect(useFileStore().openFiles.some(file => file.path === path)).toBe(false)
    expect(wrapper.emitted('focusGraph')).toEqual([[{ id: 'jon' }]])
  })

  it('keeps a dirty Details draft after close cancellation and only returns focus after confirmed close', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const file = useFileStore().currentFile
    await wrapper.get('[data-inspector-title]').setValue('Keep until confirmed')
    wrapper.findComponent(GraphEditorTab).vm.$emit('closeRequest')
    await flushPromises()
    expect(document.querySelector('#close-confirm-title')).not.toBeNull()
    document.querySelector('.btn-cancel').click()
    await flushPromises()
    expect(useFileStore().currentFile).toBe(file)
    expect(file.graph.draft.title).toBe('Keep until confirmed')
    expect(wrapper.emitted('focusGraph')).toBeUndefined()
    wrapper.findComponent(GraphEditorTab).vm.$emit('closeRequest')
    await flushPromises()
    document.querySelector('.btn-discard').click()
    await flushPromises()
    expect(useFileStore().openFiles.includes(file)).toBe(false)
    expect(wrapper.emitted('focusGraph')).toEqual([[{ id: 'jon' }]])
  })

  it('keeps Details open while a source review response is pending', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const file = useFileStore().currentFile
    file.reviewPending = true
    wrapper.findComponent(GraphEditorTab).vm.$emit('closeRequest')
    await flushPromises()
    expect(useFileStore().currentFile).toBe(file)
    expect(wrapper.emitted('focusGraph')).toBeUndefined()
  })

  it('keeps one rich draft when its entry or source is opened again', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const files = useFileStore()
    const file = files.currentFile
    expect(file.kind).toBe('graph')
    await wrapper.get('[data-inspector-title]').setValue('Jon — current draft')
    await wrapper.vm.mimirOpenGraph('jon')
    await wrapper.vm.mimirOpen(path)
    expect(files.currentFile).toBe(file)
    expect(files.openFiles.filter(file => file.path === path)).toHaveLength(1)
    expect(file.kind).toBe('graph')
    expect(file.graph.draft.title).toBe('Jon — current draft')
    expect(file.preview).toBe(false)
    expect(wrapper.vm.mimirActive().cursor).toBeNull()
    expect(() => wrapper.vm.mimirSetContent('Hidden overwrite')).toThrow(/Source/)
    expect(file.graph.draft.title).toBe('Jon — current draft')
  })

  it('clears entry History when a clean preview is reused for another entry', async () => {
    const second = source('', 'company-r1', 'Jolo')
    second.node.id = 'jolo'
    second.node.kind = 'company'
    second.node.provenance.sourcePath = '/work/graph/jolo.md'
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'graph_get' && args.id === 'jolo') return second.node
      if (command === 'graph_source' && args.path === second.node.provenance.sourcePath) return structuredClone(second)
      if (command === 'git_file_history_available') return true
      if (command === 'git_file_history') return [{ hash: 'old-jon-version', message: 'Saved Jon', authoredAt: '' }]
      return normalInvoke(command, args)
    })
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const previewId = useFileStore().currentFile.id
    await wrapper.get('[data-graph-control="focus-more"]').trigger('click')
    await wrapper.get('[data-inspector-file-history]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Saved Jon')
    await wrapper.vm.mimirOpenGraph('jolo')
    expect(useFileStore().currentFile.id).toBe(previewId)
    expect(wrapper.get('[data-inspector-title]').element.value).toBe('Jolo')
    expect(wrapper.find('[data-inspector-file-history-panel]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Saved Jon')
  })

  it('ignores a slow Graph open after a later file navigation', async () => {
    const wrapper = await editor()
    let finish
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source' && args.path === path
      ? new Promise(resolve => { finish = resolve }) : normalInvoke(command, args))
    const pending = wrapper.vm.mimirOpenGraph('jon')
    await flushPromises()
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    finish(structuredClone(disk))
    await pending
    expect(useFileStore().currentFile.path).toBe('/work/ordinary.md')
    expect(wrapper.findComponent(GraphEditorTab).exists()).toBe(false)
  })

  it('ignores a slow hinted source after the workspace changes', async () => {
    const wrapper = await editor()
    let finish
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source' && args.path === path
      ? new Promise(resolve => { finish = resolve }) : normalInvoke(command, args))
    const pending = wrapper.vm.mimirOpenGraph('jon')
    await flushPromises()
    await wrapper.setProps({ workspacePath: '/next', workspacePaths: ['/work', '/next'] })
    finish(structuredClone(disk))
    expect(await pending).toBeNull()
    expect(useFileStore().openFiles.some(file => file.path === path)).toBe(false)
  })

  it.each(['graph_source', 'graph_get'])('ignores a late %s error after another navigation', async commandToDelay => {
    const wrapper = await editor()
    if (commandToDelay === 'graph_get') useBusinessGraphStore().nodes = []
    let reject
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === commandToDelay
      ? new Promise((_resolve, fail) => { reject = fail }) : normalInvoke(command, args))
    const opening = wrapper.vm.mimirOpenGraph('jon')
    await flushPromises()
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    reject(new Error('Old source could not be read'))
    expect(await opening).toBeNull()
    expect(useFileStore().currentFile.path).toBe('/work/ordinary.md')
    expect(wrapper.emitted('diagnostic')).toBeUndefined()
  })

  it('returns cancellation when navigation changes after the Graph tab is selected', async () => {
    const navigate = vi.fn()
    const wrapper = await editor({ onNavigateEditor: navigate })
    let laterNavigation
    navigate.mockImplementationOnce(() => { laterNavigation = wrapper.vm.mimirOpen('/work/ordinary.md') })
    expect(await wrapper.vm.mimirOpenGraph('jon')).toBeNull()
    await laterNavigation
    expect(useFileStore().currentFile.path).toBe('/work/ordinary.md')
  })

  it.each(['reveal', 'cycle'])('ignores a slow Graph open after %s selects an existing tab', async navigation => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpen('/work/first.md')
    await wrapper.vm.mimirOpen('/work/second.md')
    let finish
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_source' && args.path === path
      ? new Promise(resolve => { finish = resolve }) : normalInvoke(command, args))
    const pending = wrapper.vm.mimirOpenGraph('jon')
    await flushPromises()
    if (navigation === 'reveal') await wrapper.vm.mimirReveal({ path: '/work/first.md' })
    else expect(wrapper.vm.mimirCycleTab(-1)).toBe(true)
    expect(useFileStore().currentFile.path).toBe('/work/first.md')
    finish(structuredClone(disk))
    await pending
    expect(useFileStore().currentFile.path).toBe('/work/first.md')
    expect(wrapper.findComponent(GraphEditorTab).exists()).toBe(false)
  })

  it('retains working-note undo, caret, and scroll when a tab is revisited', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const original = disk.node.body
    let view = EditorView.findFromDOM(wrapper.get('[data-graph-markdown-editor] .cm-editor').element)
    view.focus()
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' More context.' }, selection: { anchor: 4 }, userEvent: 'input.type' })
    await flushPromises()
    wrapper.get('.focus-scroll').element.scrollTop = 155
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    await wrapper.vm.mimirOpenGraph('jon')
    view = EditorView.findFromDOM(wrapper.get('[data-graph-markdown-editor] .cm-editor').element)
    expect(view.state.doc.toString()).toBe(original + ' More context.')
    expect(view.state.selection.main.anchor).toBe(4)
    expect(wrapper.get('.focus-scroll').element.scrollTop).toBe(155)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(original)
  })

  it('saves Details through Rust before showing Source in the same tab', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const file = useFileStore().currentFile
    await wrapper.get('[data-inspector-title]').setValue('Jon updated')
    await wrapper.get('[data-graph-control="entry-source"]').trigger('click')
    await flushPromises()
    expect(useFileStore().currentFile).toBe(file)
    expect(file.kind).toBe('text')
    expect(file.dirty).toBe(false)
    expect(file.content).toContain('title: Jon updated')
    expect(file.graph.sourceRevision).toBe('r2')
    expect(wrapper.findComponent(GraphEditorTab).exists()).toBe(false)
    expect(wrapper.get('.graph-source-header').text()).toContain('Source')
  })

  it('keeps a failed rich save and its draft in Details', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    const normalInvoke = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_update' ? Promise.reject(new Error('Source conflict')) : normalInvoke(command, args))
    await wrapper.get('[data-inspector-title]').setValue('Keep this draft')
    await wrapper.get('[data-graph-control="entry-source"]').trigger('click')
    await flushPromises()
    const file = useFileStore().currentFile
    expect(file.kind).toBe('graph')
    expect(file.graph.draft.title).toBe('Keep this draft')
    expect(file.dirty).toBe(true)
    expect(wrapper.text()).toContain('Source conflict')
  })

  it('enables @ in the Graph body and excludes frontmatter and ordinary Markdown', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpen('/work/ordinary.md')
    let view = wrapper.findComponent(EditorSurface).vm.getView()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '@jo' }, selection: { anchor: 3 } })
    startCompletion(view)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'graph_lookup')).toHaveLength(0)

    await wrapper.vm.mimirOpenGraph('jon')
    await wrapper.get('[data-graph-control="entry-source"]').trigger('click')
    await flushPromises()
    view = wrapper.findComponent(EditorSurface).vm.getView()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '---\ntitle: @jo\n---\n@jo' }, selection: { anchor: 13 } })
    startCompletion(view)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'graph_lookup')).toHaveLength(0)
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    startCompletion(view)
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'graph_lookup')).toBe(true))
    expect(vi.mocked(invoke).mock.calls.find(([command]) => command === 'graph_lookup')[1].scopeIds).toEqual(['team:main'])
  })

  it('uses one link renderer with live preview in Graph Source', async () => {
    const wrapper = await editor()
    await wrapper.vm.mimirOpenGraph('jon')
    await wrapper.get('[data-graph-control="entry-source"]').trigger('click')
    await flushPromises()
    const view = wrapper.findComponent(EditorSurface).vm.getView()
    expect(view.dom.querySelectorAll('[data-graph-target="jolo"]')).toHaveLength(1)
    expect(view.dom.querySelectorAll('.cm-lp-link')).toHaveLength(0)
  })
})
