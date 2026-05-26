import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

vi.mock('./pathHandlers', () => ({
  isAtPath: (p) => p?.startsWith('@'),
  resolveAtPath: vi.fn(),
}))

vi.mock('./pathPermission', () => ({
  checkPathAccess: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../audit.js', () => ({
  logAudit: vi.fn(),
}))

import { createListTool } from './list'
import { resolveAtPath } from './pathHandlers'

const context = {
  sessionId: 'sess-1',
  workspacePath: '/projects/myapp',
  projectId: 'proj-1',
  approvalMode: 'bypass',
  policy: {},
}

describe('list tool', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    vi.mocked(resolveAtPath).mockReset()
  })

  it('lists @issues/ entries via pathHandler', async () => {
    vi.mocked(resolveAtPath).mockResolvedValue({
      absolutePath: '/data/projects/proj-1/issues',
      handler: {},
      relative: '',
    })
    mockInvoke.mockResolvedValue([
      { name: 'ISSUE-1.md', is_dir: false, size: 120 },
      { name: 'ISSUE-2.md', is_dir: false, size: 340 },
    ])

    const { list } = createListTool(context)
    const result = await list.execute({ target: '@issues/' })

    expect(result.directory).toBe('@issues/')
    expect(result.count).toBe(2)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].name).toBe('ISSUE-1.md')
  })

  it('lists project directory via invoke', async () => {
    mockInvoke.mockResolvedValue([
      { name: 'index.js', is_dir: false, size: 500 },
      { name: 'components', is_dir: true, size: 0 },
    ])

    const { list } = createListTool(context)
    const result = await list.execute({ target: 'src' })

    expect(mockInvoke).toHaveBeenCalledWith('list_dir', { path: '/projects/myapp/src' })
    expect(result.count).toBe(2)
  })

  it('applies glob pattern filter', async () => {
    vi.mocked(resolveAtPath).mockResolvedValue({
      absolutePath: '/data/issues',
      handler: {},
      relative: '',
    })
    mockInvoke.mockResolvedValue([
      { name: 'ISSUE-1.md', is_dir: false, size: 120 },
      { name: 'README.txt', is_dir: false, size: 50 },
      { name: 'subfolder', is_dir: true, size: 0 },
    ])

    const { list } = createListTool(context)
    const result = await list.execute({ target: '@issues/', pattern: '*.md' })

    expect(result.count).toBe(2)
    expect(result.entries.map(e => e.name)).toContain('ISSUE-1.md')
    expect(result.entries.map(e => e.name)).toContain('subfolder')
    expect(result.entries.map(e => e.name)).not.toContain('README.txt')
  })

  it('caps entries at 100', async () => {
    const manyFiles = Array.from({ length: 150 }, (_, i) => ({
      name: `file-${i}.md`, is_dir: false, size: 10,
    }))
    mockInvoke.mockResolvedValue(manyFiles)

    const { list } = createListTool(context)
    const result = await list.execute({ target: 'src' })

    expect(result.count).toBe(150)
    expect(result.entries).toHaveLength(100)
  })

  it('returns error when no workspacePath for project path', async () => {
    const { list } = createListTool({ sessionId: 'x', approvalMode: 'bypass', policy: {} })
    const result = await list.execute({ target: 'src' })
    expect(result.error).toMatch(/No project folder/)
  })

  it('returns error for unresolvable @-path', async () => {
    vi.mocked(resolveAtPath).mockResolvedValue(null)

    const { list } = createListTool(context)
    const result = await list.execute({ target: '@unknown/' })
    expect(result.error).toMatch(/Cannot resolve/)
  })

  it('returns error when @-path has no absolutePath', async () => {
    vi.mocked(resolveAtPath).mockResolvedValue({ virtual: true, subpath: '' })

    const { list } = createListTool(context)
    const result = await list.execute({ target: '@editor' })
    expect(result.error).toMatch(/Unsupported/)
  })
})
