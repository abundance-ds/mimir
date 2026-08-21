import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('workspace configuration service', () => {
  beforeEach(() => invoke.mockReset())

  it('normalizes and saves one Project association', async () => {
    invoke.mockResolvedValue({ id: 'ws-1', project: 'vandage', graphScope: 'team' })
    const { saveWorkspaceConfig } = await import('./workspaceConfig.js')

    await saveWorkspaceConfig('/work/vandage', {
      id: ' ws-1 ',
      projectId: ' vandage ',
      graphScope: 'team',
    })

    expect(invoke).toHaveBeenCalledWith('workspace_config_save', {
      workspace: '/work/vandage',
      config: { id: 'ws-1', project: 'vandage', graphScope: 'team' },
    })
  })

  it('defaults invalid scope values to Team and omits an empty Project', async () => {
    invoke.mockResolvedValue({ id: 'ws-2', graphScope: 'team' })
    const { saveWorkspaceConfig } = await import('./workspaceConfig.js')

    await saveWorkspaceConfig('/work/home', { project: ' ', graphScope: 'private' })

    expect(invoke).toHaveBeenCalledWith('workspace_config_save', {
      workspace: '/work/home',
      config: { graphScope: 'team' },
    })
  })

  it('does not call native resolution without a Project id', async () => {
    const { projectWorkspacePaths } = await import('./workspaceConfig.js')
    await expect(projectWorkspacePaths('')).resolves.toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
})
