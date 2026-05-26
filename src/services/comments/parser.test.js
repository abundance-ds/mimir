import { describe, it, expect } from 'vitest'
import { parseCommentTags, stripCommentTags, buildCommentTag, cleanToRawPos, escapeAttr, unescapeAttr } from './parser.js'

describe('parseCommentTags', () => {
  it('parses a single comment with no replies', () => {
    const text = 'Hello <comment id="c1" author="user" text="Fix this" created="2026-01-01T00:00:00Z">World</comment> Here'
    const result = parseCommentTags(text)
    expect(result.comments).toHaveLength(1)
    const c = result.comments[0]
    expect(c.id).toBe('c1')
    expect(c.author).toBe('user')
    expect(c.text).toBe('Fix this')
    expect(c.created).toBe('2026-01-01T00:00:00Z')
    expect(c.anchorText).toBe('World')
    expect(c.replies).toEqual([])
  })

  it('returns correct position spans', () => {
    const text = 'AB<comment id="c1" author="user" text="t">CD</comment>EF'
    const result = parseCommentTags(text)
    const c = result.comments[0]
    expect(text.slice(c.tagFrom, c.tagTo)).toBe('<comment id="c1" author="user" text="t">CD</comment>')
    expect(text.slice(c.contentFrom, c.contentTo)).toBe('CD')
  })

  it('produces correct cleanText with tags stripped', () => {
    const text = 'Hello <comment id="c1" author="user" text="Fix">World</comment> Here'
    const result = parseCommentTags(text)
    expect(result.cleanText).toBe('Hello World Here')
  })

  it('parses replies inside a comment', () => {
    const text = '<comment id="c1" author="user" text="Fix">Hello<reply id="r1" author="ai" text="Done" ts="2026-01-02T00:00:00Z"/></comment>'
    const result = parseCommentTags(text)
    expect(result.comments).toHaveLength(1)
    expect(result.comments[0].replies).toHaveLength(1)
    const r = result.comments[0].replies[0]
    expect(r.id).toBe('r1')
    expect(r.author).toBe('ai')
    expect(r.text).toBe('Done')
    expect(r.ts).toBe('2026-01-02T00:00:00Z')
  })

  it('parses multiple replies', () => {
    const text = '<comment id="c1" author="user" text="Fix">Hello<reply id="r1" author="ai" text="Done"/><reply id="r2" author="user" text="Thanks"/></comment>'
    const result = parseCommentTags(text)
    expect(result.comments[0].replies).toHaveLength(2)
    expect(result.comments[0].replies[0].id).toBe('r1')
    expect(result.comments[0].replies[1].id).toBe('r2')
  })

  it('cleanText excludes reply tags', () => {
    const text = 'A<comment id="c1" author="user" text="t">BC<reply id="r1" author="ai" text="x"/></comment>D'
    const result = parseCommentTags(text)
    expect(result.cleanText).toBe('ABCD')
  })

  it('parses multiple comments', () => {
    const text = '<comment id="c1" author="user" text="a">AAA</comment>BBB<comment id="c2" author="ai" text="b">CCC</comment>'
    const result = parseCommentTags(text)
    expect(result.comments).toHaveLength(2)
    expect(result.comments[0].id).toBe('c1')
    expect(result.comments[0].anchorText).toBe('AAA')
    expect(result.comments[1].id).toBe('c2')
    expect(result.comments[1].anchorText).toBe('CCC')
  })

  it('handles escaped attribute values', () => {
    const text = '<comment id="c1" author="user" text="&quot;quotes&quot; &amp; &lt;tags&gt;">X</comment>'
    const result = parseCommentTags(text)
    expect(result.comments[0].text).toBe('"quotes" & <tags>')
  })

  it('returns empty results for text with no comments', () => {
    const text = 'Just plain markdown with no comments'
    const result = parseCommentTags(text)
    expect(result.comments).toEqual([])
    expect(result.cleanText).toBe(text)
    expect(result.offsetMap).toEqual([])
  })

  it('handles multi-line annotated content', () => {
    const text = '<comment id="c1" author="user" text="Review">Line one\nLine two\nLine three</comment>'
    const result = parseCommentTags(text)
    expect(result.comments[0].anchorText).toBe('Line one\nLine two\nLine three')
    expect(result.cleanText).toBe('Line one\nLine two\nLine three')
  })

  it('handles comment with empty text attribute', () => {
    const text = 'A<comment id="c1" author="user" text="">B</comment>C'
    const result = parseCommentTags(text)
    expect(result.comments[0].text).toBe('')
    expect(result.comments[0].anchorText).toBe('B')
  })

  it('handles missing optional attributes gracefully', () => {
    const text = '<comment id="c1" author="user" text="hi">X</comment>'
    const result = parseCommentTags(text)
    expect(result.comments[0].created).toBeUndefined()
  })
})

