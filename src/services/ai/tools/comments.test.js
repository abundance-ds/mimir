import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmit = vi.fn()
const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args) => mockEmit(...args),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => mockInvoke(...args),
}))

vi.mock('./helpers.js', () => ({
  readDocument: vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    title: 'Test Doc',
    path: '/project/test.md',
    content: 'Hello world, this is a test document with some content.',
  }),
}))

import { createCommentAddTool } from './commentAdd'
import { createCommentReplyTool } from './commentReply'

const context = {
  sessionId: 'sess-1',
  approvalMode: 'bypass',
  policy: {},
  projectPath: '/project',
  getDocument: () => ({
    content: 'Hello world, this is a test document with some content.',
    path: '/project/test.md',
  }),
}

describe('comment_add tool', () => {
  beforeEach(() => {
    mockEmit.mockReset()
    mockInvoke.mockReset().mockResolvedValue()
  })

  it('creates inline comment tag and writes to file', async () => {
    const { comment_add } = createCommentAddTool(context)
    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'test document',
      text: 'This needs revision',
    })

    expect(result.status).toBe('created')
    expect(result.comment_id).toMatch(/^[a-z0-9]{4}$/)
    expect(result.anchor).toBe('test document')

    expect(mockInvoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/project/test.md',
    }))
    const written = mockInvoke.mock.calls.find(c => c[0] === 'write_text_file')[1].content
    expect(written).toContain('<comment')
    expect(written).toContain('text="This needs revision"')
    expect(written).toContain('>test document</comment>')

    expect(mockEmit).toHaveBeenCalledWith('mimir://file-updated', {
      path: '/project/test.md',
      content: written,
    })
  })

  it('returns error when anchor_text not found', async () => {
    const { comment_add } = createCommentAddTool(context)
    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'nonexistent text passage',
      text: 'Comment',
    })

    expect(result.error).toMatch(/Could not find anchor_text/)
  })

  it('updates the live editor without silently saving its dirty document', async () => {
    const setDocument = vi.fn()
    const { comment_add } = createCommentAddTool({
      ...context,
      setDocument,
      getDocument: () => ({ content: 'Unsaved draft text.', path: null }),
    })
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'draft', title: 'Untitled', path: null, content: 'Unsaved draft text.',
    })

    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'draft',
      text: 'Keep working here',
    })

    expect(result.status).toBe('created')
    expect(setDocument).toHaveBeenCalledWith(expect.stringContaining('>draft</comment>'))
    expect(mockInvoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
  })

  it('rejects an ambiguous anchor instead of commenting the first accidental match', async () => {
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: 'repeated passage, then repeated passage.',
    })

    const { comment_add } = createCommentAddTool(context)
    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'repeated passage',
      text: 'Which one?',
    })

    expect(result.error).toMatch(/more than one/)
    expect(mockInvoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
  })

  it('searches in clean text, ignoring existing comment tags', async () => {
    const docWithComments = 'Hello <comment id="c1" author="user" text="old">world</comment>, this is a test.'
    const ctxWithTags = {
      ...context,
      getDocument: () => ({ content: docWithComments, path: '/project/test.md' }),
    }
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: docWithComments,
    })

    const { comment_add } = createCommentAddTool(ctxWithTags)
    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'this is a test',
      text: 'New comment',
    })

    expect(result.status).toBe('created')
    const written = mockInvoke.mock.calls.find(c => c[0] === 'write_text_file')[1].content
    expect(written).toContain('>this is a test</comment>')
    expect(written).toContain('<comment id="c1"')
  })

  it('rejects anchor that overlaps an existing comment', async () => {
    const docWithComments = 'Hello <comment id="c1" author="user" text="old">world</comment> here.'
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: docWithComments,
    })

    const { comment_add } = createCommentAddTool(context)
    const result = await comment_add.execute({
      target: '@editor',
      anchor_text: 'Hello world here',
      text: 'Wrapping everything',
    })

    expect(result.error).toMatch(/overlaps/)
  })

  it('reads from disk when target is a file path', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'read_text_file') return { content: 'File content on disk.' }
    })

    const { comment_add } = createCommentAddTool(context)
    const result = await comment_add.execute({
      target: '/project/other/file.md',
      anchor_text: 'on disk',
      text: 'Note',
    })

    expect(result.status).toBe('created')
    expect(mockInvoke).toHaveBeenCalledWith('read_text_file', { path: '/project/other/file.md' })
    expect(mockInvoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/project/other/file.md',
    }))
  })
})

