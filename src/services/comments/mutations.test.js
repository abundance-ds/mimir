import { describe, expect, it } from 'vitest'
import { documentComments, mutateComment } from './mutations.js'
import { stripCommentTags } from './parser.js'

describe('agent comment transformations', () => {
  it.each(['# Heading', '- Item', '> Quote', '- [ ] Task'])('retains the Markdown structure of %s', content => {
    const changed = mutateComment(content, 'add', { anchor_text: content, text: 'Check "this" & <that>.' })
    expect(stripCommentTags(changed.content)).toBe(content)
    expect(changed.content.startsWith('<comment')).toBe(false)
    expect(documentComments(changed.content)[0].text).toBe('Check "this" & <that>.')
  })

  it('requires a unique anchor and refuses overlap or marker-only anchors', () => {
    expect(() => mutateComment('Same. Same.', 'add', { anchor_text: 'Same', text: 'Check' })).toThrow('more than one')
    expect(() => mutateComment('# Title', 'add', { anchor_text: '# ', text: 'Check' })).toThrow('Markdown structure')
    const first = mutateComment('Text here', 'add', { anchor_text: 'Text', text: 'First' })
    expect(() => mutateComment(first.content, 'add', { anchor_text: 'Text here', text: 'Second' })).toThrow('overlaps')
  })

  it.each(['\n', '\r\n', '\r'])('lists positions and retains text and replies across resolve/reopen/delete with %j', newline => {
    const original = `Start${newline}Passage${newline}End`
    const added = mutateComment(original, 'add', { anchor_text: 'Passage', text: 'First' })
    const input = { comment_id: added.result.comment_id, text: 'Reply with "quotes" & <brackets>' }
    const reply = mutateComment(added.content, 'reply', input)
    const resolved = mutateComment(reply.content, 'resolve', input)
    expect(documentComments(resolved.content)[0]).toMatchObject({ status: 'resolved', line: 2, replies: [{ text: input.text }] })
    const reopened = mutateComment(resolved.content, 'reopen', input)
    expect(documentComments(reopened.content)[0].status).toBe('active')
    expect(mutateComment(reopened.content, 'delete', input).content).toBe(original)
  })
})
