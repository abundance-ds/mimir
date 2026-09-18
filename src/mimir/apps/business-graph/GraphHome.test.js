import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import GraphHome from './GraphHome.vue'

let graph, wrapper
const atlas = { id: 'atlas', kind: 'project', title: 'Atlas', body: 'Atlas brief.\n\n## Resources\n\n- [Model](models/base.xlsx)',
  properties: { projectStatus: 'active' }, provenance: { scopeId: 'team', sourcePath: '/team/graph/atlas.md' } }
const beta = { ...atlas, id: 'beta', title: 'Beta', body: 'Beta brief.' }
beforeEach(() => {
  setActivePinia(createPinia())
  graph = useBusinessGraphStore()
  graph.projectRoot = '/workspace'
  graph.nodes = [atlas, beta]
  graph.workspaceProjectId = 'atlas'
  graph.workspaceProject = atlas
  graph.status = { scopes: [{ id: 'team', kind: 'team' }], graphRevision: 1 }
  graph.activeScopeIds = ['team']
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'graph_get') return structuredClone(args.id === 'atlas' ? atlas : beta)
    if (command === 'graph_query') return { items: [], total: 0, graphRevision: 1 }
    if (command === 'workspace_project_file_resolve') return '/workspace/models/base.xlsx'
    return []
  })
})
afterEach(() => { wrapper?.unmount(); graph.stop(); vi.restoreAllMocks() })

describe('Home in Main', () => {
  it('shows the workspace Project without opening a document and switches Projects directly', async () => {
    wrapper = mount(GraphHome)
    await flushPromises()
    expect(wrapper.text()).toContain('Atlas brief.')
    expect(wrapper.emitted('openNode')).toBeUndefined()
    await wrapper.get('[data-home-project]').trigger('click')
    expect(document.querySelector('[data-graph-select-option]').dataset.graphSelectOption).toBe('atlas')
    document.querySelector('[data-graph-select-option="beta"]').click()
    await flushPromises()
    expect(wrapper.text()).toContain('Beta brief.')
    expect(wrapper.text()).not.toContain('Atlas brief.')
    expect(wrapper.emitted('openNode')).toBeUndefined()
    graph.projectRoot = '/another-workspace'
    await flushPromises()
    expect(wrapper.text()).toContain('Atlas brief.')
    expect(graph.homeProjectId).toBe('')
  })

  it('ignores a late Project result and retries a failed read', async () => {
    let finish
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    wrapper = mount(GraphHome)
    graph.homeProjectId = 'beta'
    await flushPromises()
    finish(atlas)
    await flushPromises()
    expect(wrapper.text()).toContain('Beta brief.')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Project read failed'))
    graph.status.graphRevision++
    await flushPromises()
    expect(wrapper.text()).toContain('Project read failed')
    expect(wrapper.text()).toContain('Beta brief.')
    await wrapper.get('[data-graph-control="home-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Project read failed')
  })

  it('resolves Project files and opens Work after including the source scope', async () => {
    wrapper = mount(GraphHome)
    await flushPromises()
    await wrapper.get('.project-resource-link').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('workspace_project_file_resolve', {
      projectId: 'atlas', scopeId: 'team', relativePath: 'models/base.xlsx', fallbackWorkspace: '/workspace',
    })
    expect(wrapper.emitted('openFile')).toEqual([[{ path: '/workspace/models/base.xlsx' }]])
    graph.activeScopeIds = ['other']
    const toggle = vi.spyOn(graph, 'toggleScope').mockImplementation(async () => {
      graph.activeScopeIds = ['other', 'team']
      graph.status.graphRevision++
      await flushPromises()
    })
    await wrapper.get('[data-graph-control="project-open-work"]').trigger('click')
    await flushPromises()
    expect(toggle).toHaveBeenCalledWith('team')
    expect(graph.requestedProjectWork.id).toBe('atlas')
    expect(wrapper.emitted('openNode')).toBeUndefined()
  })
})
