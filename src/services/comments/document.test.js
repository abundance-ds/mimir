import { describe, expect, it } from 'vitest'
import { readCommentDocument, replaceCommentText, rewriteCommentDocument } from './document.js'
import { parseCommentTags, stripCommentTags } from './parser.js'

const tag = '<comment id="a" author="user" text="Check">the claim<reply id="r" author="ai" text="See https://example.com/spec"/></comment>'

describe('comment-aware text changes', () => {
  it('reads URLs and paths in replies without losing discussion text', () => {
    expect(readCommentDocument(tag).threads[0].replies[0].text).toBe('See https://example.com/spec')
  })

  it('preserves complete threads when a replacement crosses the closing tag', () => {
    const source = `Intro ${tag} and context.`
    const result = replaceCommentText(source, source.indexOf('the claim'), source.length, 'a new passage.')
    expect(stripCommentTags(result)).toBe('Intro a new passage.')
    expect(parseCommentTags(result).comments).toHaveLength(1)
    expect(parseCommentTags(result).comments[0]).toMatchObject({ detached: 'removed', quote: 'the claim', anchorText: '', replies: [{ id: 'r' }] })
  })

  it('preserves exact tag spelling for unrelated edits and does not rewrite reads', () => {
    const source = `Intro ${tag} after.`
    expect(rewriteCommentDocument(source, 'Intro the claim after.')).toBe(source)
    expect(rewriteCommentDocument(source, 'New intro the claim after.')).toBe(`New intro ${tag} after.`)
  })

  it('keeps removed discussions in the saved file without adding prose', () => {
    const result = rewriteCommentDocument(`Before ${tag} after.`, 'Before after.')
    expect(stripCommentTags(result)).toBe('Before after.')
    const reread = readCommentDocument(result)
    expect(reread.threads[0]).toMatchObject({ detached: 'removed', quote: 'the claim' })
    expect(rewriteCommentDocument(result, 'Edited again.')).toContain('quote="the claim"')
  })

  it('stores a detached discussion outside the final code fence and removes only its owned separator', () => {
    const source = `Before ${tag}`
    const prose = '```js\r\nconst value = 1\r\n```'
    const result = rewriteCommentDocument(source, prose)
    expect(result).toContain('```\n\n<comment')
    expect(stripCommentTags(result)).toBe(prose)
    expect(stripCommentTags(result.replace(/(?<!\r)\n/g, '\r\n'))).toBe(prose)
  })
})
