import { describe, it, expect, vi } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

vi.mock('../../../stores/panel/board.js', () => ({
  useBoardStore: () => ({ loadBoard: vi.fn() }),
}))

vi.mock('../../../stores/panel/skills.js', () => ({
  useSkillsStore: () => ({ refreshSkills: vi.fn() }),
}))

vi.mock('../../dataDir.js', () => ({
  getDataDir: () => Promise.resolve('/data/mim'),
  projectDir: (id) => Promise.resolve(`/data/mim/projects/${id}`),
}))

vi.mock('../../board/loader.js', async (importOriginal) => {
  const orig = await importOriginal()
  return {
    ...orig,
    issuesDir: (projectId) => Promise.resolve(`/data/mim/projects/${projectId}/issues`),
    ensureIssuesDir: (projectId) => Promise.resolve(`/data/mim/projects/${projectId}/issues`),
    knowledgeDir: (projectId) => Promise.resolve(`/data/mim/projects/${projectId}/knowledge`),
    ensureKnowledgeDir: (projectId) => Promise.resolve(`/data/mim/projects/${projectId}/knowledge`),
  }
})

import { isAtPath, resolveAtPath } from './pathHandlers'

describe('isAtPath', () => {
  it('returns true for @issues/ path', () => {
    expect(isAtPath('@issues/issue-123.md')).toBe(true)
  })

  it('returns true for @knowledge/ path', () => {
    expect(isAtPath('@knowledge/note-1.md')).toBe(true)
  })

  it('returns true for @apps/ path', () => {
    expect(isAtPath('@apps/my-app/index.html')).toBe(true)
  })

  it('returns true for @skills/ path', () => {
    expect(isAtPath('@skills/summarize/prompt.md')).toBe(true)
  })

  it('returns false for regular path', () => {
    expect(isAtPath('/Users/test/project/src/main.js')).toBe(false)
  })

  it('returns false for relative path', () => {
    expect(isAtPath('src/main.js')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isAtPath(null)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isAtPath('')).toBe(false)
  })

  it('returns false for partial prefix without slash', () => {
    expect(isAtPath('@issuesfile.md')).toBe(false)
  })
})

describe('resolveAtPath', () => {
  it('resolves @issues/ paths correctly', async () => {
    const result = await resolveAtPath('@issues/issue-123.md', { projectId: 'proj-1' })
    expect(result.absolutePath).toBe('/data/mim/projects/proj-1/issues/issue-123.md')
    expect(result.relative).toBe('issue-123.md')
    expect(result.handler).toBeDefined()
    expect(result.handler.bypassProposals).toBe(true)
  })

  it('resolves @knowledge/ paths correctly', async () => {
    const result = await resolveAtPath('@knowledge/note-1.md', { projectId: 'proj-1' })
    expect(result.absolutePath).toBe('/data/mim/projects/proj-1/knowledge/note-1.md')
    expect(result.relative).toBe('note-1.md')
    expect(result.handler).toBeDefined()
    expect(result.handler.bypassProposals).toBe(true)
  })

  it('resolves @apps/ paths correctly', async () => {
    const result = await resolveAtPath('@apps/my-app/index.html', {})
    expect(result.absolutePath).toBe('/data/mim/apps/my-app/index.html')
    expect(result.relative).toBe('my-app/index.html')
    expect(result.handler).toBeDefined()
  })

  it('resolves @skills/ paths correctly', async () => {
    const result = await resolveAtPath('@skills/summarize/prompt.md', {})
    expect(result.absolutePath).toBe('/data/mim/skills/summarize/prompt.md')
    expect(result.relative).toBe('summarize/prompt.md')
  })

  it('rejects .. traversal on @issues/', async () => {
    const result = await resolveAtPath('@issues/../../../etc/passwd', { projectId: 'proj-1' })
    expect(result.error).toBe('Invalid path: traversal not allowed')
  })

  it('rejects .. traversal on @knowledge/', async () => {
    const result = await resolveAtPath('@knowledge/../../../etc/passwd', { projectId: 'proj-1' })
    expect(result.error).toBe('Invalid path: traversal not allowed')
  })

  it('rejects .. in the middle of relative path', async () => {
    const result = await resolveAtPath('@apps/my-app/../secret/key', {})
    expect(result.error).toBe('Invalid path: traversal not allowed')
  })

  it('returns null for non-@ paths', async () => {
    const result = await resolveAtPath('/Users/test/file.txt', {})
    expect(result).toBeNull()
  })

  it('returns null for empty path', async () => {
    const result = await resolveAtPath('', {})
    expect(result).toBeNull()
  })

  it('returns null for null path', async () => {
    const result = await resolveAtPath(null, {})
    expect(result).toBeNull()
  })

  it('returns error for @issues/ without projectId', async () => {
    const result = await resolveAtPath('@issues/issue-1.md', {})
    expect(result.error).toBe('No project selected')
  })

  it('returns error for @knowledge/ without projectId', async () => {
    const result = await resolveAtPath('@knowledge/note-1.md', {})
    expect(result.error).toBe('No project selected')
  })

  it('returns error for @issues/ with undefined projectId', async () => {
    const result = await resolveAtPath('@issues/issue-1.md', { projectId: undefined })
    expect(result.error).toBe('No project selected')
  })

  it('returns error for @knowledge/ with undefined projectId', async () => {
    const result = await resolveAtPath('@knowledge/note-1.md', { projectId: undefined })
    expect(result.error).toBe('No project selected')
  })
})

