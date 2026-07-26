import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import {
  createReadOnlyView,
  createSplitDiffView,
  createUnifiedDiffView,
  getSplitChunks,
  getUnifiedChunks,
} from './merge.js'

const disposables = []

afterEach(() => {
  while (disposables.length) disposables.pop().destroy()
  vi.useRealTimers()
})

describe('CodeMirror diff views', () => {
  it('creates a unified diff and reports resolution when edits match the original', async () => {
    vi.useFakeTimers()
    const onAllResolved = vi.fn()
    const onChunkCountChange = vi.fn()
    const view = createUnifiedDiffView({
      parent: document.createElement('div'),
      originalContent: 'before\nsame',
      modifiedContent: 'after\nsame',
      onAllResolved,
      onChunkCountChange,
    })
    disposables.push(view)

    expect(getUnifiedChunks(view).length).toBeGreaterThan(0)
    expect(onChunkCountChange).toHaveBeenCalledWith(expect.any(Number))
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: 'before\nsame',
      },
    })
    await vi.runAllTimersAsync()

    expect(getUnifiedChunks(view)).toHaveLength(0)
    expect(onAllResolved).toHaveBeenCalledTimes(1)
  })

  it('keeps split diff sides independent and exposes unresolved chunks', () => {
    const merge = createSplitDiffView({
      parent: document.createElement('div'),
      originalContent: 'alpha\nshared',
      modifiedContent: 'beta\nshared',
    })
    disposables.push(merge)

    expect(merge.a.state.doc.toString()).toBe('alpha\nshared')
    expect(merge.b.state.doc.toString()).toBe('beta\nshared')
    expect(getSplitChunks(merge).length).toBeGreaterThan(0)
  })

  it('creates a non-editable review surface without changing content', () => {
    const view = createReadOnlyView({
      parent: document.createElement('div'),
      content: '# Review\n\nRead only.',
    })
    disposables.push(view)

    expect(view.state.doc.toString()).toBe('# Review\n\nRead only.')
    expect(view.state.facet(EditorView.editable)).toBe(false)
  })
})
