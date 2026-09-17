import { effectScope, reactive, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGraphNavigation } from './useGraphNavigation.js'

const scopes = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function setup() {
  const graph = reactive({
    loading: false,
    openNode: vi.fn(),
    setSection: vi.fn(),
    setView: vi.fn(),
    toggleScope: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  })
  const openGraphNode = vi.fn(), diagnostic = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  const navigation = scope.run(() => useGraphNavigation({
    graph, root: ref(null), workspaceSurface: ref(null), appHeader: ref(null),
    diagnostic, openGraphNode,
  }))
  return { graph, openGraphNode, diagnostic, navigation }
}

describe('Graph projection navigation', () => {
  it('requests an Editor document without loading a nested inspector', () => {
    const { navigation, graph, openGraphNode } = setup()
    navigation.openNode('jon')
    expect(openGraphNode).toHaveBeenCalledWith({ id: 'jon' })
    expect(graph.openNode).not.toHaveBeenCalled()
  })

  it('retains backlink selection metadata for the document owner', () => {
    const { navigation, openGraphNode } = setup()
    const request = { id: 'source', targetId: 'jon', sourceRevision: 'source-1', from: 10, to: 30 }
    navigation.openNode(request)
    expect(openGraphNode).toHaveBeenCalledWith(request)
    navigation.openNode(null)
    navigation.openNode('')
    expect(openGraphNode).toHaveBeenCalledOnce()
  })

  it('reconciles the projection on explicit Refresh', async () => {
    const { navigation, graph, diagnostic } = setup()
    navigation.refresh()
    expect(graph.refresh).toHaveBeenCalledWith({ reconcile: true })
    graph.refresh.mockRejectedValueOnce(new Error('Index unavailable'))
    navigation.refresh()
    await Promise.resolve()
    expect(diagnostic).toHaveBeenCalledWith('Index unavailable')
  })

  it('keeps section, view, and scope controls in the projection', async () => {
    const { navigation, graph, diagnostic } = setup()
    navigation.setSection('work')
    navigation.setSection('all')
    expect(graph.setSection).toHaveBeenLastCalledWith('all')
    navigation.setView('list')
    expect(graph.setView).toHaveBeenCalledWith('list')
    graph.toggleScope.mockRejectedValueOnce(new Error('Scope unavailable'))
    navigation.toggleScope('team:main')
    await Promise.resolve()
    expect(graph.toggleScope).toHaveBeenCalledWith('team:main')
    expect(diagnostic).toHaveBeenCalledWith('Scope unavailable')
  })
})
