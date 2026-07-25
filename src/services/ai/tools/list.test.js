import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createListTool } from './list.js'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('list tool', () => {
  beforeEach(() => invoke.mockReset())

  it('lists a workspace directory', async () => {
    invoke.mockResolvedValue([
      { name: 'index.js', is_dir: false, size: 500 },
      { name: 'components', is_dir: true, size: 0 },
    ])
    const { list } = createListTool({ workspacePath: '/projects/myapp' })

    const result = await list.execute({ target: 'src' })

    expect(invoke).toHaveBeenCalledWith('list_dir', { path: '/projects/myapp/src' })
    expect(result).toMatchObject({ directory: 'src', count: 2 })
  })

  it('keeps directories while applying a file glob', async () => {
    invoke.mockResolvedValue([
      { name: 'one.md', is_dir: false, size: 120 },
      { name: 'README.txt', is_dir: false, size: 50 },
      { name: 'notes', is_dir: true, size: 0 },
    ])
    const { list } = createListTool({ workspacePath: '/projects/myapp' })

    const result = await list.execute({ target: '.', pattern: '*.md' })

    expect(result.entries.map(entry => entry.name)).toEqual(['one.md', 'notes'])
  })

  it('caps output to 200 entries', async () => {
    invoke.mockResolvedValue(Array.from({ length: 250 }, (_, index) => ({
      name: `file-${index}.md`,
      is_dir: false,
      size: 10,
    })))
    const { list } = createListTool({ workspacePath: '/projects/myapp' })

    const result = await list.execute({ target: '.' })

    expect(result.count).toBe(200)
    expect(result.entries).toHaveLength(200)
  })

  it('requires an active workspace', async () => {
    const result = await createListTool().list.execute({ target: 'src' })
    expect(result.error).toBe('No workspace folder is open.')
  })

  it('rejects removed virtual domains and path traversal', async () => {
    const { list } = createListTool({ workspacePath: '/projects/myapp' })

    expect((await list.execute({ target: '@issues' })).error).toContain('Unknown workbench target')
    expect((await list.execute({ target: '../../etc' })).error).toContain('inside the active workspace')
  })
})