describe('comment_reply tool', () => {
  beforeEach(() => {
    mockEmit.mockReset()
    mockInvoke.mockReset().mockResolvedValue()
  })

  it('inserts reply tag into existing comment', async () => {
    const docWithComment = 'Hello <comment id="c-abc" author="user" text="Fix">world</comment> here.'
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: docWithComment,
    })

    const { comment_reply } = createCommentReplyTool(context)
    const result = await comment_reply.execute({
      target: '@editor',
      comment_id: 'c-abc',
      text: 'Good point, will fix',
    })

    expect(result.status).toBe('replied')
    expect(result.comment_id).toBe('c-abc')
    expect(result.reply_id).toMatch(/^[a-z0-9]{3}$/)

    const written = mockInvoke.mock.calls.find(c => c[0] === 'write_text_file')[1].content
    expect(written).toContain('<reply')
    expect(written).toContain('text="Good point, will fix"')
    expect(written).toContain('author="ai"')
    expect(written).toMatch(/<reply[^/]*\/><\/comment>/)
  })

  it('returns error for nonexistent comment_id', async () => {
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: 'No comments here.',
    })

    const { comment_reply } = createCommentReplyTool(context)
    const result = await comment_reply.execute({
      target: '@editor',
      comment_id: 'c-missing',
      text: 'Reply',
    })

    expect(result.error).toMatch(/not found/)
  })

  it('replies in the live editor without writing through dirty state to disk', async () => {
    const doc = 'A <comment id="c-live" author="user" text="Review">B</comment> C'
    const setDocument = vi.fn()
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'draft', title: 'Untitled', path: null, content: doc,
    })

    const { comment_reply } = createCommentReplyTool({ ...context, setDocument })
    const result = await comment_reply.execute({
      target: '@editor',
      comment_id: 'c-live',
      text: 'Handled',
    })

    expect(result.status).toBe('replied')
    expect(setDocument).toHaveBeenCalledWith(expect.stringContaining('text="Handled"'))
    expect(mockInvoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
  })

  it('reads from disk when target is a file path', async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'read_text_file')
        return { content: 'A <comment id="c-xyz" author="user" text="Note">B</comment> C' }
    })

    const { comment_reply } = createCommentReplyTool(context)
    const result = await comment_reply.execute({
      target: '/project/other/file.md',
      comment_id: 'c-xyz',
      text: 'Reply on direct path',
    })

    expect(result.status).toBe('replied')
    expect(mockInvoke).toHaveBeenCalledWith('read_text_file', { path: '/project/other/file.md' })
    expect(mockInvoke).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/project/other/file.md',
    }))
  })

  it('appends reply after existing replies', async () => {
    const doc = 'A <comment id="c-abc" author="user" text="Fix">B<reply id="r-1" author="ai" text="Done" ts="2026-01-01"/></comment> C'
    const { readDocument } = await import('./helpers.js')
    readDocument.mockResolvedValueOnce({
      documentId: 'doc-1', title: 'Test', path: '/project/test.md',
      content: doc,
    })

    const { comment_reply } = createCommentReplyTool(context)
    const result = await comment_reply.execute({
      target: '@editor',
      comment_id: 'c-abc',
      text: 'Second reply',
    })

    expect(result.status).toBe('replied')
    const written = mockInvoke.mock.calls.find(c => c[0] === 'write_text_file')[1].content
    expect(written).toContain('text="Done"')
    expect(written).toContain('text="Second reply"')
    expect(written).toMatch(/text="Done"[^/]*\/><reply[^/]*text="Second reply"[^/]*\/><\/comment>/)
  })
})
