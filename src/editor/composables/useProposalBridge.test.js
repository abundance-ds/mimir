import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { PROPOSAL_APPLY_EVENT, DIFF_OPEN_EVENT } from '../../shared/proposalEvents.js'
import { computeCompoundDiff, computeDiffFromReview, useProposalBridge } from './useProposalBridge.js'

describe('proposal diff construction', () => {
  it('matches visible editor text across fixed pseudo-XML comment annotations', () => {
    const content = 'A <comment id="c1" author="user" text="Review">careful</comment> sentence.'
    const diff = computeDiffFromReview({
      targetText: 'A careful sentence.',
      replacement: 'A precise sentence.',
    }, content)

    expect(diff).toEqual({
      original: content,
      modified: 'A precise sentence.',
    })
  })

  it('rejects overlapping compound reviews instead of producing a corrupt merge', () => {
    expect(computeCompoundDiff([
      { targetText: 'alpha beta', replacement: 'one' },
      { targetText: 'beta gamma', replacement: 'two' },
    ], 'alpha beta gamma')).toBeNull()
  })
})

describe('proposal editor surface guards', () => {
  let callbacks
  let bridge
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = true
    callbacks = new Map()
    invoke.mockReset().mockResolvedValue(undefined)
    listen.mockReset().mockImplementation(async (event, callback) => {
      callbacks.set(event, callback)
      return vi.fn()
    })
  })
  afterEach(() => {
    bridge?.cleanup()
    delete window.__TAURI_INTERNALS__
  })

  async function setup(overrides = {}) {
    const handlers = {
      getDocContent: vi.fn(() => 'hello world'),
      applyChange: vi.fn(),
      getDocPath: () => '/graph/item.md',
      activateDiff: vi.fn(),
      canApply: () => true,
      ...overrides,
    }
    bridge = useProposalBridge(handlers)
    await vi.waitFor(() => expect(callbacks.has(DIFF_OPEN_EVENT)).toBe(true))
    return handlers
  }

  it('refuses a hidden Graph source before reading or changing its text', async () => {
    const handlers = await setup({ canApply: () => false })
    await callbacks.get(PROPOSAL_APPLY_EVENT)({ payload: { id: 'p1', targetText: 'world', replacement: 'Mimir' } })
    expect(handlers.getDocContent).not.toHaveBeenCalled()
    expect(handlers.applyChange).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p1', status: 'conflict', detail: expect.stringContaining('Open Source') }),
    })
  })

  it('reports a refused source transition without activating a review', async () => {
    const handlers = await setup({ openFileForDiff: vi.fn().mockRejectedValue(new Error('Save the Graph draft before opening Source.')) })
    await callbacks.get(DIFF_OPEN_EVENT)({ payload: { id: 'p1', path: '/graph/item.md', targetText: 'world', replacement: 'Mimir' } })
    expect(handlers.activateDiff).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p1', status: 'conflict', detail: expect.stringContaining('Save the Graph draft') }),
    })
  })

  it('does not report a failed text mutation as applied', async () => {
    await setup({ applyChange: () => { throw new Error('No source editor') } })
    await callbacks.get(PROPOSAL_APPLY_EVENT)({ payload: { id: 'p1', absolutePath: '/graph/item.md', targetText: 'world', replacement: 'Mimir' } })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p1', status: 'conflict', detail: 'No source editor' }),
    })
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ status: 'applied' }),
    })
  })

  it('rejects a delayed proposal for another tab even when its text matches', async () => {
    const handlers = await setup({ getDocPath: () => '/work/other.md' })
    await callbacks.get(PROPOSAL_APPLY_EVENT)({ payload: { id: 'p1', absolutePath: '/graph/item.md', path: '/work/other.md', targetText: 'world', replacement: 'Mimir' } })
    expect(handlers.getDocContent).not.toHaveBeenCalled()
    expect(handlers.applyChange).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ status: 'conflict', detail: expect.stringContaining('another document') }),
    })
  })

  it('applies a proposal only to its exact source path', async () => {
    const handlers = await setup()
    await callbacks.get(PROPOSAL_APPLY_EVENT)({ payload: { id: 'p1', absolutePath: '/graph/item.md', targetText: 'world', replacement: 'Mimir' } })
    expect(handlers.applyChange).toHaveBeenCalledWith(6, 11, 'Mimir')
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ status: 'applied' }),
    })
  })

  it('stops an event subscription that resolves after cleanup', async () => {
    let finishListen
    const stop = vi.fn()
    listen.mockImplementation((event, callback) => {
      callbacks.set(event, callback)
      return new Promise(resolve => { finishListen = () => resolve(stop) })
    })
    const applyChange = vi.fn()
    bridge = useProposalBridge({ getDocContent: () => 'world', applyChange, getDocPath: () => '/graph/item.md' })
    await vi.waitFor(() => expect(finishListen).toBeTypeOf('function'))
    bridge.cleanup()
    finishListen()
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(listen).toHaveBeenCalledTimes(1)
    await callbacks.get(PROPOSAL_APPLY_EVENT)({ payload: { id: 'p1', absolutePath: '/graph/item.md', targetText: 'world', replacement: 'Mimir' } })
    expect(applyChange).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not register listeners when disposed during module loading', async () => {
    bridge = useProposalBridge({})
    bridge.cleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(listen).not.toHaveBeenCalled()
  })
})
