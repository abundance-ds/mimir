import { describe, it, expect } from 'vitest'
import { htmlToReadable } from './reader'

describe('htmlToReadable', () => {
  it('converts headings to markdown', () => {
    expect(htmlToReadable('<h1>Title</h1>', {})).toBe('# Title')
    expect(htmlToReadable('<h2>Sub</h2>', {})).toBe('## Sub')
    expect(htmlToReadable('<h3>Deep</h3>', {})).toBe('### Deep')
  })

  it('converts paragraphs to plain text with double newline', () => {
    const result = htmlToReadable('<p>First paragraph</p><p>Second paragraph</p>', {})
    expect(result).toContain('First paragraph')
    expect(result).toContain('Second paragraph')
    // Paragraphs get \n\n after them
    expect(result).toMatch(/First paragraph\n\nSecond paragraph/)
  })

  it('converts tables to pipe-separated format', () => {
    const html = '<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>'
    const result = htmlToReadable(html, {})
    expect(result).toContain('| A | B |')
    expect(result).toContain('| C | D |')
  })

  it('converts unordered lists to dashed items', () => {
    const html = '<ul><li>alpha</li><li>beta</li></ul>'
    const result = htmlToReadable(html, {})
    expect(result).toContain('- alpha')
    expect(result).toContain('- beta')
  })

  it('converts emphasis and strong', () => {
    // strong/em replacements run after block-level elements,
    // so they apply to inline content not consumed by <p>/<li>/etc.
    expect(htmlToReadable('<strong>bold</strong>', {})).toContain('**bold**')
    expect(htmlToReadable('<em>italic</em>', {})).toContain('*italic*')
    // Inside a heading, strip() removes inner tags but preserves text
    expect(htmlToReadable('<h1>A <strong>bold</strong> title</h1>', {})).toContain('# A bold title')
  })

  it('decodes HTML entities', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &nbsp;</p>'
    const result = htmlToReadable(html, {})
    expect(result).toContain('&')
    expect(result).toContain('<')
    expect(result).toContain('>')
    expect(result).toContain('"')
    // &nbsp; becomes a regular space
    expect(result).not.toContain('&nbsp;')
  })

  it('injects comment markers from commentMap', () => {
    const html = '<p>Some text<sup><a href="#comment-1" id="comment-ref-1">[1]</a></sup> continues.</p>'
    const commentMap = { '1': { author: 'Smith', text: 'Good point' } }
    const result = htmlToReadable(html, commentMap)
    expect(result).toContain('Comment #1 by Smith: "Good point"')
    expect(result).toMatch(/«\[Comment #1/)
    expect(result).toMatch(/\]»/)
  })

  it('strips trailing dl block', () => {
    const html = '<p>Main text</p><dl><dt>Comment 1</dt><dd>Some note</dd></dl>'
    const result = htmlToReadable(html, {})
    expect(result).toContain('Main text')
    expect(result).not.toContain('Comment 1')
    expect(result).not.toContain('Some note')
  })

  it('handles empty input', () => {
    expect(htmlToReadable('', {})).toBe('')
  })

  it('collapses excessive newlines to max 2', () => {
    const html = '<p>A</p><p></p><p></p><p></p><p>B</p>'
    const result = htmlToReadable(html, {})
    // Should not have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{3,}/)
    expect(result).toContain('A')
    expect(result).toContain('B')
  })
})
