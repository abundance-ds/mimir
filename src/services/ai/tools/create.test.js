import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCreateTool } from './create.js'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('create tool', () => {
  beforeEach(() => invoke.mockReset())

  it('creates a new workspace text file directly', async () => {
    invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined)
    const onProposal = vi.fn()
    const { create } = createCreateTool({
      workspacePath: '/projects/myapp',
      onProposal,
    })

    const result = await create.execute({ target: 'src/new.js', content: 'hello' })

    expect(invoke).toHaveBeenNthCalledWith(1, 'path_exists', {
      path: '/projects/myapp/src/new.js',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'write_text_file', {
      path: '/projects/myapp/src/new.js',
      content: 'hello',
    })
    expect(result).toMatchObject({ path: 'src/new.js', status: 'created', characters: 5 })
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create',
      path: 'src/new.js',
      status: 'accepted',
    }))
  })

  it('never overwrites an existing file', async () => {
    invoke.mockResolvedValue(true)
    const { create } = createCreateTool({ workspacePath: '/projects/myapp' })

    const result = await create.execute({ target: 'src/existing.js', content: 'x' })

    expect(result.error).toContain('already exists')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('requires a workspace and rejects removed virtual domains', async () => {
    expect((await createCreateTool().create.execute({
      target: 'file.js',
      content: 'x',
    })).error).toBe('No workspace folder is open.')

    expect((await createCreateTool({ workspacePath: '/projects/myapp' }).create.execute({
      target: '@knowledge/note.md',
      content: 'x',
    })).error).toContain('Unknown workbench target')
  })

  it('blocks traversal outside the workspace', async () => {
    const { create } = createCreateTool({ workspacePath: '/projects/myapp' })
    const result = await create.execute({ target: '../../etc/evil.sh', content: 'x' })

    expect(result.error).toContain('inside the active workspace')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('normalizes native write errors', async () => {
    invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Disk full'))
    const { create } = createCreateTool({ workspacePath: '/projects/myapp' })

    const result = await create.execute({ target: 'new.txt', content: 'x' })

    expect(result.error).toContain('Failed to create file: Disk full')
  })
})