describe('@issues/ validate', () => {

  it('catches invalid issue (missing title)', async () => {
    const result = await resolveAtPath('@issues/test.md', { projectId: 'proj-1' })
    const content = `---\ntype: issue\nstatus: backlog\npriority: normal\n---\n\nSome body`
    const validation = result.handler.validate(content, 'test.md')
    expect(validation.error).toContain('title')
  })

  it('passes valid issue', async () => {
    const result = await resolveAtPath('@issues/test.md', { projectId: 'proj-1' })
    const content = `---\ntype: issue\ntitle: Fix the bug\nstatus: in-progress\npriority: high\ntags: []\nlinks: []\ndeliverables: []\nsources: []\n---\n\nDescription here`
    const validation = result.handler.validate(content, 'test.md')
    expect(validation.ok).toBe(true)
  })

  it('rejects knowledge type at @issues/ path', async () => {
    const result = await resolveAtPath('@issues/test.md', { projectId: 'proj-1' })
    const content = `---\ntype: knowledge\ntitle: My Note\ntags: []\n---\n\nContent`
    const validation = result.handler.validate(content, 'test.md')
    expect(validation.error).toContain('type: issue')
  })
})

describe('@knowledge/ validate', () => {

  it('passes knowledge entry', async () => {
    const result = await resolveAtPath('@knowledge/note.md', { projectId: 'proj-1' })
    const content = `---\ntype: knowledge\ntitle: My Note\ntags: []\nsources: []\n---\n\nContent`
    const validation = result.handler.validate(content, 'note.md')
    expect(validation.ok).toBe(true)
  })

  it('passes content without frontmatter (treated as knowledge)', async () => {
    const result = await resolveAtPath('@knowledge/plain.md', { projectId: 'proj-1' })
    const content = `# Just a heading\n\nSome plain content.`
    const validation = result.handler.validate(content, 'plain.md')
    expect(validation.ok).toBe(true)
  })

  it('rejects issue type at @knowledge/ path', async () => {
    const result = await resolveAtPath('@knowledge/test.md', { projectId: 'proj-1' })
    const content = `---\ntype: issue\ntitle: Fix bug\nstatus: backlog\npriority: normal\n---\n\nBody`
    const validation = result.handler.validate(content, 'test.md')
    expect(validation.error).toContain('type: knowledge')
  })
})

describe('@apps/ validate', () => {

  it('rejects manifest.json without name field', async () => {
    const result = await resolveAtPath('@apps/my-app/manifest.json', {})
    const validation = result.handler.validate('{"version": "1.0"}', 'manifest.json')
    expect(validation.error).toContain('name')
  })

  it('rejects invalid JSON in manifest.json', async () => {
    const result = await resolveAtPath('@apps/my-app/manifest.json', {})
    const validation = result.handler.validate('not json at all', 'manifest.json')
    expect(validation.error).toContain('Invalid JSON')
  })

  it('passes valid manifest.json', async () => {
    const result = await resolveAtPath('@apps/my-app/manifest.json', {})
    const validation = result.handler.validate('{"name": "My App", "version": "1.0"}', 'manifest.json')
    expect(validation.ok).toBe(true)
  })

  it('passes non-manifest files without validation', async () => {
    const result = await resolveAtPath('@apps/my-app/index.html', {})
    const validation = result.handler.validate('<html></html>', 'index.html')
    expect(validation.ok).toBe(true)
  })
})
