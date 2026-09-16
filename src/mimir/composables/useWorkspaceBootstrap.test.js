import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const graphApi = vi.hoisted(() => ({
  createGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
  listenForGraphChanges: vi.fn(),
  graphDiagnostics: vi.fn(),
  graphEvents: vi.fn(),
}))
const config = vi.hoisted(() => ({
  loadWorkspaceConfig: vi.fn(),
  saveWorkspaceConfig: vi.fn(),
  cachedWorkspaceConfig: vi.fn(),
}))
vi.mock('../../services/businessGraph.js', () => graphApi)
vi.mock('../../services/workspaceConfig.js', () => config)

import { invoke } from '@tauri-apps/api/core'
import { useBusinessGraphStore } from '../../stores/businessGraph.js'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap.js'

const teamRoot = '/home/me/.mimir/team-graph'
const project = { id: 'vandage-engagement', kind: 'project', title: 'Vandage', scopeId: 'team:main' }
const mounted = { scopes: [{ id: 'team:main', kind: 'team', root: teamRoot }], graphRevision: 1 }
const savedConfig = { version: 1, id: 'ws-vandage', project: project.id, graphScope: 'team' }
const controllers = []

function setup(overrides = {}) {
  const settings = {
    recentWorkspaceFolders: [],
    set: vi.fn((key, value) => { settings[key] = value }),
  }
  const workspaceFiles = {
    workspacePath: '/old',
    openWorkspace: vi.fn(async path => { workspaceFiles.workspacePath = path }),
  }
  const editorFiles = { currentFile: null, setWorkspaceScope: vi.fn(), refreshGraphDocuments: vi.fn(async () => {}) }
  const requestWorkspaceSetup = vi.fn(async () => ({ project: project.id, graphScope: 'team' }))
  const diagnostic = { value: '' }
  const bootstrap = useWorkspaceBootstrap({
    settings,
    workbench: { activeActivityId: 'files', selectWorkspaceActivity: vi.fn(), setPaneState: vi.fn() },
    activities: { byId: vi.fn(), visibleActivities: [] },
    activityRuntime: {}, launchers: { byId: vi.fn() }, appsCatalog: {},
    workspaceFiles, editorFiles, toolRuntime: {}, diagnostic, coreActivities: [],
    openCoreActivity: vi.fn(), getFocusOwner: () => 'none', requestWorkspaceSetup,
    ...overrides,
  })
  controllers.push(bootstrap)
  return { bootstrap, workspaceFiles, editorFiles, requestWorkspaceSetup, diagnostic, graph: useBusinessGraphStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  window.__TAURI_INTERNALS__ = {}
  vi.mocked(invoke).mockImplementation(async command => command === 'team_repository_status'
    ? { managed: true, root: teamRoot } : true)
  graphApi.openBusinessGraph.mockResolvedValue(mounted)
  graphApi.queryGraph.mockResolvedValue({ items: [project], total: 1, graphRevision: 1 })
  graphApi.listenForGraphChanges.mockResolvedValue(vi.fn())
  graphApi.graphDiagnostics.mockResolvedValue([])
  graphApi.graphEvents.mockResolvedValue({ items: [], total: 0 })
  graphApi.getGraphNode.mockResolvedValue(project)
  config.loadWorkspaceConfig.mockResolvedValue(null)
  config.saveWorkspaceConfig.mockResolvedValue(savedConfig)
  config.cachedWorkspaceConfig.mockReturnValue(savedConfig)
})
afterEach(() => {
  controllers.splice(0).forEach(bootstrap => bootstrap.dispose())
  delete window.__TAURI_INTERNALS__
})

