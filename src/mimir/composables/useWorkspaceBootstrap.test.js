import { describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({
  createGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  openBusinessGraph: vi.fn(),
  queryGraph: vi.fn(),
}))
const config = vi.hoisted(() => ({
  loadWorkspaceConfig: vi.fn(),
  saveWorkspaceConfig: vi.fn(),
}))

vi.mock('../../services/businessGraph.js', () => graph)
vi.mock('../../services/workspaceConfig.js', () => config)

import { invoke } from '@tauri-apps/api/core'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap.js'

describe('workspace bootstrap graph configuration', () => {
  it('configures an unknown workspace once before opening it', async () => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'team_repository_status') {
        return { managed: true, root: '/home/me/.mimir/team-graph' }
      }
      return true
    })
    graph.openBusinessGraph.mockResolvedValue({})
    graph.queryGraph.mockResolvedValue({
      items: [{ id: 'vandage-engagement', kind: 'project', title: 'Vandage' }],
    })
    config.loadWorkspaceConfig.mockResolvedValue(null)
    config.saveWorkspaceConfig.mockResolvedValue({
      version: 1,
      id: 'ws-vandage',
      project: 'vandage-engagement',
      graphScope: 'team',
    })
    const requestWorkspaceSetup = vi.fn().mockResolvedValue({
      project: 'vandage-engagement',
      graphScope: 'team',
    })
    const settings = {
      recentWorkspaceFolders: [],
      set: vi.fn((key, value) => { settings[key] = value }),
    }
    const workspaceFiles = {
      workspacePath: '/old',
      openWorkspace: vi.fn(async path => { workspaceFiles.workspacePath = path }),
    }
    const workbench = {
      activeActivityId: 'files',
      resetActivityHistory: vi.fn(),
      setPaneState: vi.fn(),
    }
    const bootstrap = useWorkspaceBootstrap({
      settings,
      workbench,
      activities: { byId: vi.fn(), visibleActivities: [] },
      activityRuntime: {},
      launchers: { byId: vi.fn() },
      appsCatalog: {},
      workspaceFiles,
      editorFiles: { currentFile: null, setWorkspaceScope: vi.fn() },
      toolRuntime: {},
      diagnostic: { value: '' },
      coreActivities: [],
      openCoreActivity: vi.fn(),
      getFocusOwner: () => 'none',
      requestWorkspaceSetup,
    })

    await expect(bootstrap.openWorkspace('/new', { activate: false })).resolves.toBe(true)

    expect(requestWorkspaceSetup).toHaveBeenCalledWith(expect.objectContaining({
      path: '/new',
      projects: [expect.objectContaining({ id: 'vandage-engagement' })],
    }))
    expect(config.saveWorkspaceConfig).toHaveBeenCalledWith('/new', {
      id: undefined,
      project: 'vandage-engagement',
      graphScope: 'team',
    })
    expect(workspaceFiles.openWorkspace).toHaveBeenCalledWith('/new')
    expect(graph.openBusinessGraph).toHaveBeenNthCalledWith(1, '/new')
    expect(graph.openBusinessGraph).toHaveBeenNthCalledWith(2, '/new')
    bootstrap.dispose()
    delete window.__TAURI_INTERNALS__
  })
})
