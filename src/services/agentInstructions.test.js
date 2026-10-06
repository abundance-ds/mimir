import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { AGENTS_STARTER } from '../shared/agentInstructions.js'
import { ensureWorkspaceAgentInstructions } from './agentInstructions.js'

describe('project instruction service', () => {
  it('passes the selected template and preserves the native creation result', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ created: true })
    await expect(ensureWorkspaceAgentInstructions('/project', 'Custom\n')).resolves.toEqual({ created: true })
    expect(invoke).toHaveBeenLastCalledWith('workspace_agents_ensure', {
      workspace: '/project', template: 'Custom\n',
    })
  })

  it('uses the shared default when no valid template is supplied', async () => {
    await ensureWorkspaceAgentInstructions('/project')
    expect(invoke).toHaveBeenLastCalledWith('workspace_agents_ensure', {
      workspace: '/project', template: AGENTS_STARTER,
    })
  })
})