describe('workspace Graph hydration', () => {
  it('links the current workspace through setup without switching its folder', async () => {
    const { bootstrap, graph, workspaceFiles, requestWorkspaceSetup } = setup()
    await bootstrap.openWorkspace('/new', { activate: false })
    config.loadWorkspaceConfig.mockResolvedValue({ id: 'ws-vandage', graphScope: 'team' })
    requestWorkspaceSetup.mockClear()
    workspaceFiles.openWorkspace.mockClear()
    await bootstrap.configureWorkspace()
    expect(requestWorkspaceSetup).toHaveBeenCalledWith(expect.objectContaining({ path: '/new', projects: [project] }))
    expect(config.saveWorkspaceConfig).toHaveBeenLastCalledWith('/new', { id: 'ws-vandage', project: project.id, graphScope: 'team' })
    expect(graph.workspaceProjectId).toBe(project.id)
    expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
  })

  it('does not apply workspace setup after the active folder changes', async () => {
    const { bootstrap, workspaceFiles, requestWorkspaceSetup } = setup()
    let finish
    requestWorkspaceSetup.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = bootstrap.configureWorkspace()
    await vi.waitFor(() => expect(requestWorkspaceSetup).toHaveBeenCalled())
    workspaceFiles.workspacePath = '/different'
    finish({ project: project.id, graphScope: 'team' })
    await pending
    expect(config.saveWorkspaceConfig).not.toHaveBeenCalled()
  })

  it('adopts the setup mount and hydrates scopes before refreshing Editor documents', async () => {
    const { bootstrap, workspaceFiles, requestWorkspaceSetup, editorFiles, graph } = setup()
    await expect(bootstrap.openWorkspace('/new', { activate: false })).resolves.toBe(true)
    expect(requestWorkspaceSetup).toHaveBeenCalledWith(expect.objectContaining({ path: '/new', projects: [project] }))
    expect(config.saveWorkspaceConfig).toHaveBeenCalledWith('/new', { id: undefined, project: project.id, graphScope: 'team' })
    expect(workspaceFiles.openWorkspace).toHaveBeenCalledWith('/new')
    expect(graphApi.openBusinessGraph.mock.calls).toEqual([['/new']])
    expect(graphApi.listenForGraphChanges).toHaveBeenCalledOnce()
    expect(graph.projectRoot).toBe('/new')
    expect(graph.activeScopeIds).toEqual(['team:main'])
    expect(graph.nodes).toEqual([project])
    expect(editorFiles.refreshGraphDocuments).toHaveBeenCalledOnce()
    expect(graphApi.queryGraph.mock.invocationCallOrder.at(-1)).toBeLessThan(editorFiles.refreshGraphDocuments.mock.invocationCallOrder[0])
  })

  it('hydrates an existing workspace without opening the Graph app or repeating setup', async () => {
    config.loadWorkspaceConfig.mockResolvedValue(savedConfig)
    const { bootstrap, requestWorkspaceSetup, graph, editorFiles } = setup()
    await bootstrap.openWorkspace('/new', { activate: false })
    expect(requestWorkspaceSetup).not.toHaveBeenCalled()
    expect(graphApi.openBusinessGraph).toHaveBeenCalledOnce()
    expect(graph.workspaceProjectId).toBe(project.id)
    expect(editorFiles.refreshGraphDocuments).toHaveBeenCalledOnce()
  })

  it('mounts the new folder after temporary Team setup during creation', async () => {
    const { bootstrap, graph } = setup()
    await bootstrap.openWorkspace('/new', { create: true, activate: false })
    expect(graphApi.openBusinessGraph.mock.calls).toEqual([[teamRoot], ['/new']])
    expect(graph.projectRoot).toBe('/new')
    expect(graphApi.listenForGraphChanges).toHaveBeenCalledOnce()
  })

  it('restores the active graph after cancellation and suppresses temporary source events', async () => {
    const { bootstrap, graph, editorFiles, requestWorkspaceSetup, workspaceFiles } = setup()
    await graph.start('/old')
    const staleChange = graphApi.listenForGraphChanges.mock.calls[0][0]
    let finishSetup
    requestWorkspaceSetup.mockImplementation(() => new Promise(resolve => { finishSetup = resolve }))
    const pending = bootstrap.openWorkspace('/new', { activate: false })
    await vi.waitFor(() => expect(requestWorkspaceSetup).toHaveBeenCalled())
    staleChange({ graphRevision: 2, changedIds: [project.id] })
    graph.changedSources = { graphRevision: 2, changedIds: [project.id] }
    await nextTick()
    expect(editorFiles.refreshGraphDocuments).not.toHaveBeenCalled()
    finishSetup(null)
    expect(await pending).toBe(false)
    expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
    expect(graphApi.openBusinessGraph.mock.calls).toEqual([['/old'], ['/new'], ['/old']])
    expect(graph.projectRoot).toBe('/old')
    expect(editorFiles.refreshGraphDocuments).toHaveBeenCalledOnce()
  })

  it('restores the active mount after setup fails and reports the setup error', async () => {
    const { bootstrap, graph, diagnostic, workspaceFiles, editorFiles } = setup()
    await graph.start('/old')
    config.saveWorkspaceConfig.mockRejectedValueOnce(new Error('Configuration is read-only'))
    expect(await bootstrap.openWorkspace('/new', { activate: false })).toBe(false)
    expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
    expect(graph.projectRoot).toBe('/old')
    expect(graphApi.openBusinessGraph.mock.calls).toEqual([['/old'], ['/new'], ['/old']])
    expect(editorFiles.refreshGraphDocuments).toHaveBeenCalledOnce()
    expect(diagnostic.value).toContain('Configuration is read-only')
  })

  it('forwards ready source changes and stops the listener on disposal', async () => {
    const { bootstrap, graph, editorFiles } = setup()
    await bootstrap.openWorkspace('/new', { activate: false })
    const onChanged = graphApi.listenForGraphChanges.mock.calls[0][0]
    const cleanup = await graphApi.listenForGraphChanges.mock.results[0].value
    const payload = { graphRevision: 2, changedIds: [project.id], changedPaths: ['/team/project.md'] }
    onChanged(payload)
    await nextTick()
    expect(editorFiles.refreshGraphDocuments).toHaveBeenLastCalledWith(payload)
    bootstrap.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
    onChanged({ graphRevision: 3 })
    await nextTick()
    expect(graph.changedSources).toBeNull()
    expect(editorFiles.refreshGraphDocuments).toHaveBeenCalledTimes(2)
  })

  it('does not resume workspace setup after disposal', async () => {
    const { bootstrap, requestWorkspaceSetup, workspaceFiles, editorFiles } = setup()
    let finishSetup
    requestWorkspaceSetup.mockImplementation(() => new Promise(resolve => { finishSetup = resolve }))
    const pending = bootstrap.openWorkspace('/new', { activate: false })
    await vi.waitFor(() => expect(requestWorkspaceSetup).toHaveBeenCalled())
    bootstrap.dispose()
    finishSetup({ project: project.id, graphScope: 'team' })
    expect(await pending).toBe(false)
    expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
    expect(config.saveWorkspaceConfig).not.toHaveBeenCalled()
    expect(graphApi.listenForGraphChanges).not.toHaveBeenCalled()
    expect(editorFiles.refreshGraphDocuments).not.toHaveBeenCalled()
  })

  it('does not revive hydration or source refresh when a native mount finishes after disposal', async () => {
    delete window.__TAURI_INTERNALS__
    const { bootstrap, graph, editorFiles } = setup()
    let finishMount
    graphApi.openBusinessGraph.mockImplementationOnce(() => new Promise(resolve => { finishMount = resolve }))
    const pending = bootstrap.openWorkspace('/new', { activate: false })
    await vi.waitFor(() => expect(graphApi.openBusinessGraph).toHaveBeenCalled())
    bootstrap.dispose()
    finishMount(mounted)
    expect(await pending).toBe(false)
    expect(graph.loading).toBe(false)
    expect(graph.status).toBeNull()
    expect(graphApi.listenForGraphChanges).not.toHaveBeenCalled()
    expect(editorFiles.refreshGraphDocuments).not.toHaveBeenCalled()
  })
})
