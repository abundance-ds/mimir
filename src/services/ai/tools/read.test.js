import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReadTool } from './read.js'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('read tool', () => {
  beforeEach(() => invoke.mockReset())

  it('reads the active editor and marks later reads as refreshed context', async () => {
    const history = new Set()
    const { read } = createReadTool({
      _readHistory: history,
      getDocument: () => ({ content: '# Hello\nWorld', path: '/docs/test.md' }),
    })

    const first = await read.execute({ target: '@editor' })
    const second = await read.execute({ target: '@editor' })

    expect(first).toMatchObject({
      title: 'Hello',
      path: '/docs/test.md',
      content: '# Hello\nWorld',
      characters: 13,
    })
    expect(first.note).toBeUndefined()
    expect(second.note).toContain('updated read')
  })

  it('can expose canonical comment annotations on request', async () => {
    const content = '<comment id="c1" author="me" text="Check this">word</comment>'
    const { read } = createReadTool({
      getDocument: () => ({ content, path: '/docs/test.md' }),
    })

    const hidden = await read.execute({ target: '@editor' })
    const shown = await read.execute({ target: '@editor', show_comments: true })

    expect(hidden.content).toBe('word')
    expect(shown.content).toBe(content)
    expect(shown.note_comments).toContain('1 active comment')
  })

  it('reads workspace text files through the native filesystem', async () => {
    invoke.mockResolvedValue({ content: 'file content here' })
    const { read } = createReadTool({ workspacePath: '/projects/myapp' })

    const result = await read.execute({ target: 'src/main.js' })

    expect(invoke).toHaveBeenCalledWith('read_text_file', {
      path: '/projects/myapp/src/main.js',
    })
    expect(result).toMatchObject({ path: 'src/main.js', content: 'file content here' })
  })

  it('blocks traversal outside the active workspace', async () => {
    const { read } = createReadTool({ workspacePath: '/projects/myapp' })
    const result = await read.execute({ target: '../../etc/passwd' })

    expect(result.error).toContain('Path traversal blocked')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects removed virtual domains', async () => {
    const { read } = createReadTool({ workspacePath: '/projects/myapp' })
    const result = await read.execute({ target: '@unknown' })

    expect(result.error).toBe('Unknown workbench target: @unknown')
  })

})
