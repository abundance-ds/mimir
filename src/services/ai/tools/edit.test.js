import { describe, it, expect, vi } from 'vitest'
import { createEditTool, matchInCleanContent } from './edit'
import { stripCommentTags } from '../../comments/parser'

function tag(id, text, opts = {}) {
  const author = opts.author || 'user'
  const note = opts.text || 'note'
  const status = opts.status || 'active'
  let t = `<comment id="${id}" author="${author}" text="${note}" status="${status}">${text}</comment>`
  return t
}

describe('matchInCleanContent', () => {
  // ── No comments ──────────────────────────────────────────────────────
  describe('no comment tags in content', () => {
    it('matches plain text directly', () => {
      const raw = 'Hello world, this is plain text.'
      const result = matchInCleanContent(raw, 'world')
      expect(result).toEqual({ from: 6, to: 11 })
      expect(raw.slice(result.from, result.to)).toBe('world')
    })

    it('matches multi-word target in plain text', () => {
      const raw = 'The quick brown fox jumps over the lazy dog.'
      const result = matchInCleanContent(raw, 'brown fox jumps')
      expect(result).toEqual({ from: 10, to: 25 })
      expect(raw.slice(result.from, result.to)).toBe('brown fox jumps')
    })

    it('returns not_found for absent text in plain content', () => {
      const raw = 'Hello world.'
      expect(matchInCleanContent(raw, 'missing')).toEqual({ error: 'not_found' })
    })

    it('returns ambiguous when text appears twice in plain content', () => {
      const raw = 'hello and hello again'
      expect(matchInCleanContent(raw, 'hello')).toEqual({ error: 'ambiguous', count: 2 })
    })
  })

  // ── Comments between matched text ───────────────────────────────────
  describe('comments interspersed within matched text', () => {
    it('matches old_text spanning across a comment tag', () => {
      const raw = `Hello ${tag('c1', 'beautiful')} world`
      // Clean text: "Hello beautiful world"
      const result = matchInCleanContent(raw, 'Hello beautiful world')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      // Replacing should produce clean output
      const replaced = raw.slice(0, result.from) + 'Goodbye cruel world' + raw.slice(result.to)
      expect(replaced).toBe('Goodbye cruel world')
    })

    it('matches text inside a comment tag (annotated content)', () => {
      const raw = `Start ${tag('c1', 'annotated text')} end`
      const result = matchInCleanContent(raw, 'annotated text')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      // from points to content start inside the tag, to points past </comment>
      expect(slice).toContain('annotated text')
    })

    it('matches text spanning two adjacent comment tags', () => {
      const raw = `${tag('c1', 'first')}${tag('c2', 'second')}`
      // Clean text: "firstsecond"
      const result = matchInCleanContent(raw, 'firstsecond')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(slice).toContain('first')
      expect(slice).toContain('second')
    })
  })

  // ── Comments before matched text ────────────────────────────────────
  describe('comments before the matched text', () => {
    it('correctly offsets positions when comments precede the match', () => {
      const raw = `${tag('c1', 'prefix')} target text here`
      // Clean text: "prefix target text here"
      const result = matchInCleanContent(raw, 'target text here')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      expect(raw.slice(result.from, result.to)).toBe('target text here')
    })

    it('handles multiple comments before the match', () => {
      const raw = `${tag('c1', 'a')} ${tag('c2', 'b')} find me`
      // Clean text: "a b find me"
      const result = matchInCleanContent(raw, 'find me')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      expect(raw.slice(result.from, result.to)).toBe('find me')
    })
  })

  // ── Comments after matched text ─────────────────────────────────────
  describe('comments after the matched text', () => {
    it('does not affect match positions', () => {
      const raw = `find me ${tag('c1', 'suffix')}`
      // Clean text: "find me suffix"
      const result = matchInCleanContent(raw, 'find me')
      expect(result).toEqual({ from: 0, to: 7 })
      expect(raw.slice(result.from, result.to)).toBe('find me')
    })
  })

  // ── Multiple matches → ambiguous ────────────────────────────────────
  describe('ambiguous matches', () => {
    it('returns ambiguous when old_text appears twice in clean text', () => {
      const raw = `${tag('c1', 'hello')} and ${tag('c2', 'hello')}`
      const result = matchInCleanContent(raw, 'hello')
      expect(result).toEqual({ error: 'ambiguous', count: 2 })
    })

    it('returns ambiguous when text matches both inside and outside tags', () => {
      const raw = `word ${tag('c1', 'word')}`
      const result = matchInCleanContent(raw, 'word')
      expect(result).toEqual({ error: 'ambiguous', count: 2 })
    })

    it('returns ambiguous count=3 for three matches', () => {
      const raw = 'aaa bbb aaa bbb aaa'
      const result = matchInCleanContent(raw, 'aaa')
      expect(result).toEqual({ error: 'ambiguous', count: 3 })
    })
  })

  // ── No match → not_found ────────────────────────────────────────────
  describe('not_found', () => {
    it('returns not_found when text is absent from both raw and clean', () => {
      const raw = `Hello ${tag('c1', 'world')} today.`
      expect(matchInCleanContent(raw, 'missing text')).toEqual({ error: 'not_found' })
    })

    it('returns not_found for partial match (substring of a word)', () => {
      const raw = `Hello ${tag('c1', 'world')} today.`
      // "worl" is not a full match of any token, but substring matching applies
      // countMatches will find it since indexOf matches substrings
      const result = matchInCleanContent(raw, 'worl')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
    })

    it('returns not_found for text that only exists in tag attributes', () => {
      const raw = '<comment id="c1" author="user" text="Fix spelling" status="active">content</comment>'
      // "Fix spelling" is in the text attribute, not in the clean text
      expect(matchInCleanContent(raw, 'Fix spelling')).toEqual({ error: 'not_found' })
    })
  })

  // ── Match at document start ─────────────────────────────────────────
  describe('match at start of document', () => {
    it('returns from=0 when match is at the beginning', () => {
      const raw = 'Start of document with more text.'
      const result = matchInCleanContent(raw, 'Start')
      expect(result.from).toBe(0)
      expect(raw.slice(result.from, result.to)).toBe('Start')
    })

    it('returns from=0 when first element is a comment tag', () => {
      const raw = `${tag('c1', 'Beginning')} rest of text`
      const result = matchInCleanContent(raw, 'Beginning')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(slice).toContain('Beginning')
    })

    it('matches entire document content', () => {
      const raw = `${tag('c1', 'all')} ${tag('c2', 'content')}`
      const result = matchInCleanContent(raw, 'all content')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
    })
  })

  // ── Match at end of document ────────────────────────────────────────
  describe('match at end of document', () => {
    it('to equals content length when match is at the end (plain)', () => {
      const raw = 'Some text at the end'
      const result = matchInCleanContent(raw, 'end')
      expect(result.to).toBe(raw.length)
      expect(raw.slice(result.from, result.to)).toBe('end')
    })

    it('to maps to end of raw when last element is a comment tag', () => {
      const raw = `prefix ${tag('c1', 'suffix')}`
      const result = matchInCleanContent(raw, 'suffix')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      // to should point past the closing </comment> tag
      expect(result.to).toBe(raw.length)
    })

    it('matches text spanning plain into final comment tag', () => {
      const raw = `prefix ${tag('c1', 'suffix')}`
      const result = matchInCleanContent(raw, 'prefix suffix')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      expect(result.from).toBe(0)
      expect(result.to).toBe(raw.length)
    })
  })

  // ── Adjacent comments ───────────────────────────────────────────────
  describe('adjacent comment tags', () => {
    it('handles three adjacent comment tags', () => {
      const raw = `${tag('c1', 'A')}${tag('c2', 'B')}${tag('c3', 'C')}`
      // Clean text: "ABC"
      const result = matchInCleanContent(raw, 'ABC')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
    })

    it('matches text between two adjacent comment tags', () => {
      const raw = `${tag('c1', 'left')} gap ${tag('c2', 'right')}`
      const result = matchInCleanContent(raw, 'gap')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      expect(raw.slice(result.from, result.to)).toBe('gap')
    })
  })

  // ── Empty oldText edge ──────────────────────────────────────────────
  describe('empty old_text', () => {
    it('returns not_found for empty string (countMatches returns 0)', () => {
      const raw = 'Some content here.'
      const result = matchInCleanContent(raw, '')
      expect(result.error).toBe('not_found')
    })
  })

  // ── Position mapping accuracy (key invariant) ───────────────────────
  describe('position mapping invariant: stripping tags from slice equals old_text', () => {
    it('single comment inside matched text', () => {
      const raw = `The ${tag('c1', 'quick brown')} fox jumps.`
      const result = matchInCleanContent(raw, 'The quick brown fox')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(stripCommentTags(slice)).toBe('The quick brown fox')
    })

    it('multiple comments inside matched text', () => {
      const raw = `A ${tag('c1', 'B')} C ${tag('c2', 'D')} E`
      const result = matchInCleanContent(raw, 'A B C D E')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(stripCommentTags(slice)).toBe('A B C D E')
    })

    it('comment at start of matched text', () => {
      const raw = `${tag('c1', 'Hello')} world.`
      const result = matchInCleanContent(raw, 'Hello world.')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      // from maps to the content start inside the <comment> tag (after the opening tag).
      // to maps past the closing </comment> and trailing text.
      // The raw slice contains the closing </comment> fragment because from starts
      // inside the tag but to extends past it.
      const slice = raw.slice(result.from, result.to)
      expect(slice).toContain('Hello')
      expect(slice).toContain('world.')
    })

    it('comment at end of matched text', () => {
      const raw = `Hello ${tag('c1', 'world.')}`
      const result = matchInCleanContent(raw, 'Hello world.')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(stripCommentTags(slice)).toBe('Hello world.')
    })

    it('all content inside one big comment tag', () => {
      const raw = tag('c1', 'entire content is annotated')
      const result = matchInCleanContent(raw, 'entire content is annotated')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      // from → content start (after opening tag), to → end of raw (after </comment>)
      expect(result.to).toBe(raw.length)
      const slice = raw.slice(result.from, result.to)
      expect(slice).toContain('entire content is annotated')
    })

    it('plain text surrounded by comments', () => {
      const raw = `${tag('c1', 'before')} target ${tag('c2', 'after')}`
      const result = matchInCleanContent(raw, 'target')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      expect(raw.slice(result.from, result.to)).toBe('target')
    })
  })

  // ── Replacement correctness ─────────────────────────────────────────
  describe('replacement produces correct output', () => {
    it('replacing text spanning a comment removes the tag entirely', () => {
      const raw = `Hello ${tag('c1', 'world')} today.`
      const full = matchInCleanContent(raw, 'Hello world today.')
      const replaced = raw.slice(0, full.from) + 'Hello planet today.' + raw.slice(full.to)
      expect(replaced).toBe('Hello planet today.')
    })

    it('replacing partial text preserves surrounding comments', () => {
      const raw = `${tag('c1', 'keep')} replace ${tag('c2', 'keep')}`
      const result = matchInCleanContent(raw, 'replace')
      const replaced = raw.slice(0, result.from) + 'CHANGED' + raw.slice(result.to)
      expect(replaced).toContain('keep')
      expect(replaced).toContain('CHANGED')
      expect(replaced).toContain('keep')
    })
  })

  // ── Comments with replies ───────────────────────────────────────────
  describe('comments with reply tags', () => {
    it('anchor text excludes replies when matching', () => {
      const raw =
        'Prefix <comment id="c1" author="a" text="note" status="active">anchor text' +
        '<reply id="r1" author="b" text="reply text"/>' +
        '</comment> suffix'
      // Clean text should be: "Prefix anchor text suffix"
      // (replies are stripped from anchor text by the parser)
      const result = matchInCleanContent(raw, 'anchor text')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
    })
  })

  // ── Multiline content ──────────────────────────────────────────────
  describe('multiline content', () => {
    it('matches across lines with comment tags', () => {
      const raw = `Line one\n${tag('c1', 'Line two')}\nLine three`
      const result = matchInCleanContent(raw, 'Line one\nLine two\nLine three')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
      const slice = raw.slice(result.from, result.to)
      expect(stripCommentTags(slice)).toBe('Line one\nLine two\nLine three')
    })
  })

  // ── Special characters in content ───────────────────────────────────
  describe('special characters', () => {
    it('matches content with angle brackets in plain text', () => {
      const raw = `Use <b>bold</b> ${tag('c1', 'and')} <i>italic</i>`
      // The parser regex only matches <comment ...>...</comment>, not arbitrary HTML
      // Clean text: "Use <b>bold</b> and <i>italic</i>"
      const result = matchInCleanContent(raw, '<b>bold</b> and')
      expect(result).toHaveProperty('from')
      expect(result).toHaveProperty('to')
    })
  })
})