describe('stripCommentTags', () => {
  it('strips all comment tags, keeps content', () => {
    const text = 'Hello <comment id="c1" author="user" text="Fix">World<reply id="r1" author="ai" text="Done"/></comment> Here'
    expect(stripCommentTags(text)).toBe('Hello World Here')
  })

  it('handles multiple comments', () => {
    const text = '<comment id="c1" author="user" text="a">AAA</comment>BBB<comment id="c2" author="ai" text="b">CCC</comment>'
    expect(stripCommentTags(text)).toBe('AAABBBCCC')
  })

  it('returns input unchanged when no comments', () => {
    const text = 'Just plain text'
    expect(stripCommentTags(text)).toBe(text)
  })

})

describe('buildCommentTag', () => {
  it('builds a comment tag with no replies', () => {
    const tag = buildCommentTag({
      id: 'c1', author: 'user', text: 'Fix this',
      created: '2026-01-01T00:00:00Z', anchorText: 'World',
    })
    expect(tag).toBe('<comment id="c1" author="user" text="Fix this" created="2026-01-01T00:00:00Z">World</comment>')
  })

  it('builds a comment with replies', () => {
    const tag = buildCommentTag({
      id: 'c1', author: 'user', text: 'Fix', anchorText: 'Hello',
      replies: [
        { id: 'r1', author: 'ai', text: 'Done', ts: '2026-01-02T00:00:00Z' },
      ],
    })
    expect(tag).toContain('Hello')
    expect(tag).toContain('<reply id="r1" author="ai" text="Done" ts="2026-01-02T00:00:00Z"/>')
    expect(tag).toMatch(/Hello<reply.*\/><\/comment>$/)
  })

  it('escapes special characters in attributes', () => {
    const tag = buildCommentTag({
      id: 'c1', author: 'user', text: '"quotes" & <tags>', anchorText: 'X',
    })
    expect(tag).toContain('text="&quot;quotes&quot; &amp; &lt;tags&gt;"')
  })

  it('omits created attribute when not provided', () => {
    const tag = buildCommentTag({
      id: 'c1', author: 'user', text: 'Fix', anchorText: 'X',
    })
    expect(tag).not.toContain('created=')
  })
})

describe('cleanToRawPos / offsetMap', () => {
  it('maps clean positions to raw positions for a single comment', () => {
    const text = 'AB<comment id="c1" author="user" text="t">CD</comment>EF'
    const { offsetMap, cleanText } = parseCommentTags(text)
    expect(cleanText).toBe('ABCDEF')

    expect(cleanToRawPos(offsetMap, 0)).toBe(0)
    expect(cleanToRawPos(offsetMap, 1)).toBe(1)
    expect(cleanToRawPos(offsetMap, 2)).toBe(text.indexOf('CD'))
    expect(cleanToRawPos(offsetMap, 4)).toBe(text.indexOf('EF'))
    expect(cleanToRawPos(offsetMap, 6)).toBe(text.length)
  })

  it('maps correctly with multiple comments', () => {
    const text = '<comment id="c1" author="user" text="a">AA</comment>BB<comment id="c2" author="user" text="b">CC</comment>DD'
    const { offsetMap, cleanText } = parseCommentTags(text)
    expect(cleanText).toBe('AABBCCDD')

    expect(cleanToRawPos(offsetMap, 0)).toBe(text.indexOf('AA'))
    expect(cleanToRawPos(offsetMap, 2)).toBe(text.indexOf('BB'))
    expect(cleanToRawPos(offsetMap, 4)).toBe(text.indexOf('CC'))
    expect(cleanToRawPos(offsetMap, 6)).toBe(text.indexOf('DD'))
  })

  it('handles text with no comments', () => {
    const text = 'Hello World'
    const { offsetMap } = parseCommentTags(text)
    expect(cleanToRawPos(offsetMap, 0)).toBe(0)
    expect(cleanToRawPos(offsetMap, 5)).toBe(5)
    expect(cleanToRawPos(offsetMap, 11)).toBe(11)
  })

  it('maps correctly with replies present', () => {
    const text = 'A<comment id="c1" author="user" text="t">B<reply id="r1" author="ai" text="x"/></comment>C'
    const { offsetMap, cleanText } = parseCommentTags(text)
    expect(cleanText).toBe('ABC')
    expect(cleanToRawPos(offsetMap, 2)).toBe(text.indexOf('C'))
  })
})

describe('escapeAttr / unescapeAttr roundtrip', () => {
  it('roundtrips special characters', () => {
    const original = '"quotes" & <tags> are \'fun\''
    expect(unescapeAttr(escapeAttr(original))).toBe(original)
  })

  it('handles empty strings', () => {
    expect(escapeAttr('')).toBe('')
    expect(unescapeAttr('')).toBe('')
  })
})
