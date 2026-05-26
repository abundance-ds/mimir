import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('../dataDir', () => ({
  projectDir: vi.fn(async (id) => `/mock/projects/${id}`),
}))

import { invoke } from '@tauri-apps/api/core'
import {
  parseBoardEntry,
  serializeEntry,
  validateIssueMeta,
  normalizeKnowledgeMeta,
  generateEntryId,
  issuesDir,
  knowledgeDir,
  ensureIssuesDir,
  ensureKnowledgeDir,
  discoverEntries,
  readEntry,
  writeEntry,
  deleteEntry,
  moveEntry,
  ISSUE_STATUSES,
  COLUMN_STATUSES,
  PRIORITIES,
  STATUS_LABELS,
  PRIORITY_LABELS,
} from './loader.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exports ISSUE_STATUSES with expected values', () => {
    expect(ISSUE_STATUSES).toEqual(['backlog', 'plan', 'in-progress', 'review', 'done'])
  })

  it('exports COLUMN_STATUSES as a subset of ISSUE_STATUSES', () => {
    for (const s of COLUMN_STATUSES) {
      expect(ISSUE_STATUSES).toContain(s)
    }
  })

  it('exports PRIORITIES with expected values', () => {
    expect(PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent'])
  })

  it('exports STATUS_LABELS for every ISSUE_STATUS', () => {
    for (const s of ISSUE_STATUSES) {
      expect(STATUS_LABELS[s]).toBeDefined()
    }
  })

  it('exports PRIORITY_LABELS for every PRIORITY', () => {
    for (const p of PRIORITIES) {
      expect(PRIORITY_LABELS[p]).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// parseBoardEntry
// ---------------------------------------------------------------------------

describe('parseBoardEntry', () => {
  it('parses valid issue YAML with arrays and nested objects', () => {
    const raw = [
      '---',
      'type: issue',
      'title: Build the widget',
      'status: in-progress',
      'priority: high',
      'tags:',
      '  - frontend',
      '  - urgent',
      'origin:',
      '  source: slack',
      '  url: https://example.com',
      'deliverables:',
      '  - spec document',
      '  - prototype',
      '---',
      '',
      'Body content here.',
    ].join('\n')

    const { meta, body } = parseBoardEntry(raw)
    expect(meta.type).toBe('issue')
    expect(meta.title).toBe('Build the widget')
    expect(meta.status).toBe('in-progress')
    expect(meta.priority).toBe('high')
    expect(meta.tags).toEqual(['frontend', 'urgent'])
    expect(meta.origin).toEqual({ source: 'slack', url: 'https://example.com' })
    expect(meta.deliverables).toEqual(['spec document', 'prototype'])
    expect(body).toBe('\nBody content here.')
  })

  it('parses valid knowledge YAML', () => {
    const raw = [
      '---',
      'type: knowledge',
      'title: My entry',
      'tags:',
      '  - idea',
      '---',
      '',
      'Entry body.',
    ].join('\n')

    const { meta, body } = parseBoardEntry(raw)
    expect(meta.type).toBe('knowledge')
    expect(meta.title).toBe('My entry')
    expect(meta.tags).toEqual(['idea'])
    expect(body).toBe('\nEntry body.')
  })

  it('returns body after frontmatter', () => {
    const raw = '---\ntitle: Test\ntype: knowledge\n---\nLine 1\nLine 2'
    const { body } = parseBoardEntry(raw)
    expect(body).toBe('Line 1\nLine 2')
  })

  it('handles missing frontmatter — treats whole content as body with knowledge defaults', () => {
    const raw = 'Just some text without any frontmatter delimiters.'
    const { meta, body } = parseBoardEntry(raw)
    expect(meta.type).toBe('knowledge')
    expect(body).toBe(raw)
  })

  it('handles broken YAML gracefully — returns knowledge meta with raw as body', () => {
    const raw = '---\n: : : [invalid yaml\n---\nSome body'
    const { meta, body } = parseBoardEntry(raw)
    expect(meta.type).toBe('knowledge')
    expect(body).toBe(raw)
  })

  it('infers title from first # Heading when no YAML title', () => {
    const raw = 'Some preamble\n# My Heading\nMore text'
    const { meta } = parseBoardEntry(raw)
    expect(meta.title).toBe('My Heading')
  })

  it('infers title from first 60 chars when no heading and no YAML', () => {
    const longText = 'A'.repeat(100)
    const { meta } = parseBoardEntry(longText)
    expect(meta.title).toBe('A'.repeat(60))
  })

  it('handles empty string input', () => {
    const { meta, body } = parseBoardEntry('')
    expect(meta.type).toBe('knowledge')
    expect(meta.title).toBe('')
    expect(body).toBe('')
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\ntype: knowledge\r\ntitle: CRLF Test\r\n---\r\nBody with CRLF.'
    const { meta, body } = parseBoardEntry(raw)
    expect(meta.type).toBe('knowledge')
    expect(meta.title).toBe('CRLF Test')
    expect(body).toBe('Body with CRLF.')
  })
})

// ---------------------------------------------------------------------------
// serializeEntry
// ---------------------------------------------------------------------------

describe('serializeEntry', () => {
  it('round-trips: parse -> serialize -> parse produces identical meta and body', () => {
    const raw = [
      '---',
      'type: knowledge',
      'title: Round trip',
      'tags:',
      '  - test',
      '---',
      '',
      'Body text.',
    ].join('\n')

    const first = parseBoardEntry(raw)
    const serialized = serializeEntry(first.meta, first.body)
    const second = parseBoardEntry(serialized)

    expect(second.meta.type).toBe(first.meta.type)
    expect(second.meta.title).toBe(first.meta.title)
    expect(second.meta.tags).toEqual(first.meta.tags)
    // Body should be semantically equivalent (may differ in leading whitespace)
    expect(second.body.trim()).toBe(first.body.trim())
  })

  it('produces valid --- delimiters', () => {
    const result = serializeEntry({ type: 'knowledge', title: 'Test' }, 'Body')
    expect(result.startsWith('---\n')).toBe(true)
    expect(result).toContain('\n---\n')
  })

  it('handles meta with arrays and nested objects', () => {
    const meta = {
      type: 'issue',
      title: 'Complex',
      tags: ['a', 'b'],
      origin: { source: 'github', url: 'https://gh.com/123' },
    }
    const result = serializeEntry(meta, 'body')
    expect(result).toContain('tags:')
    expect(result).toContain('origin:')
    // Re-parse to verify structure survived
    const { meta: parsed } = parseBoardEntry(result)
    expect(parsed.tags).toEqual(['a', 'b'])
    expect(parsed.origin.source).toBe('github')
  })

  it('handles empty body', () => {
    const result = serializeEntry({ type: 'knowledge', title: 'Empty' }, '')
    expect(result).toContain('---\n')
    // Should end with the closing delimiter and empty body
    const { body } = parseBoardEntry(result)
    expect(body.trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// validateIssueMeta
// ---------------------------------------------------------------------------

describe('validateIssueMeta', () => {
  const validIssue = () => ({
    type: 'issue',
    title: 'Do the thing',
    status: 'backlog',
    priority: 'normal',
    tags: ['dev'],
    deliverables: ['spec'],
    origin: { source: 'manual' },
    links: [],
  })

  it('valid issue with all fields returns valid: true, no errors', () => {
    const { valid, errors } = validateIssueMeta(validIssue())
    expect(valid).toBe(true)
    expect(errors).toEqual([])
  })

  it('missing title returns valid: false with error about title', () => {
    const m = validIssue()
    delete m.title
    const { valid, errors } = validateIssueMeta(m)
    expect(valid).toBe(false)
    expect(errors.some((e) => e.toLowerCase().includes('title'))).toBe(true)
  })

  it('missing status defaults to backlog', () => {
    const m = validIssue()
    delete m.status
    const { meta } = validateIssueMeta(m)
    expect(meta.status).toBe('backlog')
  })

  it('invalid status value defaults to backlog', () => {
    const m = validIssue()
    m.status = 'nonsense'
    const { meta } = validateIssueMeta(m)
    expect(meta.status).toBe('backlog')
  })

  it('missing priority defaults to normal', () => {
    const m = validIssue()
    delete m.priority
    const { meta } = validateIssueMeta(m)
    expect(meta.priority).toBe('normal')
  })

  it('invalid priority defaults to normal', () => {
    const m = validIssue()
    m.priority = 'mega'
    const { meta } = validateIssueMeta(m)
    expect(meta.priority).toBe('normal')
  })

  it('missing tags defaults to []', () => {
    const m = validIssue()
    delete m.tags
    const { meta } = validateIssueMeta(m)
    expect(meta.tags).toEqual([])
  })

  it('missing deliverables defaults to []', () => {
    const m = validIssue()
    delete m.deliverables
    const { meta } = validateIssueMeta(m)
    expect(meta.deliverables).toEqual([])
  })

  it('missing origin defaults to {}', () => {
    const m = validIssue()
    delete m.origin
    const { meta } = validateIssueMeta(m)
    expect(meta.origin).toEqual({})
  })

  it('sets created if missing, always updates updated', () => {
    const m = validIssue()
    delete m.created
    const { meta } = validateIssueMeta(m)
    expect(meta.created).toBeDefined()
    expect(meta.updated).toBeDefined()
    expect(typeof meta.created).toBe('string')
    expect(typeof meta.updated).toBe('string')
  })

  it('preserves existing created, still updates updated', () => {
    const m = validIssue()
    m.created = '2024-01-01T00:00:00.000Z'
    const { meta } = validateIssueMeta(m)
    expect(meta.created).toBe('2024-01-01T00:00:00.000Z')
    expect(meta.updated).toBeDefined()
  })

  it('preserves valid dueDate string', () => {
    const m = validIssue()
    m.dueDate = '2025-06-15'
    const { meta } = validateIssueMeta(m)
    expect(meta.dueDate).toBe('2025-06-15')
  })

  it('clears non-string dueDate', () => {
    const m = validIssue()
    m.dueDate = 12345
    const { meta } = validateIssueMeta(m)
    expect(meta.dueDate).toBe('')
  })

  it('does not add dueDate if not present', () => {
    const m = validIssue()
    const { meta } = validateIssueMeta(m)
    expect(meta.dueDate).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normalizeNoteMeta
// ---------------------------------------------------------------------------

describe('normalizeKnowledgeMeta', () => {
  it('fills all defaults for empty meta', () => {
    const result = normalizeKnowledgeMeta({})
    expect(result.type).toBe('knowledge')
    expect(result.title).toBe('')
    expect(result.tags).toEqual([])
    expect(result.created).toBeDefined()
    expect(result.updated).toBeDefined()
  })

  it('preserves existing fields', () => {
    const result = normalizeKnowledgeMeta({ title: 'Hello', tags: ['a'] })
    expect(result.title).toBe('Hello')
    expect(result.tags).toEqual(['a'])
  })

  it('preserves unknown keys (knowledge entries are flexible)', () => {
    const result = normalizeKnowledgeMeta({ customField: 42, color: 'blue' })
    expect(result.customField).toBe(42)
    expect(result.color).toBe('blue')
  })

  it('never throws on garbage input', () => {
    expect(() => normalizeKnowledgeMeta(null)).not.toThrow()
    expect(() => normalizeKnowledgeMeta(undefined)).not.toThrow()
    expect(() => normalizeKnowledgeMeta(42)).not.toThrow()
    expect(() => normalizeKnowledgeMeta('string')).not.toThrow()
  })

  it('ensures tags is an array (non-array tags become [])', () => {
    const result = normalizeKnowledgeMeta({ tags: 'solo-tag' })
    expect(Array.isArray(result.tags)).toBe(true)
    expect(result.tags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// generateEntryId
// ---------------------------------------------------------------------------

describe('generateEntryId', () => {
  it('returns a 7-char alphanumeric string', () => {
    const id = generateEntryId()
    expect(id).toMatch(/^[0-9a-z]{7}$/)
  })

  it('two calls produce different IDs', () => {
    const a = generateEntryId()
    const b = generateEntryId()
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Async operations (mock Tauri)
// ---------------------------------------------------------------------------

describe('issuesDir', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns correct path for a project ID', async () => {
    const result = await issuesDir('proj-42')
    expect(result).toBe('/mock/projects/proj-42/issues')
  })
})

describe('knowledgeDir', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns correct path for a project ID', async () => {
    const result = await knowledgeDir('proj-42')
    expect(result).toBe('/mock/projects/proj-42/knowledge')
  })
})

describe('ensureIssuesDir', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creates and returns the issues directory', async () => {
    invoke.mockResolvedValue(undefined)
    const dir = await ensureIssuesDir('proj-1')
    expect(dir).toBe('/mock/projects/proj-1/issues')
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/proj-1/issues' })
  })
})

describe('ensureKnowledgeDir', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creates and returns the knowledge directory', async () => {
    invoke.mockResolvedValue(undefined)
    const dir = await ensureKnowledgeDir('proj-1')
    expect(dir).toBe('/mock/projects/proj-1/knowledge')
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/proj-1/knowledge' })
  })
})

describe('discoverEntries', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const issueContent = [
    '---',
    'type: issue',
    'title: First issue',
    'status: backlog',
    'priority: normal',
    'updated: "2024-06-02T00:00:00.000Z"',
    '---',
    '',
    'Body A',
  ].join('\n')

  const knowledgeContent = [
    '---',
    'type: knowledge',
    'title: A knowledge entry',
    'updated: "2024-06-01T00:00:00.000Z"',
    '---',
    '',
    'Body B',
  ].join('\n')

  function setupDirListings(issueItems, knowledgeItems) {
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'create_dir') return undefined
      if (cmd === 'list_dir') {
        if (args.path.endsWith('/issues')) return issueItems
        if (args.path.endsWith('/knowledge')) return knowledgeItems
        return []
      }
      if (cmd === 'read_text_file') {
        const all = [...issueItems, ...knowledgeItems]
        const entry = all.find((i) => i.path === args.path)
        if (entry) return { content: entry._content }
        throw new Error('not found')
      }
      return undefined
    })
  }

  it('reads .md files from both issues and knowledge directories', async () => {
    setupDirListings(
      [{ name: 'issue-1.md', path: '/mock/projects/p/issues/issue-1.md', is_dir: false, _content: issueContent }],
      [{ name: 'knowledge-1.md', path: '/mock/projects/p/knowledge/knowledge-1.md', is_dir: false, _content: knowledgeContent }],
    )

    const entries = await discoverEntries('p')
    expect(entries).toHaveLength(2)
    expect(entries[0].id).toBe('issue-1')
    expect(entries[1].id).toBe('knowledge-1')
  })

  it('skips non-.md files', async () => {
    setupDirListings(
      [],
      [
        { name: 'readme.txt', path: '/mock/projects/p/knowledge/readme.txt', is_dir: false, _content: 'hello' },
        { name: 'knowledge-1.md', path: '/mock/projects/p/knowledge/knowledge-1.md', is_dir: false, _content: knowledgeContent },
      ],
    )

    const entries = await discoverEntries('p')
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('knowledge-1')
  })

  it('skips directories', async () => {
    setupDirListings(
      [],
      [
        { name: 'subdir', path: '/mock/projects/p/knowledge/subdir', is_dir: true },
        { name: 'knowledge-1.md', path: '/mock/projects/p/knowledge/knowledge-1.md', is_dir: false, _content: knowledgeContent },
      ],
    )

    const entries = await discoverEntries('p')
    expect(entries).toHaveLength(1)
  })

  it('skips broken files (logs warning, does not throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'create_dir') return undefined
      if (cmd === 'list_dir') {
        if (args.path.endsWith('/issues')) return [
          { name: 'bad.md', path: '/mock/projects/p/issues/bad.md', is_dir: false },
        ]
        return []
      }
      if (cmd === 'read_text_file') throw new Error('disk error')
      return undefined
    })

    const entries = await discoverEntries('p')
    expect(entries).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns entries sorted by updated desc', async () => {
    // normalizeNoteMeta / validateIssueMeta overwrite `updated` with Date.now(),
    // so we use fake timers to control ordering: parse "old" first at t=1000,
    // then "new" at t=2000 — the entry parsed later gets the later timestamp.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-01T00:00:00.000Z'))

    let readCount = 0
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'create_dir') return undefined
      if (cmd === 'list_dir') {
        if (args.path.endsWith('/issues')) return [
          { name: 'new.md', path: '/mock/projects/p/issues/new.md', is_dir: false },
        ]
        if (args.path.endsWith('/knowledge')) return [
          { name: 'old.md', path: '/mock/projects/p/knowledge/old.md', is_dir: false },
        ]
        return []
      }
      if (cmd === 'read_text_file') {
        readCount++
        if (args.path.includes('/knowledge/')) {
          // Knowledge file read: "old" — timestamp stays at 2024-06-01
          return { content: knowledgeContent }
        }
        // Issue file read: "new" — advance time so updated is later
        vi.setSystemTime(new Date('2024-06-02T00:00:00.000Z'))
        return { content: issueContent }
      }
      return undefined
    })

    const entries = await discoverEntries('p')
    expect(entries[0].id).toBe('new')
    expect(entries[1].id).toBe('old')

    vi.useRealTimers()
  })

  it('returns empty array when directories have no .md files', async () => {
    setupDirListings([], [])
    const entries = await discoverEntries('p')
    expect(entries).toEqual([])
  })

  it('creates both issues and knowledge directories (via ensureIssuesDir/ensureKnowledgeDir)', async () => {
    setupDirListings([], [])
    await discoverEntries('p')
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/p/issues' })
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/p/knowledge' })
  })
})