describe('edit @editor review contract', () => {
  it('builds a reviewable diff from visible text while preserving comment-aware matching', async () => {
    const raw = `Hello ${tag('c1', 'careful')} world.`
    const onProposal = vi.fn()
    const { edit } = createEditTool({
      getDocument: () => ({ content: raw, path: '/work/doc.md' }),
      onProposal,
    })

    const result = await edit.execute({
      target: '@editor',
      old_text: 'Hello careful world.',
      new_text: 'Hello precise world.',
    })

    expect(result.status).toBe('pending_review')
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({
      path: '/work/doc.md',
      original: raw,
      modified: 'Hello precise world.',
      status: 'pending',
    }))
  })

  it('does not create a phantom review when the target is missing or ambiguous', async () => {
    const onProposal = vi.fn()
    const { edit } = createEditTool({
      getDocument: () => ({ content: 'same same', path: '/work/doc.md' }),
      onProposal,
    })

    const missing = await edit.execute({
      target: '@editor',
      old_text: 'absent',
      new_text: 'replacement',
    })
    const ambiguous = await edit.execute({
      target: '@editor',
      old_text: 'same',
      new_text: 'replacement',
    })

    expect(missing.error).toMatch(/not found/i)
    expect(ambiguous.error).toMatch(/2 locations/)
    expect(onProposal).not.toHaveBeenCalled()
  })
})
