import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../codemirror/comments.js', () => ({
  getCommentsFromState: vi.fn(() => []),
  commentMutation: { of: (v) => ({ type: 'commentMutation', value: v }) },
}))

import { useCommentMutations } from './useCommentMutations.js'
import { getCommentsFromState } from '../codemirror/comments.js'

function makeView(docText) {
  const dispatched = []
  return {
    state: { doc: { toString: () => docText, length: docText.length } },
    dispatch(tx) { dispatched.push(tx) },
    dispatched,
  }
}

function setup(docText) {
  const view = makeView(docText)
  const editorSurfaceRef = ref({ getView: () => view })
  const mutations = useCommentMutations(editorSurfaceRef)
  return { view, mutations }
}

describe('useCommentMutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getCommentsFromState.mockReset()
    getCommentsFromState.mockReturnValue([])
  })

  describe('updateText', () => {
    it('rewrites the text attribute of a comment tag', () => {
      const doc = '<comment id="c1" author="user" text="">World</comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.updateText('c1', 'Fix this')

      expect(result.ok).toBe(true)
      expect(view.dispatched).toHaveLength(1)
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(next).toContain('text="Fix this"')
    })

    it('keeps special characters escaped in comment text', () => {
      const doc = '<comment id="c1" author="user" text="">X</comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.updateText('c1', '"quotes" & <tags>')

      expect(result.ok).toBe(true)
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(next).toContain('text="&quot;quotes&quot; &amp; &lt;tags&gt;"')
    })

    it('returns a failure when the comment id is not found', () => {
      const doc = '<comment id="c1" author="user" text="">X</comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.updateText('c2', 'Nope')

      expect(result.ok).toBe(false)
      expect(view.dispatched).toHaveLength(0)
    })
  })

  describe('addReply', () => {
    it('inserts a reply before the closing comment tag', () => {
      const doc = '<comment id="c1" author="user" text="Fix">World</comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.addReply('c1', 'Done')

      expect(result.ok).toBe(true)
      expect(result.replyId).toMatch(/^[a-z0-9]{3}$/)
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(next).toContain('World<reply')
      expect(next).toContain('text="Done"')
      expect(next).toContain('</comment>')
    })

    it('does not insert an empty reply', () => {
      const doc = '<comment id="c1" author="user" text="Fix">World</comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.addReply('c1', '   ')

      expect(result.ok).toBe(false)
      expect(view.dispatched).toHaveLength(0)
    })
  })

  describe('updateReply', () => {
    it('rewrites the text attribute of a reply tag', () => {
      const doc = 'Hello <comment id="c1" author="user" text="Fix">World<reply id="r1" author="ai" text="Old reply" ts="2026-01-01"/></comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.updateReply('c1', 'r1', 'New reply')

      expect(result.ok).toBe(true)
      expect(view.dispatched).toHaveLength(1)
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(next).toContain('text="New reply"')
      expect(next).not.toContain('text="Old reply"')
    })

    it('escapes special characters in new text', () => {
      const doc = '<comment id="c1" author="user" text="Fix">X<reply id="r1" author="ai" text="old" ts="t"/></comment>'
      const { view, mutations } = setup(doc)

      mutations.updateReply('c1', 'r1', '"quotes" & <tags>')

      const change = view.dispatched[0].changes
      const result = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(result).toContain('text="&quot;quotes&quot; &amp; &lt;tags&gt;"')
    })

    it('does nothing if reply id not found', () => {
      const doc = '<comment id="c1" author="user" text="Fix">X<reply id="r1" author="ai" text="old"/></comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.updateReply('c1', 'r-nonexistent', 'New')

      expect(result.ok).toBe(false)
      expect(view.dispatched).toHaveLength(0)
    })
  })

  describe('deleteReply', () => {
    it('removes a reply tag from the document', () => {
      const doc = '<comment id="c1" author="user" text="Fix">World<reply id="r1" author="ai" text="Done" ts="2026-01-01"/></comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.deleteReply('c1', 'r1')

      expect(result.ok).toBe(true)
      expect(view.dispatched).toHaveLength(1)
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(next).not.toContain('<reply')
      expect(next).toContain('World</comment>')
    })

    it('removes only the targeted reply when multiple exist', () => {
      const doc = '<comment id="c1" author="user" text="Fix">X<reply id="r1" author="ai" text="First"/><reply id="r2" author="user" text="Second"/></comment>'
      const { view, mutations } = setup(doc)

      mutations.deleteReply('c1', 'r1')

      const change = view.dispatched[0].changes
      const result = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      expect(result).not.toContain('id="r1"')
      expect(result).toContain('id="r2"')
      expect(result).toContain('text="Second"')
    })

    it('does nothing if reply id not found', () => {
      const doc = '<comment id="c1" author="user" text="Fix">X<reply id="r1" author="ai" text="Done"/></comment>'
      const { view, mutations } = setup(doc)

      const result = mutations.deleteReply('c1', 'r-nonexistent')

      expect(result.ok).toBe(false)
      expect(view.dispatched).toHaveLength(0)
    })
  })

  describe('delete', () => {
    it('unwraps a comment and keeps the anchor text', () => {
      const doc = '<comment id="c1" author="user" text="Fix">World</comment>'
      const { view, mutations } = setup(doc)
      getCommentsFromState.mockReturnValue([
        { id: 'c1', tagFrom: 0, tagTo: doc.length, anchorText: 'World' },
      ])

      const result = mutations.delete('c1')

      expect(result.ok).toBe(true)
      expect(view.dispatched[0].changes).toEqual({ from: 0, to: doc.length, insert: 'World' })
    })
  })

  describe('resolve and reopen', () => {
    it('adds resolved status without removing the canonical wrapper', () => {
      const doc = '<comment id="c1" author="user" text="Fix">World</comment>'
      const { view, mutations } = setup(doc)
      const result = mutations.resolve('c1')
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)

      expect(result).toEqual({ ok: true, status: 'resolved' })
      expect(next).toContain('status="resolved"')
      expect(next).toContain('>World</comment>')
    })

    it('reopens by replacing only the status attribute', () => {
      const doc = '<comment id="c1" author="user" text="Fix" status="resolved">World</comment>'
      const { view, mutations } = setup(doc)
      const result = mutations.reopen('c1')
      const change = view.dispatched[0].changes
      const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)

      expect(result).toEqual({ ok: true, status: 'active' })
      expect(next).toContain('status="active"')
      expect(next).not.toContain('status="resolved"')
    })
  })

  describe('clearAll', () => {
    it('strips comment wrappers and replies from the document', () => {
      const doc = 'A<comment id="c1" author="user" text="Fix">B<reply id="r1" author="ai" text="Done"/></comment>C'
      const { view, mutations } = setup(doc)

      const result = mutations.clearAll()

      expect(result).toEqual({ ok: true, changed: true })
      expect(view.dispatched[0].changes).toEqual({ from: 0, to: doc.length, insert: 'ABC' })
    })

    it('reports unchanged when no comments exist', () => {
      const doc = 'Plain text'
      const { view, mutations } = setup(doc)

      const result = mutations.clearAll()

      expect(result).toEqual({ ok: true, changed: false })
      expect(view.dispatched).toHaveLength(0)
    })
  })
})
