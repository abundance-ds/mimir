import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

import { createShellTool } from './shell'

const context = {
  sessionId: 'sess-1',
  workspacePath: '/projects/myapp',
  approvalMode: 'bypass',
  policy: {},
}

describe('shell tool', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('returns empty object when no workspacePath', () => {
    const tools = createShellTool({})
    expect(tools).toEqual({})
  })

  it('executes command and returns output', async () => {
    mockInvoke.mockResolvedValue({
      exit_code: 0,
      timed_out: false,
      duration_ms: 150,
      stdout: 'hello world',
      stderr: '',
    })

    const { shell } = createShellTool(context)
    const result = await shell.execute({ command: 'echo hello world' })

    expect(mockInvoke).toHaveBeenCalledWith('shell_exec', {
      command: 'echo hello world',
      workingDir: '/projects/myapp',
      timeoutMs: 30000,
    })
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('hello world')
    expect(result.timed_out).toBe(false)
  })

  it('uses custom timeout', async () => {
    mockInvoke.mockResolvedValue({ exit_code: 0, timed_out: false, duration_ms: 50, stdout: '', stderr: '' })

    const { shell } = createShellTool(context)
    await shell.execute({ command: 'sleep 1', timeout: 60 })

    expect(mockInvoke).toHaveBeenCalledWith('shell_exec', {
      command: 'sleep 1',
      workingDir: '/projects/myapp',
      timeoutMs: 60000,
    })
  })

  it('resolves relative cwd against workspacePath', async () => {
    mockInvoke.mockResolvedValue({ exit_code: 0, timed_out: false, duration_ms: 10, stdout: '', stderr: '' })

    const { shell } = createShellTool(context)
    await shell.execute({ command: 'ls', cwd: 'src/components' })

    expect(mockInvoke).toHaveBeenCalledWith('shell_exec', {
      command: 'ls',
      workingDir: '/projects/myapp/src/components',
      timeoutMs: 30000,
    })
  })

  it('uses absolute cwd as-is', async () => {
    mockInvoke.mockResolvedValue({ exit_code: 0, timed_out: false, duration_ms: 10, stdout: '', stderr: '' })

    const { shell } = createShellTool(context)
    await shell.execute({ command: 'ls', cwd: '/tmp/build' })

    expect(mockInvoke).toHaveBeenCalledWith('shell_exec', {
      command: 'ls',
      workingDir: '/tmp/build',
      timeoutMs: 30000,
    })
  })

  it('adds note when command times out', async () => {
    mockInvoke.mockResolvedValue({
      exit_code: -1,
      timed_out: true,
      duration_ms: 30000,
      stdout: 'partial output',
      stderr: '',
    })

    const { shell } = createShellTool(context)
    const result = await shell.execute({ command: 'sleep 999' })

    expect(result.timed_out).toBe(true)
    expect(result.note).toMatch(/timed out after 30s/)
  })

  it('omits stdout/stderr when empty', async () => {
    mockInvoke.mockResolvedValue({ exit_code: 0, timed_out: false, duration_ms: 5, stdout: '', stderr: '' })

    const { shell } = createShellTool(context)
    const result = await shell.execute({ command: 'true' })

    expect(result).not.toHaveProperty('stdout')
    expect(result).not.toHaveProperty('stderr')
  })

  it('returns error when invoke throws', async () => {
    mockInvoke.mockRejectedValue(new Error('Process not found'))

    const { shell } = createShellTool(context)
    const result = await shell.execute({ command: 'nonexistent' })

    expect(result.error).toMatch(/Command failed/)
  })
})
