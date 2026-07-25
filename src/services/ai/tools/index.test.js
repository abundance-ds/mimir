import { describe, it, expect } from 'vitest'
import { createMimTools } from './index'

describe('createMimTools', () => {
  it('returns core tools that need no workspace context', () => {
    const tools = createMimTools()
    const names = Object.keys(tools)

    // Always present (no workspace/project required)
    expect(names).toContain('read')
    expect(names).toContain('search')
    expect(names).toContain('edit')
    expect(names).toContain('create')
    expect(names).toContain('comment_add')
    expect(names).toContain('comment_reply')
    expect(names).toContain('search_web')
  })

  it('returns workspace-dependent tools when context provided', () => {
    const tools = createMimTools({ workspacePath: '/proj', projectId: 'p1' })
    const names = Object.keys(tools)

    expect(names).toContain('shell')
    expect(names).toContain('show')
    expect(names).toContain('list')
    expect(names).toContain('annotate_docx')
  })

  it('every tool has description and execute', () => {
    const tools = createMimTools({ workspacePath: '/proj', projectId: 'p1' })
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool, `${name} missing description`).toHaveProperty('description')
      expect(tool, `${name} missing execute`).toHaveProperty('execute')
    }
  })

  it('respects disabledTools context', () => {
    const tools = createMimTools({ disabledTools: ['search_web'] })
    expect(Object.keys(tools)).not.toContain('search_web')
  })
})
