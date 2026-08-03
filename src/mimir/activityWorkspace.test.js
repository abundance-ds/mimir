import { describe, expect, it } from 'vitest'
import {
  activityIsVisibleInWorkspace,
  activityWorkspacePath,
  normalizedWorkspacePath,
} from './activityWorkspace.js'

const presets = new Map([
  ['project-agent', { cwd: { mode: 'workspace' } }],
  ['home-agent', { cwd: { mode: 'home' } }],
  ['custom-agent', { cwd: { mode: 'custom', path: '/tools' } }],
])
const findPreset = id => presets.get(id) || null

describe('Activity workspace projection', () => {
  it('groups workspace launchers by normalized project path', () => {
    const activity = record({ presetId: 'project-agent', workspacePath: '/work/alpha/' })

    expect(activityWorkspacePath(activity, findPreset)).toBe('/work/alpha')
    expect(activityIsVisibleInWorkspace(activity, '/work/alpha', findPreset)).toBe(true)
    expect(activityIsVisibleInWorkspace(activity, '/work/beta', findPreset)).toBe(false)
  })

  it('keeps home, custom, and direct process App Activities global', () => {
    expect(activityWorkspacePath(record({ presetId: 'home-agent' }), findPreset)).toBe('')
    expect(activityWorkspacePath(record({ presetId: 'custom-agent' }), findPreset)).toBe('')
    expect(activityWorkspacePath(record({ appId: 'exporter' }), findPreset)).toBe('')
    expect(activityIsVisibleInWorkspace(record({ presetId: 'home-agent' }), '/work/beta', findPreset)).toBe(true)
  })

  it('uses workspacePath for legacy execution records whose preset is unavailable', () => {
    const activity = record({ presetId: 'removed-preset', workspacePath: '\\work\\legacy\\' })

    expect(activityWorkspacePath(activity, findPreset)).toBe('/work/legacy')
    expect(normalizedWorkspacePath(' /work/legacy/ ')).toBe('/work/legacy')
  })

  it('keeps the launch-time scope when launcher policy changes later', () => {
    const projectActivity = record({
      presetId: 'home-agent',
      workspaceScope: 'workspace',
    })
    const globalActivity = record({
      presetId: 'project-agent',
      workspaceScope: 'global',
    })

    expect(activityWorkspacePath(projectActivity, findPreset)).toBe('/work/alpha')
    expect(activityWorkspacePath(globalActivity, findPreset)).toBe('')
  })
})

function record({ presetId, appId, workspacePath = '/work/alpha', workspaceScope } = {}) {
  return {
    kind: 'agent',
    workspacePath,
    source: {
      ...(presetId ? { presetId } : {}),
      ...(appId ? { appId } : {}),
      ...(workspaceScope ? { workspaceScope } : {}),
    },
  }
}
