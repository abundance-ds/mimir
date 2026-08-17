import { describe, it, expect } from 'vitest'
import { blockMarkerEnd, snapCommentAnchor } from './anchor.js'

describe('blockMarkerEnd', () => {
  it('measures heading, list, task, quote, and ordered markers', () => {
    expect(blockMarkerEnd('# Title')).toBe(2)
    expect(blockMarkerEnd('### Deep')).toBe(4)
    expect(blockMarkerEnd('- item')).toBe(2)
    expect(blockMarkerEnd('* item')).toBe(2)
    expect(blockMarkerEnd('12. item')).toBe(4)
    expect(blockMarkerEnd('- [ ] task')).toBe(6)
    expect(blockMarkerEnd('> quoted')).toBe(2)
    expect(blockMarkerEnd('> - nested')).toBe(4)
    expect(blockMarkerEnd('  - indented')).toBe(4)
  })

  it('leaves plain text and non-markers alone', () => {
    expect(blockMarkerEnd('plain text')).toBe(0)
    expect(blockMarkerEnd('#nospace')).toBe(0)
    expect(blockMarkerEnd('-dash-word')).toBe(0)
  })
})

describe('snapCommentAnchor', () => {
  it('moves an anchor start past a heading marker', () => {
    const doc = '# Title\n\nBody text.'
    expect(snapCommentAnchor(doc, 0, 7)).toEqual({ from: 2, to: 7 })
  })

  it('moves an anchor start past a list marker', () => {
    const doc = '- alpha\n- beta'
    expect(snapCommentAnchor(doc, 0, 7)).toEqual({ from: 2, to: 7 })
  })

  it('keeps an anchor that already starts at content', () => {
    const doc = '- alpha\n- beta'
    expect(snapCommentAnchor(doc, 2, 7)).toEqual({ from: 2, to: 7 })
  })

  it('pulls a trailing selected newline back to the previous line end', () => {
    const doc = '# Title\nBody'
    expect(snapCommentAnchor(doc, 0, 8)).toEqual({ from: 2, to: 7 })
  })

  it('pulls an end inside the next line marker back to the previous line end', () => {
    const doc = '- alpha\n- beta'
    expect(snapCommentAnchor(doc, 2, 9)).toEqual({ from: 2, to: 7 })
  })

  it('keeps interior lines of a multi-line anchor untouched', () => {
    const doc = '- alpha\n- beta\n- gamma'
    expect(snapCommentAnchor(doc, 0, 14)).toEqual({ from: 2, to: 14 })
  })

  it('returns null when the selection covers only markers', () => {
    const doc = '- alpha'
    expect(snapCommentAnchor(doc, 0, 2)).toBeNull()
  })

  it('returns null for an empty selection', () => {
    expect(snapCommentAnchor('text', 2, 2)).toBeNull()
  })

  it('skips a marker-only line when retreating the end', () => {
    const doc = '- alpha\n- \n- beta'
    expect(snapCommentAnchor(doc, 0, 10)).toEqual({ from: 2, to: 7 })
  })

  it('clamps out-of-range positions', () => {
    const doc = 'text'
    expect(snapCommentAnchor(doc, -5, 99)).toEqual({ from: 0, to: 4 })
  })

  it('snaps correctly when the raw text already contains comment tags', () => {
    const doc = '- <comment id="x" author="user" text="" status="active" created="t">alpha</comment>\n- beta'
    const from = doc.indexOf('\n') + 1
    const to = doc.length
    // The second line's marker is still `- `; the existing tag on the first
    // line must not disturb the snap.
    expect(snapCommentAnchor(doc, from, to)).toEqual({ from: from + 2, to })
  })
})
