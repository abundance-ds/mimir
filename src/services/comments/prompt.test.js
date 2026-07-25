import { describe, it, expect } from 'vitest'
import { buildCommentsPrompt } from './prompt.js'

describe('buildCommentsPrompt', () => {
  it('returns an empty-state prompt when there are no comments', () => {
    expect(buildCommentsPrompt()).toBe('No inline <comment> annotations are present in the active editor file.')
  })

  it('builds an agent prompt with file reference, count, focus id, and line', () => {
    const prompt = buildCommentsPrompt({
      comments: [
        { id: 'c1', text: 'Tighten this paragraph' },
        { id: 'c2', text: 'Check the JSON example' },
      ],
      filePath: '/tmp/plan.md',
      focusId: 'c2',
      focusLine: 42,
    })

    expect(prompt).toContain('2 inline <comment> annotations')
    expect(prompt).toContain('"/tmp/plan.md"')
    expect(prompt).toContain('canonical pseudo-XML threads')
    expect(prompt).toContain('Preserve every <comment> wrapper, <reply>, and status attribute')
    expect(prompt).toContain('use comment_reply')
    expect(prompt).toContain('Focus first on c2 near line 42: Check the JSON example')
  })
})
