import { describe, expect, it, vi } from 'vitest'

import { followActivity, runAgentCommand } from '../../bin/mimir.mjs'

describe('mimir run', () => {
  it('preserves extra argv and returns immediately with the Activity id', async () => {
    const callTool = vi.fn().mockResolvedValue({
      activity: { id: 'agent:evidence:1', title: 'Evidence sweep' },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runAgentCommand([
        'evidence', '--model', 'opus', '--preset', 'claude', '--interactive', '--verbose',
      ], { callTool, cwd: '/work' })
      expect(callTool).toHaveBeenCalledWith('agents_run', {
        name: 'evidence',
        workspace: '/work',
        args: ['--model', 'opus', '--verbose'],
        preset: 'claude',
        interactive: true,
        follow: false,
      })
      expect(log).toHaveBeenCalledWith('Evidence sweep\nActivity: agent:evidence:1')
    } finally {
      log.mockRestore()
    }
  })

  it('rejects interactive follow before starting an Activity', async () => {
    const callTool = vi.fn()

    await expect(runAgentCommand(
      ['live', '--interactive', '--follow'],
      { callTool, cwd: '/work' },
    )).rejects.toThrow('--follow supports headless agent runs only')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('streams ordered PTY bytes until the Activity ends', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        live: true,
        scrollback: { chunks: [{ sequence: 1, bytes: [111, 110, 101, 10] }], lastSequence: 1 },
      })
      .mockResolvedValueOnce({
        live: false,
        record: { session: { exit: { reason: 'completed', code: 0 } } },
        scrollback: { chunks: [{ sequence: 2, bytes: [116, 119, 111, 10] }], lastSequence: 2 },
      })
    const writes = []

    await followActivity('agent:evidence:1', {
      callTool,
      output: { write: chunk => writes.push(chunk.toString('utf8')) },
      pollMs: 0,
    })

    expect(writes.join('')).toBe('one\ntwo\n')
    expect(callTool).toHaveBeenNthCalledWith(2, 'activities_snapshot', {
      activity_id: 'agent:evidence:1',
      after_sequence: 1,
    })
  })
})
