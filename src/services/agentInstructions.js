import { invoke } from '@tauri-apps/api/core'
import { normalizeAgentsTemplate } from '../shared/agentInstructions.js'

export function ensureWorkspaceAgentInstructions(workspace, template) {
  return invoke('workspace_agents_ensure', {
    workspace,
    template: normalizeAgentsTemplate(template),
  })
}
