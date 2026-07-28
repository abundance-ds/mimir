import { invoke } from '@tauri-apps/api/core'

const FALLBACK_PRESETS = Object.freeze([
  { id: 'codex', title: 'Codex', kind: 'agent', agentId: 'codex', enabled: true, args: [], env: {}, cwd: { mode: 'workspace' } },
  { id: 'claude', title: 'Claude', kind: 'agent', agentId: 'claude', enabled: true, args: [], env: {}, cwd: { mode: 'workspace' } },
  { id: 'pi', title: 'Pi', kind: 'agent', agentId: 'pi', enabled: true, args: [], env: {}, cwd: { mode: 'workspace' } },
  { id: 'terminal', title: 'Terminal', kind: 'terminal', enabled: true, args: [], env: {}, cwd: { mode: 'workspace' } },
])

export async function detectAgents() {
  if (!window.__TAURI_INTERNALS__) {
    return [
      { id: 'codex', title: 'Codex', binary: 'codex', resumeStrategy: 'codex', installed: false, diagnostic: 'Agent detection is available in the desktop app.' },
      { id: 'claude', title: 'Claude', binary: 'claude', resumeStrategy: 'claude', installed: false, diagnostic: 'Agent detection is available in the desktop app.' },
      { id: 'pi', title: 'Pi', binary: 'pi', resumeStrategy: 'pi', installed: false, diagnostic: 'Agent detection is available in the desktop app.' },
    ]
  }
  return invoke('launcher_detect_agents')
}

export async function loadLauncherConfig() {
  if (!window.__TAURI_INTERNALS__) {
    return { path: '~/.mimir/launchers.json', presets: structuredClone(FALLBACK_PRESETS), diagnostic: null }
  }
  return invoke('launcher_load_config')
}

export async function saveLauncherConfig(presets) {
  if (!window.__TAURI_INTERNALS__) return
  await invoke('launcher_save_config', { presets })
}
