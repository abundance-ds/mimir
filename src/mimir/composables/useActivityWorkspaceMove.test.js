import { describe, expect, it, vi } from 'vitest'
import { useActivityWorkspaceMove } from './useActivityWorkspaceMove.js'

function setup() {
  const original = { id: 'a', kind: 'agent', title: 'Work', source: { presetId: 'codex' }, host: { type: 'pty', resumeStrategy: 'codex' } }
  const dependencies = {
    activities: { byId: id => id === 'a' ? original : null },
    activityRuntime: { moveToWorkspace: vi.fn(async (_preset, id, _path, options) => await options.beforeStop() ? { ...original, id } : null) },
    launchers: { byId: vi.fn(() => ({ id: 'codex' })) },
    openWorkspace: vi.fn(async () => true),
    selectActivity: vi.fn(),
    reconcileWorkspaces: vi.fn(),
  }
  return { ...dependencies, controller: useActivityWorkspaceMove(dependencies) }
}

describe('workspace move controller', () => {
  it('opens the destination before stopping, then selects the same Activity', async () => {
    const state = setup()
    state.controller.show('a')
    expect(state.reconcileWorkspaces).toHaveBeenCalledOnce()
    await state.controller.move('/new')
    expect(state.openWorkspace).toHaveBeenCalledWith('/new', { activate: false })
    expect(state.selectActivity).toHaveBeenCalledWith('a')
    expect(state.controller.activity.value).toBeNull()
    expect(state.controller.busy.value).toBe(false)
  })
  it('keeps the dialog open when workspace setup is cancelled or the move fails', async () => {
    const state = setup()
    state.openWorkspace.mockResolvedValue(false)
    state.controller.show('a')
    await state.controller.move('/new')
    expect(state.selectActivity).not.toHaveBeenCalled()
    expect(state.controller.activity.value.id).toBe('a')
    state.activityRuntime.moveToWorkspace.mockRejectedValue(new Error('No session ID'))
    await state.controller.move('/new')
    expect(state.controller.error.value).toContain('No session ID')
    expect(state.controller.busy.value).toBe(false)
  })
  it('checks that the launcher still exists before starting a move', async () => {
    const state = setup()
    state.launchers.byId.mockReturnValue(null)
    state.controller.show('a')
    await state.controller.move('/new')
    expect(state.activityRuntime.moveToWorkspace).not.toHaveBeenCalled()
    expect(state.controller.error.value).toContain('launcher preset')
  })
})
