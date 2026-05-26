import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { parseFrontmatter, discoverSkills, readSkillPrompt, seedDefaultSkills, seedSkillFromResource } from './loader'

vi.mock('../dataDir', () => ({
  getDataDir: vi.fn(() => Promise.resolve('/mock/data')),
}))

describe('parseFrontmatter', () => {
  it('extracts all fields from valid YAML', () => {
    const raw = `---
name: Test Skill
description: A test skill
maxSteps: 10
maxOutputTokens: 8000
---

Body content here.`

    const { meta, body } = parseFrontmatter(raw)
    expect(meta.name).toBe('Test Skill')
    expect(meta.description).toBe('A test skill')
    expect(meta.maxSteps).toBe(10)
    expect(meta.maxOutputTokens).toBe(8000)
    expect(body.trim()).toBe('Body content here.')
  })

  it('returns undefined for missing optional fields', () => {
    const raw = `---
name: Minimal
---

Body.`

    const { meta } = parseFrontmatter(raw)
    expect(meta.name).toBe('Minimal')
    expect(meta.description).toBeUndefined()
    expect(meta.maxSteps).toBeUndefined()
    expect(meta.maxOutputTokens).toBeUndefined()
  })

  it('returns empty meta and full body when no frontmatter', () => {
    const raw = 'Just plain text without frontmatter.'
    const { meta, body } = parseFrontmatter(raw)
    expect(meta).toEqual({})
    expect(body).toBe(raw)
  })

  it('handles quoted values', () => {
    const raw = `---
name: "Quoted Name"
description: 'Single quoted'
---

Body.`

    const { meta } = parseFrontmatter(raw)
    expect(meta.name).toBe('Quoted Name')
    expect(meta.description).toBe('Single quoted')
  })
})

describe('discoverSkills', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('returns empty when dir does not exist', async () => {
    vi.mocked(invoke).mockResolvedValue(false)
    const result = await discoverSkills()
    expect(result).toEqual([])
  })

  it('skips non-directories and dirs without SKILL.md', async () => {
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'path_exists') {
        if (args.path === '/mock/data/skills') return true
        if (args.path.endsWith('SKILL.md')) return false
        return false
      }
      if (cmd === 'list_dir') return [
        { name: 'readme.txt', path: '/mock/data/skills/readme.txt', is_dir: false },
        { name: 'no-skill', path: '/mock/data/skills/no-skill', is_dir: true },
      ]
      return null
    })

    const result = await discoverSkills()
    expect(result).toEqual([])
  })

  it('returns sorted skills', async () => {
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'path_exists') return true
      if (cmd === 'list_dir') return [
        { name: 'zebra', path: '/mock/data/skills/zebra', is_dir: true },
        { name: 'alpha', path: '/mock/data/skills/alpha', is_dir: true },
      ]
      if (cmd === 'read_text_file') {
        if (args.path.includes('zebra')) {
          return { content: '---\nname: Zebra Skill\ndescription: Z\n---\nBody Z' }
        }
        return { content: '---\nname: Alpha Skill\ndescription: A\n---\nBody A' }
      }
      return null
    })

    const result = await discoverSkills()
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Alpha Skill')
    expect(result[1].name).toBe('Zebra Skill')
    expect(result[0].id).toBe('alpha')
    expect(result[1].id).toBe('zebra')
  })
})

describe('readSkillPrompt', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('returns body without frontmatter', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'ai_config_dir') return '/mock/data'
      if (cmd === 'read_text_file') return { content: '---\nname: Test\n---\n\nThe prompt body.' }
      return null
    })

    const body = await readSkillPrompt('test-skill')
    expect(body.trim()).toBe('The prompt body.')
  })
})

describe('seedSkillFromResource', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('writes SKILL.md to skills directory', async () => {
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'path_exists') return false
      if (cmd === 'create_dir') return null
      if (cmd === 'write_text_file') return null
      return null
    })

    await seedSkillFromResource('test-skill', '---\nname: Test\n---\nBody')

    const writeCall = vi.mocked(invoke).mock.calls.find(c => c[0] === 'write_text_file')
    expect(writeCall).toBeTruthy()
    expect(writeCall[1].path).toContain('test-skill/SKILL.md')
    expect(writeCall[1].content).toBe('---\nname: Test\n---\nBody')
  })

  it('skips if skill directory already exists', async () => {
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'path_exists') return true
      return null
    })

    await seedSkillFromResource('existing-skill', 'content')

    const writeCall = vi.mocked(invoke).mock.calls.find(c => c[0] === 'write_text_file')
    expect(writeCall).toBeUndefined()
  })
})

describe('seedDefaultSkills', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('creates missing skills and skips existing', async () => {
    const existingPaths = new Set(['/mock/data/skills/existing'])
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'ai_config_dir') return '/mock/data'
      if (cmd === 'path_exists') return existingPaths.has(args.path)
      if (cmd === 'create_dir') return null
      if (cmd === 'write_text_file') return null
      return null
    })

    const bundled = [
      { id: 'existing', content: '---\nname: Existing\n---\nBody' },
      { id: 'new-skill', content: '---\nname: New\n---\nBody' },
    ]

    await seedDefaultSkills(bundled)

    const writeCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'write_text_file')
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0][1].path).toContain('new-skill')
  })
})
