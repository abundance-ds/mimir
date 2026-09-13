import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import GraphEditorTab from './GraphEditorTab.vue'
import GraphInspector from '../../../mimir/apps/business-graph/GraphInspector.vue'
import GraphConfirmDialog from '../../../mimir/apps/business-graph/GraphConfirmDialog.vue'
import { useFileStore } from '../../../stores/files.js'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'

enableAutoUnmount(afterEach)
const source = {
  content: '---\ntitle: Plan\nkind: issue\n---\nWorking note', sourceRevision: 'r1', bodyFrom: 32,
  node: { id: 'plan', kind: 'issue', title: 'Plan', body: 'Working note', tags: [], properties: { status: 'plan' }, relations: [{ relation: 'part_of', target: 'project-a' }], provenance: { sourcePath: '/team/graph/plan.md', scopeId: 'team:main', sourceRevision: 'r1' } },
}
async function setup() {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'workspace_project_file_resolve') return '/project-a/outputs/report.md'
    if (command === 'graph_source') return structuredClone(source)
    if (command === 'graph_neighbors') return []
    return null
  })
  const graph = useBusinessGraphStore()
  graph.projectRoot = '/current-workspace'
  const files = useFileStore()
  const file = await files.openGraphDocument(source)
  const wrapper = mount(GraphEditorTab, { props: { file }, global: { stubs: { GraphInspector: true, GraphCreateDialog: true, GraphConfirmDialog: true } } })
  await flushPromises()
  return { wrapper, file, files, graph }
}

describe('Graph document actions', () => {
  it('resolves relative resources in the entry Project and scope', async () => {
    const { wrapper } = await setup()
    wrapper.findComponent(GraphInspector).vm.$emit('openFile', { path: 'outputs/report.md', nodeId: 'plan' })
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('workspace_project_file_resolve', {
      projectId: 'project-a', scopeId: 'team:main', relativePath: 'outputs/report.md', fallbackWorkspace: '/current-workspace',
    })
    expect(wrapper.emitted('openFile')).toEqual([[{ path: '/project-a/outputs/report.md', nodeId: 'plan' }]])
  })

  it('keeps saved History requests distinct from a Source view change', async () => {
    const { wrapper, file } = await setup()
    wrapper.findComponent(GraphInspector).vm.$emit('openFile', { path: file.path })
    expect(wrapper.emitted('source')).toHaveLength(1)
    const request = { path: file.path, history: { hash: 'version-a' } }
    wrapper.findComponent(GraphInspector).vm.$emit('openFile', request)
    expect(wrapper.emitted('openFile')).toEqual([[request]])
  })

  it('binds confirmed deletion to the source path and revision before closing the tab', async () => {
    const { wrapper, file, graph, files } = await setup()
    const remove = vi.spyOn(graph, 'remove').mockResolvedValue({ undoToken: 'undo' })
    wrapper.findComponent(GraphInspector).vm.$emit('delete')
    await flushPromises()
    wrapper.findComponent(GraphConfirmDialog).vm.$emit('confirm')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('plan', 'r1', '/team/graph/plan.md')
    expect(files.openFiles).not.toContain(file)
  })
})