describe('readEntry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('reads and parses a single entry (checks issues first, then knowledge)', async () => {
    const content = '---\ntype: knowledge\ntitle: Hello\n---\n\nWorld'
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'read_text_file') {
        if (args.path.includes('/issues/')) throw new Error('not found')
        return { content }
      }
      return undefined
    })

    const result = await readEntry('proj-1', 'knowledge-abc')
    expect(result.id).toBe('knowledge-abc')
    expect(result.meta.type).toBe('knowledge')
    expect(result.meta.title).toBe('Hello')
    expect(result.body.trim()).toBe('World')
    expect(invoke).toHaveBeenCalledWith('read_text_file', {
      path: '/mock/projects/proj-1/issues/knowledge-abc.md',
    })
    expect(invoke).toHaveBeenCalledWith('read_text_file', {
      path: '/mock/projects/proj-1/knowledge/knowledge-abc.md',
    })
  })
})

describe('writeEntry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function setupWriteMock() {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'create_dir') return undefined
      if (cmd === 'write_text_file') return undefined
      return undefined
    })
  }

  it('creates new entry (null ID) with generated ID', async () => {
    setupWriteMock()
    const id = await writeEntry('proj-1', null, { type: 'knowledge', title: 'New' }, 'body')
    expect(id).toMatch(/^[0-9a-z]{7}$/)
    expect(invoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: expect.stringContaining(id + '.md'),
    }))
  })

  it('updates existing knowledge entry (provided ID) — writes to knowledge dir', async () => {
    setupWriteMock()
    const id = await writeEntry('proj-1', 'knowledge-existing', { type: 'knowledge', title: 'Updated' }, 'body')
    expect(id).toBe('knowledge-existing')
    expect(invoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/mock/projects/proj-1/knowledge/knowledge-existing.md',
    }))
  })

  it('writes issue entries to issues dir', async () => {
    setupWriteMock()
    const id = await writeEntry('proj-1', 'issue-existing', { type: 'issue', title: 'Fix bug', status: 'backlog', priority: 'normal' }, 'body')
    expect(id).toBe('issue-existing')
    expect(invoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/mock/projects/proj-1/issues/issue-existing.md',
    }))
  })

  it('validates issues — throws on invalid meta', async () => {
    setupWriteMock()
    await expect(
      writeEntry('proj-1', null, { type: 'issue' }, 'body')
    ).rejects.toThrow(/title/)
  })

  it('normalizes knowledge entries — never throws', async () => {
    setupWriteMock()
    await expect(
      writeEntry('proj-1', null, { type: 'knowledge' }, 'body')
    ).resolves.toBeDefined()
  })

  it('sets created timestamp on new entries', async () => {
    setupWriteMock()
    await writeEntry('proj-1', null, { type: 'knowledge', title: 'Fresh' }, 'body')
    const writtenContent = invoke.mock.calls.find((c) => c[0] === 'write_text_file')[1].content
    expect(writtenContent).toContain('created:')
  })

  it('updates updated timestamp on all writes', async () => {
    setupWriteMock()
    await writeEntry('proj-1', 'knowledge-old', { type: 'knowledge', title: 'Old' }, 'body')
    const writtenContent = invoke.mock.calls.find((c) => c[0] === 'write_text_file')[1].content
    expect(writtenContent).toContain('updated:')
  })

  it('calls ensureKnowledgeDir for knowledge entries', async () => {
    setupWriteMock()
    await writeEntry('proj-1', null, { type: 'knowledge', title: 'T' }, '')
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/proj-1/knowledge' })
  })

  it('calls ensureIssuesDir for issue entries', async () => {
    setupWriteMock()
    await writeEntry('proj-1', null, { type: 'issue', title: 'Bug', status: 'backlog', priority: 'normal' }, '')
    expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/mock/projects/proj-1/issues' })
  })
})

describe('deleteEntry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('deletes knowledge entry from knowledge dir', async () => {
    invoke.mockResolvedValue(undefined)
    await deleteEntry('proj-1', 'knowledge-abc', 'knowledge')
    expect(invoke).toHaveBeenCalledWith('delete_path', {
      path: '/mock/projects/proj-1/knowledge/knowledge-abc.md',
    })
  })

  it('deletes issue entry from issues dir', async () => {
    invoke.mockResolvedValue(undefined)
    await deleteEntry('proj-1', 'issue-abc', 'issue')
    expect(invoke).toHaveBeenCalledWith('delete_path', {
      path: '/mock/projects/proj-1/issues/issue-abc.md',
    })
  })
})

describe('moveEntry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function setupMoveMock(entryContent) {
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'read_text_file') return { content: entryContent }
      if (cmd === 'create_dir') return undefined
      if (cmd === 'write_text_file') return undefined
      return undefined
    })
  }

  it('reads entry, updates status, writes back', async () => {
    const content = '---\ntype: issue\ntitle: Move me\nstatus: backlog\npriority: normal\n---\n\nBody'
    setupMoveMock(content)

    await moveEntry('proj-1', 'issue-1', 'done')

    const writeCall = invoke.mock.calls.find((c) => c[0] === 'write_text_file')
    expect(writeCall).toBeDefined()
    expect(writeCall[1].content).toContain('status: done')
  })

  it('throws on non-issue entries', async () => {
    const content = '---\ntype: knowledge\ntitle: Not an issue\n---\n\nBody'
    setupMoveMock(content)

    await expect(moveEntry('proj-1', 'knowledge-1', 'done')).rejects.toThrow(/issue/)
  })

  it('throws on invalid status', async () => {
    await expect(moveEntry('proj-1', 'issue-1', 'flying')).rejects.toThrow(/status/)
  })
})
